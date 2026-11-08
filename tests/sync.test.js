import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { encrypt } from '../server/crypto.js';
import { syncConnection } from '../server/sync.js';

test('all pages and final cursor commit together; pending transaction is replaced', async () => {
  process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
  process.env.PLAID_CLIENT_ID = 'test-client';
  process.env.PLAID_SECRET = 'test-secret';
  process.env.PLAID_ENV = 'sandbox';
  const db = new PGlite();
  await db.exec(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  const encrypted = encrypt('access-sandbox-fake');
  await db.query('INSERT INTO connections(item_id,institution_name,access_token_ciphertext) VALUES($1,$2,$3)', ['item-1','Example Bank',encrypted]);
  const originalFetch = global.fetch;
  const calls = [];
  const pending = { transaction_id:'pending-1',account_id:'acct-1',amount:12.99,iso_currency_code:'CAD',name:'Example Market',date:'2026-09-21',pending:true };
  const posted = { ...pending, transaction_id:'posted-1',pending_transaction_id:'pending-1',date:'2026-09-22',pending:false };
  global.fetch = async (url, options) => {
    const request=JSON.parse(options.body);
    calls.push({url,cursor:request.cursor});
    if (url.endsWith('/accounts/get')) return Response.json({accounts:[{account_id:'acct-1',name:'Chequing',type:'depository',subtype:'checking',balances:{current:1000,available:900,iso_currency_code:'CAD'}}]});
    if (request.cursor === undefined) return Response.json({added:[pending],modified:[],removed:[],next_cursor:'page-2',has_more:true});
    if (request.cursor === 'page-2') return Response.json({added:[posted],modified:[],removed:[{transaction_id:'pending-1'}],next_cursor:'finished',has_more:false});
    throw new Error('Unexpected cursor');
  };
  try {
    const result=await syncConnection({connect:async()=>({query:(...args)=>db.query(...args),release(){}})}, {item_id:'item-1',access_token_ciphertext:encrypted,sync_cursor:null});
    assert.deepEqual({added:result.added,removed:result.removed},{added:2,removed:1});
    assert.deepEqual(calls.map(c=>c.cursor),[undefined,undefined,'page-2']);
    const rows=await db.query('SELECT transaction_id,amount_cents FROM transactions');
    assert.deepEqual(rows.rows.map(r=>r.transaction_id),['posted-1']);
    assert.equal(Number(rows.rows[0].amount_cents),1299);
    assert.equal((await db.query('SELECT sync_cursor FROM connections')).rows[0].sync_cursor,'finished');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM raw_ingestions')).rows[0].n,2);
  } finally { global.fetch=originalFetch; await db.close(); }
});
