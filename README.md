# Finance Workbench

A local-first personal finance prototype. Plaid Link connects Canadian Sandbox institutions, Postgres keeps account and transaction history, and itemized purchases can be imported separately and suggested against bank transactions.

## Start

Requirements: Node.js 20.19+ and Postgres 15+ (or Docker Compose).

1. Copy `.env.example` to `.env`. Fill in `PLAID_CLIENT_ID` and your **Sandbox** `PLAID_SECRET` from the Plaid dashboard. Create `TOKEN_ENCRYPTION_KEY` with `openssl rand -hex 32`. Never commit `.env`.
2. Start Postgres: `docker compose up -d db`, or point `DATABASE_URL` at your existing Postgres instance.
3. Run `npm install`, then `npm run dev`.
4. Open `http://127.0.0.1:5173`. Choose **Connect institution** and use Plaid Sandbox test credentials (`user_good` / `pass_good`). Sync again after Plaid finishes fetching the initial history.

For a built frontend: `npm run build && npm start`, then open `http://127.0.0.1:3001`. `npm test` runs the pure-logic checks.

## What it does

- Creates a Link token for Canadian institutions and exchanges the public token server-side.
- Encrypts each Plaid access token with AES-256-GCM before storing it in Postgres. Back up your encryption key separately; losing it makes existing Items unusable.
- Uses `/transactions/sync` with cursor pagination; commits all pages and the final cursor together. Raw sync responses are retained for later reprocessing. Uses `/accounts/get` for cached balances.
- Shows linked accounts, recent transactions, CAD spending and inflows, and Plaid's category totals for the past 30 days. Confirmed receipt matches also show item-level category totals.
- Imports a normalized purchase with item lines at `POST /api/purchases`. It suggests a bank match only for the same currency and exact total, a nearby date, and a clear leading candidate. A suggestion can be confirmed in the receipt detail view.

Example connector payload:

```json
{
  "source": "retailer",
  "sourcePurchaseId": "order-123",
  "merchant": "Example Market",
  "purchasedAt": "2026-09-22T18:00:00-04:00",
  "totalCents": 1299,
  "currency": "CAD",
  "items": [
    { "lineKey": "1", "description": "Milk", "quantity": 1, "totalCents": 1299, "category": "groceries.dairy" }
  ]
}
```

Importing the same `source` + `sourcePurchaseId` updates the purchase and its item lines. Taxes, discounts, tips, and rounding can be represented as separate lines. Receipts are never summed with bank transactions as additional expenses.

## Stripe and Wealthsimple tabs (live warehouse)

The **Stripe** and **Wealthsimple** tabs read the live `plaid-warehouse` database (`finance` on josh-db) instead of the sandbox. They're read-only and need no Plaid sandbox or local Postgres; if the local DB is unreachable the server starts in warehouse-only mode.

- **Stripe**: YTD gross, fees, net and the HST included in sales (13/113, owed to CRA), month-by-month table, payouts matched to the bank deposit, recent charges.
- **Wealthsimple**: Plaid-linked accounts (RRSP, TFSAs, crypto, non-registered, cash) with value history, holdings and gains, activity, money put in per account per year, plus accounts Plaid never saw (the `manual` schema, e.g. Josh's FHSA) and the FHSA over-contribution tax by month (`server/fhsa.js`).

Setup (once):

```bash
ADMIN_DATABASE_URL=postgres://<superuser>@192.168.2.122:5433/finance node scripts/warehouse-setup.mjs
```

It applies `warehouse/*.sql` (the `manual` schema + FHSA data + a `workbench_ro` role: SELECT only, every session read-only, Plaid access tokens unreadable), sets a random password and writes `WAREHOUSE_DATABASE_URL` into `.env`. Re-running is safe; `--rotate` issues a new password. Open `http://127.0.0.1:3001/?tab=wealthsimple` or `?tab=stripe`.

Adding statement data Plaid can't see: append rows to a new `warehouse/00N_*.sql` (`manual.accounts`, `manual.investment_transactions` with **+ into the account**, `manual.balance_snapshots`, each row citing its `source_doc`) and re-run the setup.

## Boundaries

This is a **single-person local app**. The server binds to `127.0.0.1`; it has no login system or public-web security model. Do not expose its port, database, or Vite server to a LAN or internet. Postgres contains sensitive transaction and receipt data in plaintext; use disk encryption and protected backups. The sample database password is only suitable for localhost development. Never reuse the sample Compose credentials for an exposed database.

Transactions do not cover investment trade history; add Plaid Investments separately. Category totals follow Plaid's categories and may include card payments when a provider does not mark them as transfers. Balances are cached, not real-time. Currency totals intentionally use CAD only and do not convert USD. Plaid Sandbox uses fake data; changing `PLAID_ENV` requires credentials for that environment, and Sandbox Items cannot become Production Items.

PC Optimum, Moi, Aeroplan, utilities, and retailer browser connectors are **not yet implemented**. Their output can be sent to the purchase import API once their item detail availability has been verified. Never put bank passwords into a connector config.
