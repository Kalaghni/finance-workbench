-- Finance Workbench ↔ plaid-warehouse (`finance` DB on josh-db).
-- Run as a superuser:  psql -d finance -f warehouse/001_manual_and_role.sql
-- Idempotent. The role's password is set by scripts/set-warehouse-password.mjs,
-- so no secret lives in this file.
--
-- 1. Schema `manual`: accounts Plaid never saw (e.g. Josh's Wealthsimple FHSA,
--    closed after the April 2026 home purchase), loaded from statements/letters.
--    plaid-warehouse's init-db only rebuilds `marts`, so this schema is safe.
-- 2. Role `workbench_ro`: read-only login for the workbench. Everything except
--    the encrypted Plaid access tokens.

CREATE SCHEMA IF NOT EXISTS manual;

CREATE TABLE IF NOT EXISTS manual.accounts (
  account_key   text PRIMARY KEY,                -- stable slug, never an account number
  institution   text NOT NULL,
  name          text NOT NULL,
  type          text NOT NULL,                   -- investment / depository / ...
  subtype       text,                            -- fhsa / rrsp / tfsa / ...
  owner         text CHECK (owner IN ('josh', 'grace', 'joint')),
  opened_on     date,
  closed_on     date,
  note          text
);

-- amount: + into the account, - out of it (Plaid's investment feed uses the opposite sign).
CREATE TABLE IF NOT EXISTS manual.investment_transactions (
  id           serial PRIMARY KEY,
  account_key  text NOT NULL REFERENCES manual.accounts,
  date         date NOT NULL,
  type         text NOT NULL CHECK (type IN ('contribution', 'withdrawal_qualifying', 'withdrawal_designated',
                 'withdrawal_taxable', 'dividend', 'withholding_tax', 'fee', 'rebate', 'sell', 'buy', 'transfer')),
  amount       numeric(14,2) NOT NULL,
  security     text,
  description  text,
  source_doc   text NOT NULL,
  UNIQUE NULLS NOT DISTINCT (account_key, date, type, amount, security)
);

CREATE TABLE IF NOT EXISTS manual.balance_snapshots (
  account_key    text NOT NULL REFERENCES manual.accounts,
  snapshot_date  date NOT NULL,
  market_value   numeric(14,2) NOT NULL,
  source_doc     text NOT NULL,
  PRIMARY KEY (account_key, snapshot_date)
);

-- ---- read-only role for the workbench -------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'workbench_ro') THEN
    CREATE ROLE workbench_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      NOINHERIT CONNECTION LIMIT 5;
  END IF;
END $$;
ALTER ROLE workbench_ro SET default_transaction_read_only = on;
ALTER ROLE workbench_ro SET statement_timeout = '10s';

GRANT CONNECT ON DATABASE finance TO workbench_ro;
GRANT USAGE ON SCHEMA marts, plaid, stripe, wh, manual TO workbench_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA marts, plaid, stripe, wh, manual TO workbench_ro;
REVOKE SELECT ON plaid.items FROM workbench_ro;
GRANT SELECT (item_id, institution_id, institution_name, env, products, status, error,
              consent_expiration_time, last_synced_at, last_webhook_at, created_at, updated_at)
  ON plaid.items TO workbench_ro;
-- init-db drops and recreates the marts views; keep them readable (marts only,
-- never plaid, so a recreated plaid.items can't hand over its token column).
ALTER DEFAULT PRIVILEGES FOR ROLE wh IN SCHEMA marts GRANT SELECT ON TABLES TO workbench_ro;

-- The homeplan MCP (finance_query, tax tools) reads `manual` too.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'homeplan_mcp') THEN
    GRANT USAGE ON SCHEMA manual TO homeplan_mcp;
    GRANT SELECT ON ALL TABLES IN SCHEMA manual TO homeplan_mcp;
  END IF;
END $$;
