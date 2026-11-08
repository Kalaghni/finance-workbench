import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encrypt } from './crypto.js';
import { plaid } from './plaid.js';
import { syncConnection } from './sync.js';
import { importPurchase } from './receipts.js';
import { mountWarehouse } from './warehouse.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
// Designed for a single person on one computer. Keep the API bound to loopback.
app.use('/api', (req,res,next) => {
  const origin = req.get('origin');
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return res.status(403).json({ error: 'Local access only' });
  res.set('Cache-Control', 'no-store');
  next();
});

const route = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next);

// The local sandbox DB is optional when the warehouse is connected: without it,
// the sandbox routes answer 503 and the Stripe/Wealthsimple tabs still work.
let localReady = false;
app.use(['/api/plaid','/api/sync','/api/overview','/api/purchases'], (_req,res,next) =>
  localReady ? next() : res.status(503).json({ error: 'Local sandbox database unavailable (check DATABASE_URL).' }));

app.get('/api/health', route(async (_req,res) => {
  if (localReady) await db.query('SELECT 1');
  res.json({ ok: true, localReady, plaidConfigured: localReady && Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET), environment: process.env.PLAID_ENV || 'sandbox' });
}));

app.post('/api/plaid/link-token', route(async (_req,res) => {
  const data = await plaid('/link/token/create', {
    user: { client_user_id: 'personal-finance-owner' },
    client_name: 'Finance Workbench', products: ['transactions'],
    country_codes: ['CA'], language: 'en', transactions: { days_requested: 365 },
  });
  res.json({ linkToken: data.link_token });
}));

app.post('/api/plaid/exchange', route(async (req,res) => {
  const { publicToken, institutionName } = req.body;
  if (typeof publicToken !== 'string' || !publicToken.startsWith('public-')) return res.status(400).json({ error: 'Invalid public token' });
  const data = await plaid('/item/public_token/exchange', { public_token: publicToken });
  await db.query(`INSERT INTO connections(item_id,institution_name,access_token_ciphertext) VALUES($1,$2,$3)
    ON CONFLICT(item_id) DO UPDATE SET institution_name=EXCLUDED.institution_name,access_token_ciphertext=EXCLUDED.access_token_ciphertext`,
    [data.item_id, typeof institutionName === 'string' ? institutionName.slice(0,150) : 'Financial institution', encrypt(data.access_token)]);
  res.json({ itemId: data.item_id });
}));

app.post('/api/sync', route(async (_req,res) => {
  const { rows } = await db.query('SELECT * FROM connections ORDER BY created_at');
  const results = [];
  for (const connection of rows) {
    try { results.push({ institution: connection.institution_name, ...(await syncConnection(db,connection)) }); }
    catch(error) {
      await db.query("UPDATE connections SET status='error' WHERE item_id=$1", [connection.item_id]);
      results.push({ institution: connection.institution_name, error: error.code || error.message });
    }
  }
  res.json({ results });
}));

app.get('/api/overview', route(async (_req,res) => {
  const [connections,accounts,summary,categories,itemizedCategories,transactions,purchases] = await Promise.all([
    db.query('SELECT item_id,institution_name,status,last_synced_at FROM connections ORDER BY institution_name'),
    db.query('SELECT account_id,item_id,name,type,subtype,mask,currency,current_balance_cents,balance_observed_at FROM accounts ORDER BY name'),
    db.query(`SELECT coalesce(sum(amount_cents) FILTER(WHERE amount_cents > 0),0)::text AS spending,
      coalesce(-sum(amount_cents) FILTER(WHERE amount_cents < 0),0)::text AS income
      FROM transactions WHERE date >= current_date - 30 AND NOT pending AND currency='CAD' AND coalesce(category_primary,'') NOT LIKE 'TRANSFER_%'`),
    db.query(`SELECT coalesce(category_primary,'UNCATEGORIZED') AS category,sum(amount_cents)::text AS cents
      FROM transactions WHERE date >= current_date - 30 AND NOT pending AND currency='CAD' AND amount_cents>0 AND coalesce(category_primary,'') NOT LIKE 'TRANSFER_%'
      GROUP BY 1 ORDER BY sum(amount_cents) DESC LIMIT 10`),
    db.query(`SELECT coalesce(pi.category,'uncategorized') AS category,sum(pi.total_cents)::text AS cents
      FROM purchase_items pi JOIN purchases p ON p.id=pi.purchase_id
      JOIN purchase_matches pm ON pm.purchase_id=p.id AND pm.status='confirmed'
      WHERE p.purchased_at >= now() - interval '30 days' AND p.currency='CAD'
      GROUP BY 1 ORDER BY sum(pi.total_cents) DESC LIMIT 10`),
    db.query(`SELECT t.transaction_id,t.date::text AS date,t.name,t.merchant_name,t.amount_cents::text,t.currency,t.pending,t.category_primary,a.name AS account_name
      FROM transactions t JOIN accounts a USING(account_id) ORDER BY t.date DESC,t.transaction_id DESC LIMIT 100`),
    db.query(`SELECT p.id,p.source,p.merchant,p.purchased_at,p.total_cents::text,p.currency,count(pi.id)::int AS item_count,
      max(pm.status) AS match_status FROM purchases p LEFT JOIN purchase_items pi ON pi.purchase_id=p.id
      LEFT JOIN purchase_matches pm ON pm.purchase_id=p.id GROUP BY p.id ORDER BY p.purchased_at DESC LIMIT 30`),
  ]);
  res.json({ connections: connections.rows, accounts: accounts.rows, summary: summary.rows[0], categories: categories.rows, itemizedCategories: itemizedCategories.rows, transactions: transactions.rows, purchases: purchases.rows });
}));

app.post('/api/purchases', route(async (req,res) => res.status(201).json(await importPurchase(db,req.body))));
app.get('/api/purchases/:id', route(async (req,res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const [purchase,items,matches] = await Promise.all([
    db.query('SELECT * FROM purchases WHERE id=$1',[req.params.id]),
    db.query('SELECT line_key,description,sku,quantity,total_cents::text,category FROM purchase_items WHERE purchase_id=$1 ORDER BY id',[req.params.id]),
    db.query('SELECT transaction_id,confidence,status FROM purchase_matches WHERE purchase_id=$1',[req.params.id]),
  ]);
  if (!purchase.rowCount) return res.status(404).json({ error: 'Purchase not found' });
  res.json({ purchase:purchase.rows[0], items:items.rows, matches:matches.rows });
}));
app.post('/api/purchases/:id/confirm', route(async (req,res) => {
  if (!/^\d+$/.test(req.params.id) || typeof req.body.transactionId !== 'string') return res.status(400).json({ error: 'Invalid match' });
  const result = await db.query("UPDATE purchase_matches SET status='confirmed' WHERE purchase_id=$1 AND transaction_id=$2 RETURNING purchase_id",[req.params.id,req.body.transactionId]);
  res.status(result.rowCount ? 200 : 404).json(result.rowCount ? { ok:true } : { error:'Suggestion not found' });
}));

mountWarehouse(app, route);

app.use(express.static(join(root,'dist')));
app.get('/{*path}', (_req,res) => res.sendFile(join(root,'dist','index.html')));
app.use((error,_req,res,_next) => {
  console.error(error.code || error.message);
  res.status(error.status && error.status >= 400 && error.status < 500 ? error.status : 500)
    .json({ error: error.code || (error.status === 400 ? error.message : 'Request failed. Check the server log.') });
});

try {
  try {
    if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL in .env');
    await db.query(await readFile(join(root,'server','schema.sql'),'utf8'));
    localReady = true;
  } catch (error) {
    if (!process.env.WAREHOUSE_DATABASE_URL) throw error;
    console.warn(`Local sandbox DB unavailable (${error.code || error.message}); running warehouse-only.`);
  }
  const port = Number(process.env.PORT || 3001);
  app.listen(port,'127.0.0.1',() => console.log(`Finance Workbench listening on http://127.0.0.1:${port}`));
} catch (error) { console.error(error.message); process.exit(1); }
