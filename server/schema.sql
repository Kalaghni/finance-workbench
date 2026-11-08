CREATE TABLE IF NOT EXISTS connections (
  item_id TEXT PRIMARY KEY,
  institution_name TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  sync_cursor TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES connections(item_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  official_name TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  mask TEXT,
  currency TEXT,
  current_balance_cents BIGINT,
  available_balance_cents BIGINT,
  balance_observed_at TIMESTAMPTZ,
  raw JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_ingestions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES connections(item_id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  connector TEXT NOT NULL,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  pending_transaction_id TEXT,
  amount_cents BIGINT NOT NULL,
  currency TEXT,
  name TEXT NOT NULL,
  merchant_name TEXT,
  date DATE NOT NULL,
  authorized_date DATE,
  pending BOOLEAN NOT NULL,
  category_primary TEXT,
  category_detailed TEXT,
  raw_ingestion_id BIGINT REFERENCES raw_ingestions(id),
  raw JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(date DESC);
CREATE INDEX IF NOT EXISTS transactions_account_idx ON transactions(account_id);

CREATE TABLE IF NOT EXISTS purchases (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source TEXT NOT NULL,
  source_purchase_id TEXT NOT NULL,
  merchant TEXT NOT NULL,
  purchased_at TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  total_cents BIGINT NOT NULL,
  raw JSONB NOT NULL,
  UNIQUE(source, source_purchase_id)
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_id BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  line_key TEXT NOT NULL,
  description TEXT NOT NULL,
  sku TEXT,
  quantity NUMERIC(12,3) NOT NULL DEFAULT 1,
  total_cents BIGINT NOT NULL,
  category TEXT,
  raw JSONB NOT NULL,
  UNIQUE(purchase_id, line_key)
);
CREATE TABLE IF NOT EXISTS purchase_matches (
  purchase_id BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE,
  confidence NUMERIC(4,3) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('probable','confirmed')),
  PRIMARY KEY(purchase_id, transaction_id)
);
