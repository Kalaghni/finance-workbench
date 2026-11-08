import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePurchase, matchScore } from '../server/receipts.js';
import { encrypt, decrypt } from '../server/crypto.js';

test('receipt matching rejects different amounts and currencies and prefers exact merchant/date', () => {
  const purchase = { merchant:'Example Market', purchasedAt:'2026-09-22T18:00:00-04:00', totalCents:1299, currency:'CAD' };
  const transaction = { name:'EXAMPLE MARKET 123', amountCents:1299, date:'2026-09-23', currency:'CAD' };
  assert.equal(matchScore(purchase,transaction),1);
  assert.equal(matchScore(purchase,{...transaction,amountCents:1300}),0);
  assert.equal(matchScore(purchase,{...transaction,currency:'USD'}),0);
  assert.equal(matchScore(purchase,{...transaction,date:'2026-10-01'}),0);
});

test('receipt schema rejects duplicate item IDs and invalid amounts', () => {
  const input = { source:'retailer',sourcePurchaseId:'123',merchant:'Store',purchasedAt:'2026-09-22T12:00:00Z',totalCents:1300,items:[{lineKey:'1',description:'Milk',totalCents:1300}] };
  assert.equal(validatePurchase(input),input);
  assert.throws(() => validatePurchase({...input,items:[input.items[0],input.items[0]]}),/Duplicate/);
  assert.throws(() => validatePurchase({...input,totalCents:12.5}),/totalCents/);
});

test('stored access token encrypts with a random nonce and detects tampering', () => {
  process.env.TOKEN_ENCRYPTION_KEY='a'.repeat(64);
  const first=encrypt('access-sandbox-test');
  const second=encrypt('access-sandbox-test');
  assert.notEqual(first,second);
  assert.equal(decrypt(first),'access-sandbox-test');
  assert.throws(() => decrypt(first.slice(0,-2)+'aa'));
});
