// Read-only views over plaid-warehouse (the live `finance` DB on josh-db):
// Stripe (balance ledger, charges, payouts) and Wealthsimple (Plaid-linked
// accounts plus the `manual` schema for accounts Plaid never saw, like the FHSA).
// Connects as `workbench_ro` (scripts/warehouse-setup.mjs): SELECT only, every
// session read-only, Plaid access tokens unreadable. Optional: without
// WAREHOUSE_DATABASE_URL the sandbox workbench runs exactly as before.
import pg from 'pg';
import { excessByMonth } from './fhsa.js';

const url = process.env.WAREHOUSE_DATABASE_URL;
const wh = url ? new pg.Pool({ connectionString: url, max: 4, application_name: 'finance-workbench' }) : null;
if (wh) wh.on('error', error => console.error(`warehouse pool: ${error.message}`));

// Dollars as strings from Postgres; keep them that way and let the client format.
const rows = async (sql, params = []) => (await wh.query(sql, params)).rows;
const WS = "a.institution_name ILIKE 'wealthsimple%'";
const HST_SHARE = 13 / 113; // HST-included Ontario sales → tax portion

function needWarehouse(_req, res, next) {
  if (!wh) return res.status(503).json({ error: 'Warehouse not connected. Run scripts/warehouse-setup.mjs (see README).' });
  next();
}

export function mountWarehouse(app, route) {
  app.get('/api/warehouse/status', route(async (_req, res) => {
    if (!wh) return res.json({ configured: false });
    const [health] = await rows(`SELECT max(last_synced_at) AS plaid_synced,
      (SELECT max(finished_at) FROM stripe.sync_runs WHERE status = 'ok') AS stripe_synced FROM marts.item_health`);
    res.json({ configured: true, ...health });
  }));

  app.get('/api/stripe', needWarehouse, route(async (_req, res) => {
    const [ytd, last12, monthly, balance, charges, payouts] = await Promise.all([
      rows(`SELECT coalesce(sum(gross_sales),0) AS gross, coalesce(sum(refunds + disputes),0) AS refunds,
              coalesce(sum(fees),0) AS fees, coalesce(sum(charge_count),0)::int AS charges
            FROM marts.stripe_monthly WHERE livemode AND month >= date_trunc('year', current_date)`),
      rows(`SELECT coalesce(sum(gross_sales),0) AS gross, coalesce(sum(fees),0) AS fees
            FROM marts.stripe_monthly WHERE livemode AND month >= date_trunc('month', current_date) - interval '11 months'`),
      rows(`SELECT to_char(month, 'YYYY-MM') AS month, currency, gross_sales, refunds, disputes, fees, net_revenue,
              paid_out, charge_count::int FROM marts.stripe_monthly
            WHERE livemode AND month >= date_trunc('month', current_date) - interval '23 months' ORDER BY month DESC`),
      rows(`SELECT DISTINCT ON (b.account_label, b.currency) b.account_label, b.currency, b.available, b.pending,
              b.snapshot_date::text AS as_of
            FROM stripe.balance_snapshots b JOIN stripe.accounts a ON a.label = b.account_label
            WHERE a.livemode ORDER BY b.account_label, b.currency, b.snapshot_date DESC, b.captured_at DESC`),
      rows(`SELECT c.id, c.local_date::text AS date, c.amount, c.amount_refunded, c.currency, c.status, c.description,
              c.customer_name, c.payment_method_type, c.refunded, c.disputed
            FROM stripe.charges c JOIN stripe.accounts a ON a.label = c.account_label
            WHERE a.livemode ORDER BY c.created DESC LIMIT 50`),
      rows(`SELECT p.id, p.arrival_date::text AS arrival_date, p.amount, p.currency, p.status,
              p.bank_date::text AS bank_date, p.bank_account
            FROM marts.stripe_payouts p JOIN stripe.accounts a ON a.label = p.account_label
            WHERE a.livemode AND p.amount <> 0 ORDER BY p.created DESC LIMIT 20`),
    ]);
    const y = ytd[0];
    res.json({
      ytd: { ...y, net: (Number(y.gross) - Number(y.refunds) - Number(y.fees)).toFixed(2),
        hstIncluded: ((Number(y.gross) - Number(y.refunds)) * HST_SHARE).toFixed(2) },
      last12: last12[0], monthly, balance, charges, payouts,
    });
  }));

  app.get('/api/wealthsimple', needWarehouse, route(async (_req, res) => {
    const [accounts, manualAccounts, holdings, activity, manualActivity, deposits, history] = await Promise.all([
      rows(`SELECT a.account_id AS id, a.account_label AS name, a.subtype, a.mask, b.current_balance AS balance,
              b.snapshot_date::text AS as_of, m.current_balance AS balance_30d
            FROM marts.dim_accounts a
            LEFT JOIN LATERAL (SELECT current_balance, snapshot_date FROM plaid.balance_snapshots s
              WHERE s.account_id = a.account_id ORDER BY snapshot_date DESC, captured_at DESC LIMIT 1) b ON true
            LEFT JOIN LATERAL (SELECT current_balance FROM plaid.balance_snapshots s
              WHERE s.account_id = a.account_id AND snapshot_date <= current_date - 30
              ORDER BY snapshot_date DESC LIMIT 1) m ON true
            WHERE ${WS} AND a.is_active ORDER BY b.current_balance DESC NULLS LAST`),
      rows(`SELECT a.account_key AS id, a.name, a.subtype, a.owner, a.opened_on::text, a.closed_on::text, a.note,
              s.market_value AS last_value, s.snapshot_date::text AS last_value_date,
              coalesce(sum(t.amount) FILTER (WHERE t.type = 'contribution'), 0) AS contributed,
              coalesce(-sum(t.amount) FILTER (WHERE t.type LIKE 'withdrawal%'), 0) AS withdrawn
            FROM manual.accounts a
            LEFT JOIN LATERAL (SELECT market_value, snapshot_date FROM manual.balance_snapshots b
              WHERE b.account_key = a.account_key ORDER BY snapshot_date DESC LIMIT 1) s ON true
            LEFT JOIN manual.investment_transactions t USING (account_key)
            WHERE a.institution ILIKE 'wealthsimple%'
            GROUP BY a.account_key, s.market_value, s.snapshot_date ORDER BY a.opened_on`),
      rows(`SELECT h.account_label AS account, h.ticker_symbol AS ticker, h.security_name AS name, h.security_type AS type,
              h.quantity, h.institution_price AS price, h.institution_value AS value, h.cost_basis, h.unrealized_gain, h.currency
            FROM marts.holdings_latest h WHERE h.institution_name ILIKE 'wealthsimple%' ORDER BY h.institution_value DESC`),
      // Plaid investment amounts are + when cash leaves the account; flip to + = into the account.
      rows(`SELECT t.date::text AS date, a.name AS account, a.subtype AS account_type, t.type, t.subtype, t.name,
              -t.amount AS cash, t.quantity, t.price
            FROM plaid.investment_transactions t JOIN plaid.accounts a USING (account_id)
            JOIN marts.dim_accounts d USING (account_id)
            WHERE d.institution_name ILIKE 'wealthsimple%' ORDER BY t.date DESC, t.investment_transaction_id LIMIT 150`),
      rows(`SELECT t.date::text AS date, a.name AS account, a.subtype AS account_type, t.type, t.security, t.description,
              t.amount AS cash, t.source_doc
            FROM manual.investment_transactions t JOIN manual.accounts a USING (account_key)
            WHERE a.institution ILIKE 'wealthsimple%' ORDER BY t.date DESC, t.id DESC`),
      // Money put into each registered account per calendar year (TFSA/RRSP from Plaid, FHSA from manual).
      rows(`SELECT extract(year FROM t.date)::int AS year, a.subtype AS account_type,
              sum(-t.amount) AS deposited, count(*)::int AS deposits
            FROM plaid.investment_transactions t JOIN plaid.accounts a USING (account_id)
            JOIN marts.dim_accounts d USING (account_id)
            WHERE d.institution_name ILIKE 'wealthsimple%' AND a.subtype IN ('rrsp', 'tfsa', 'fhsa')
              AND t.type = 'cash' AND t.subtype IN ('deposit', 'contribution') AND t.name NOT ILIKE '%stock lending%'
            GROUP BY 1, 2
            UNION ALL
            SELECT extract(year FROM t.date)::int, a.subtype, sum(t.amount), count(*)::int
            FROM manual.investment_transactions t JOIN manual.accounts a USING (account_key)
            WHERE a.institution ILIKE 'wealthsimple%' AND t.type = 'contribution'
            GROUP BY 1, 2
            ORDER BY 1 DESC, 2`),
      rows(`SELECT b.snapshot_date::text AS date, sum(b.current_balance) AS value
            FROM plaid.balance_snapshots b JOIN marts.dim_accounts a USING (account_id)
            WHERE ${WS} AND a.type = 'investment' AND b.snapshot_date >= current_date - 180
            GROUP BY 1 ORDER BY 1`),
    ]);
    res.json({ accounts, manualAccounts, holdings, activity, manualActivity, deposits, history,
      fhsa: await fhsaExcess() });
  }));
}

// For each manual FHSA with CRA room on file: monthly excess and 1% tax (RC728).
async function fhsaExcess() {
  const out = [];
  for (const acct of await rows(`SELECT account_key, name, owner FROM manual.accounts WHERE subtype = 'fhsa'`)) {
    const room = await rows(`SELECT tax_year, room::float AS room FROM manual.fhsa_room WHERE account_key = $1`, [acct.account_key]);
    if (!room.length) continue;
    const tx = await rows(`SELECT date::text AS date, type, amount::float AS amount, dated FROM manual.investment_transactions
      WHERE account_key = $1 AND type IN ('contribution', 'withdrawal_designated') ORDER BY date`, [acct.account_key]);
    if (!tx.length) continue;
    const events = tx.map(t => ({ date: t.date, dated: t.dated,
      kind: t.type === 'contribution' ? 'contribution' : 'designated', amount: Math.abs(t.amount) }));
    out.push({ account: acct.name, owner: acct.owner,
      ...excessByMonth({ events, roomByYear: Object.fromEntries(room.map(r => [r.tax_year, r.room])) }) });
  }
  return out;
}
