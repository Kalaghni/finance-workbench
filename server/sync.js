import { decrypt } from './crypto.js';
import { cents, plaid } from './plaid.js';

export async function syncConnection(db, connection) {
  const token = decrypt(connection.access_token_ciphertext);
  // Cached balances arrive with Transactions; avoids extra real-time Balance calls.
  const balances = await plaid('/accounts/get', { access_token: token });
  const originalCursor = connection.sync_cursor || undefined;
  let pages;
  let cursor;
  let attempts = 0;
  // A mutation during pagination invalidates the whole sequence, not just one page.
  while (true) {
    pages = [];
    cursor = originalCursor;
    try {
      do {
        const page = await plaid('/transactions/sync', { access_token: token, cursor, count: 500 });
        pages.push(page);
        cursor = page.next_cursor;
      } while (pages.at(-1).has_more);
      break;
    } catch (error) {
      if (error.code !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' || ++attempts >= 3) throw error;
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const account of balances.accounts) {
      await client.query(`INSERT INTO accounts (account_id,item_id,name,official_name,type,subtype,mask,currency,current_balance_cents,available_balance_cents,balance_observed_at,raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11)
        ON CONFLICT (account_id) DO UPDATE SET name=EXCLUDED.name,official_name=EXCLUDED.official_name,type=EXCLUDED.type,subtype=EXCLUDED.subtype,mask=EXCLUDED.mask,currency=EXCLUDED.currency,current_balance_cents=EXCLUDED.current_balance_cents,available_balance_cents=EXCLUDED.available_balance_cents,balance_observed_at=now(),raw=EXCLUDED.raw`,
        [account.account_id, connection.item_id, account.name, account.official_name, account.type, account.subtype, account.mask, account.balances.iso_currency_code || account.balances.unofficial_currency_code, cents(account.balances.current), cents(account.balances.available), account]);
    }
    const removed = pages.flatMap(page => page.removed);
    for (const page of pages) {
      const ingested = await client.query('INSERT INTO raw_ingestions(item_id,connector,payload) VALUES ($1,$2,$3) RETURNING id', [connection.item_id, 'plaid.transactions.sync', page]);
      for (const transaction of [...page.added, ...page.modified]) {
        await client.query(`INSERT INTO transactions (transaction_id,account_id,pending_transaction_id,amount_cents,currency,name,merchant_name,date,authorized_date,pending,category_primary,category_detailed,raw_ingestion_id,raw)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT(transaction_id) DO UPDATE SET account_id=EXCLUDED.account_id,pending_transaction_id=EXCLUDED.pending_transaction_id,amount_cents=EXCLUDED.amount_cents,currency=EXCLUDED.currency,name=EXCLUDED.name,merchant_name=EXCLUDED.merchant_name,date=EXCLUDED.date,authorized_date=EXCLUDED.authorized_date,pending=EXCLUDED.pending,category_primary=EXCLUDED.category_primary,category_detailed=EXCLUDED.category_detailed,raw_ingestion_id=EXCLUDED.raw_ingestion_id,raw=EXCLUDED.raw`,
          [transaction.transaction_id, transaction.account_id, transaction.pending_transaction_id, cents(transaction.amount), transaction.iso_currency_code || transaction.unofficial_currency_code, transaction.name, transaction.merchant_name, transaction.date, transaction.authorized_date, transaction.pending, transaction.personal_finance_category?.primary, transaction.personal_finance_category?.detailed, ingested.rows[0].id, transaction]);
      }
    }
    // A pending charge can be added on one page and removed on the next.
    for (const transaction of removed) await client.query('DELETE FROM transactions WHERE transaction_id=$1', [transaction.transaction_id]);
    await client.query("UPDATE connections SET sync_cursor=$2,last_synced_at=now(),status='connected' WHERE item_id=$1", [connection.item_id, cursor]);
    await client.query('COMMIT');
    return { itemId: connection.item_id, added: pages.reduce((n,p) => n + p.added.length,0), modified: pages.reduce((n,p) => n + p.modified.length,0), removed: removed.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
