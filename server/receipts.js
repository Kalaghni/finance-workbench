function validMoney(value) { return Number.isSafeInteger(value) && value >= 0; }

export function validatePurchase(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a purchase object');
  if (!['retailer', 'pc_optimum', 'moi', 'aeroplan', 'manual'].includes(value.source)) throw new Error('Unknown purchase source');
  if (typeof value.sourcePurchaseId !== 'string' || !value.sourcePurchaseId.trim() || value.sourcePurchaseId.length > 200) throw new Error('Missing sourcePurchaseId');
  if (typeof value.merchant !== 'string' || !value.merchant.trim() || value.merchant.length > 200) throw new Error('Missing merchant');
  if (typeof value.purchasedAt !== 'string' || !Number.isFinite(Date.parse(value.purchasedAt))) throw new Error('Invalid purchasedAt');
  if (!validMoney(value.totalCents)) throw new Error('Invalid totalCents');
  if (!['CAD', 'USD'].includes(value.currency || 'CAD')) throw new Error('Invalid currency');
  if (!Array.isArray(value.items) || value.items.length > 500) throw new Error('Invalid items');
  const keys = new Set();
  for (const item of value.items) {
    if (!item || typeof item.lineKey !== 'string' || !item.lineKey || keys.has(item.lineKey)) throw new Error('Duplicate or missing lineKey');
    keys.add(item.lineKey);
    if (typeof item.description !== 'string' || !item.description || !validMoney(item.totalCents)) throw new Error('Invalid receipt line');
    if (item.quantity != null && (!Number.isFinite(item.quantity) || item.quantity <= 0)) throw new Error('Invalid quantity');
  }
  return value;
}

export function matchScore(purchase, transaction) {
  if (purchase.currency !== transaction.currency || purchase.totalCents !== transaction.amountCents || transaction.amountCents <= 0) return 0;
  const days = Math.abs((Date.parse(purchase.purchasedAt) - Date.parse(transaction.date)) / 86400000);
  if (days > 4) return 0;
  const left = purchase.merchant.toLowerCase().replace(/[^a-z0-9]/g, '');
  const right = (transaction.merchantName || transaction.name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const merchant = left.includes(right) || right.includes(left) || (left.length > 4 && right.length > 4 && left.slice(0,5) === right.slice(0,5));
  return Number((0.58 + (days <= 1 ? 0.18 : days <= 2 ? 0.12 : 0.04) + (merchant ? 0.24 : 0)).toFixed(3));
}

export async function importPurchase(db, data) {
  const purchase = validatePurchase(data);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const previous = await client.query('SELECT id,merchant,purchased_at,currency,total_cents FROM purchases WHERE source=$1 AND source_purchase_id=$2 FOR UPDATE', [purchase.source,purchase.sourcePurchaseId]);
    const inserted = await client.query(`INSERT INTO purchases(source,source_purchase_id,merchant,purchased_at,currency,total_cents,raw)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source,source_purchase_id) DO UPDATE SET merchant=EXCLUDED.merchant,purchased_at=EXCLUDED.purchased_at,currency=EXCLUDED.currency,total_cents=EXCLUDED.total_cents,raw=EXCLUDED.raw RETURNING id`,
      [purchase.source,purchase.sourcePurchaseId,purchase.merchant,purchase.purchasedAt,purchase.currency || 'CAD',purchase.totalCents,purchase]);
    const id = inserted.rows[0].id;
    const old = previous.rows[0];
    if (old && (old.merchant !== purchase.merchant || new Date(old.purchased_at).getTime() !== Date.parse(purchase.purchasedAt) || old.currency !== (purchase.currency || 'CAD') || Number(old.total_cents) !== purchase.totalCents)) {
      await client.query('DELETE FROM purchase_matches WHERE purchase_id=$1', [id]);
    }
    await client.query('DELETE FROM purchase_items WHERE purchase_id=$1', [id]);
    for (const line of purchase.items) await client.query(`INSERT INTO purchase_items(purchase_id,line_key,description,sku,quantity,total_cents,category,raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id,line.lineKey,line.description,line.sku || null,line.quantity || 1,line.totalCents,line.category || null,line]);
    // Candidate matches are suggestions; never merge ambiguous purchases automatically.
    const candidates = await client.query(`SELECT t.transaction_id,t.amount_cents AS "amountCents",t.currency,t.name,t.merchant_name AS "merchantName",t.date::text AS date
      FROM transactions t WHERE t.amount_cents=$1 AND t.currency=$2 AND t.date BETWEEN ($3::date - 4) AND ($3::date + 4) AND NOT t.pending`,
      [purchase.totalCents,purchase.currency || 'CAD',purchase.purchasedAt.slice(0,10)]);
    const ranked = candidates.rows.map(row => ({ id: row.transaction_id, score: matchScore({ ...purchase, currency: purchase.currency || 'CAD' }, row) })).sort((a,b) => b.score-a.score);
    await client.query("DELETE FROM purchase_matches WHERE purchase_id=$1 AND status='probable'", [id]);
    if (ranked[0]?.score >= .85 && (!ranked[1] || ranked[0].score - ranked[1].score >= .1)) {
      await client.query(`INSERT INTO purchase_matches(purchase_id,transaction_id,confidence,status) VALUES ($1,$2,$3,'probable') ON CONFLICT(purchase_id,transaction_id) DO NOTHING`, [id,ranked[0].id,ranked[0].score]);
    }
    await client.query('COMMIT');
    return { id, suggestion: ranked[0]?.score >= .85 && (!ranked[1] || ranked[0].score-ranked[1].score >= .1) ? ranked[0] : null };
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
