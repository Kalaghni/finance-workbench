import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { usePlaidLink } from 'react-plaid-link';
import { StripeTab, WealthsimpleTab } from './warehouse.jsx';
import './style.css';

async function api(path, options) {
  const response = await fetch('/api' + path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const money = (amount, currency='CAD') => new Intl.NumberFormat('en-CA', { style:'currency', currency:currency || 'CAD' }).format(Number(amount || 0) / 100);
const title = value => (value || 'Uncategorized').replaceAll('_',' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

function LinkLauncher({ token, onSuccess, onExit }) {
  const handleSuccess = useCallback((publicToken, metadata) => onSuccess(publicToken, metadata), [onSuccess]);
  const { open, ready } = usePlaidLink({ token, onSuccess:handleSuccess, onExit });
  useEffect(() => { if (ready) open(); }, [ready,open]);
  return <button disabled={!ready} onClick={() => open()}>{ready ? 'Open Plaid Link' : 'Loading Plaid Link…'}</button>;
}

function App() {
  const [data,setData] = useState(null);
  const [health,setHealth] = useState(null);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false);
  const [linkToken,setLinkToken] = useState(null);
  const [receipt,setReceipt] = useState('');
  const [selected,setSelected] = useState(null);
  const [warehouse,setWarehouse] = useState(null);
  const [tab,setTab] = useState(() => new URLSearchParams(location.search).get('tab') || 'workbench');

  const refresh = useCallback(async () => setData(await api('/overview')), []);
  useEffect(() => {
    Promise.all([api('/health'),api('/warehouse/status')]).then(async ([h,w]) => {
      setHealth(h);setWarehouse(w);
      if (h.localReady) setData(await api('/overview'));
      else if (w.configured) setTab(t => t === 'workbench' ? 'wealthsimple' : t);
    }).catch(e => setError(e.message));
  }, []);
  const pick = t => { setTab(t); history.replaceState(null,'',t === 'workbench' ? location.pathname : `?tab=${t}`); };
  async function action(fn) {
    setBusy(true);setError('');setNotice('');
    try { await fn(); await refresh(); } catch(e) { setError(e.message); } finally { setBusy(false); }
  }
  const launch = () => action(async () => {
    const result = await api('/plaid/link-token',{method:'POST'});
    setLinkToken(result.linkToken);
  });
  const linked = useCallback((publicToken, metadata) => {
    setLinkToken(null);
    action(async () => {
      await api('/plaid/exchange',{ method:'POST',body:JSON.stringify({publicToken,institutionName:metadata.institution?.name}) });
      const result = await api('/sync',{method:'POST'});
      setNotice(result.results.map(r => r.error ? `${r.institution}: ${r.error}` : `${r.institution}: ${r.added} new transactions`).join(' · '));
    });
  }, []);
  const sync = () => action(async () => {
    const result = await api('/sync',{method:'POST'});
    setNotice(result.results.length ? result.results.map(r => r.error ? `${r.institution}: ${r.error}` : `${r.institution}: ${r.added} new, ${r.modified} changed`).join(' · ') : 'Connect an institution first.');
  });
  const importReceipt = () => action(async () => {
    const result = await api('/purchases',{method:'POST',body:JSON.stringify(JSON.parse(receipt))});
    setNotice(result.suggestion ? `Receipt saved. Suggested match: ${result.suggestion.id} (${Math.round(result.suggestion.score * 100)}%).` : 'Receipt saved without a transaction match.');
    setReceipt('');
  });
  const openPurchase = async id => {
    try { setSelected(await api('/purchases/' + id)); } catch(e) { setError(e.message); }
  };
  const confirmMatch = () => action(async () => {
    const match = selected?.matches?.find(m => m.status === 'probable');
    if (!match) return;
    await api(`/purchases/${selected.purchase.id}/confirm`,{method:'POST',body:JSON.stringify({transactionId:match.transaction_id})});
    setSelected(await api(`/purchases/${selected.purchase.id}`));
    setNotice('Match confirmed.');
  });

  return <main>
    <header className="top"><div><div className="eyebrow">PERSONAL FINANCE / LOCAL WORKSPACE</div><h1>Finance Workbench</h1><p>Accounts, spending, and the items behind each purchase.</p></div>
      {tab === 'workbench' ? <div className="actions"><span className="badge">{health?.environment || '—'}</span><button onClick={sync} disabled={busy || !health?.plaidConfigured}>Sync accounts</button><button className="primary" onClick={launch} disabled={busy || !health?.plaidConfigured}>+ Connect institution</button></div>
        : <div className="actions"><span className="badge live">Live · read-only</span>{warehouse?.plaid_synced && <small className="synced">Synced {new Date(warehouse.plaid_synced).toLocaleString('en-CA',{dateStyle:'medium',timeStyle:'short'})}</small>}</div>}</header>
    <nav className="tabs">{[['workbench','Sandbox workbench'],['stripe','Stripe'],['wealthsimple','Wealthsimple']].map(([t,l]) =>
      <button key={t} className={tab === t ? 'tab on' : 'tab'} onClick={() => pick(t)} disabled={t !== 'workbench' && !warehouse?.configured} title={t !== 'workbench' && !warehouse?.configured ? 'Run scripts/warehouse-setup.mjs to connect the warehouse' : undefined}>{l}</button>)}</nav>
    {error && <div className="alert error">{error}</div>}{notice && <div className="alert success">{notice}</div>}
    {tab === 'stripe' && <StripeTab />}
    {tab === 'wealthsimple' && <WealthsimpleTab />}
    {tab === 'workbench' && health && !health.localReady && <div className="alert">The local sandbox database isn't reachable (check <code>DATABASE_URL</code> / <code>docker compose up -d db</code>). The Stripe and Wealthsimple tabs read the live warehouse and still work.</div>}
    {tab === 'workbench' && health?.localReady && <>
    {!health?.plaidConfigured && <div className="alert">Plaid is not configured yet. Add your Sandbox secret and encryption key to <code>.env</code> to enable connections.</div>}
    {linkToken && <div className="modal-backdrop"><div className="modal"><h2>Connect an institution</h2><p>Plaid handles the institution sign-in. Credentials never pass through this dashboard.</p><LinkLauncher token={linkToken} onSuccess={linked} onExit={() => setLinkToken(null)} /><button className="quiet" onClick={() => setLinkToken(null)}>Cancel</button></div></div>}

    <section className="stats"><div className="stat"><span>Spending · past 30 days</span><strong>{money(data?.summary.spending)}</strong><small>CAD posted outflows, excluding categorized transfers</small></div><div className="stat"><span>Inflows · past 30 days</span><strong>{money(data?.summary.income)}</strong><small>CAD posted inflows, excluding categorized transfers</small></div><div className="stat"><span>Connected accounts</span><strong>{data?.accounts.length ?? '—'}</strong><small>Across {data?.connections.length ?? 0} institutions</small></div></section>

    <div className="grid"><section className="panel"><div className="panel-head"><h2>Accounts</h2><span>{data?.connections.length || 0} connected</span></div>{data?.accounts.length ? data.accounts.map(a => <div className="account" key={a.account_id}><div><b>{a.name}</b><small>{data.connections.find(c => c.item_id === a.item_id)?.institution_name} · {title(a.subtype || a.type)} {a.mask ? `··${a.mask}` : ''}</small></div><b>{money(a.current_balance_cents,a.currency)}</b></div>) : <p className="empty">Connect a Sandbox institution to see your accounts.</p>}</section>
      <section className="panel"><div className="panel-head"><h2>Spending by category</h2><span>Past 30 days · CAD</span></div>{data?.categories.length ? data.categories.map((c,i) => <div className="category" key={c.category}><div className="category-line"><span>{title(c.category)}</span><b>{money(c.cents)}</b></div><div className="track"><div style={{width:`${Math.max(2,Number(c.cents)/Number(data.categories[0].cents)*100)}%`,background:['#6d5ae6','#6caace','#72bca2','#f3b568'][i%4]}}/></div></div>) : <p className="empty">Category totals appear after your first transaction sync.</p>}</section></div>

    <section className="panel"><div className="panel-head"><h2>Recent transactions</h2><span>Most recent 100</span></div><div className="table-wrap"><table><thead><tr><th>Date</th><th>Merchant</th><th>Account</th><th>Category</th><th>Amount</th></tr></thead><tbody>{data?.transactions.map(t => <tr key={t.transaction_id}><td>{t.date}</td><td><b>{t.merchant_name || t.name}</b>{t.pending && <small>Pending</small>}</td><td>{t.account_name}</td><td>{title(t.category_primary)}</td><td className={Number(t.amount_cents)<0?'inflow':''}>{Number(t.amount_cents)<0?'+':'−'}{money(Math.abs(Number(t.amount_cents)),t.currency)}</td></tr>)}</tbody></table>{!data?.transactions.length && <p className="empty">No transactions yet. The first historical sync can take a little while after connecting.</p>}</div></section>

    <section className="panel"><div className="panel-head"><h2>Confirmed item categories</h2><span>Past 30 days · CAD</span></div>{data?.itemizedCategories.length ? data.itemizedCategories.map((c,i) => <div className="category" key={c.category}><div className="category-line"><span>{title(c.category.replaceAll('.',' / '))}</span><b>{money(c.cents)}</b></div><div className="track"><div style={{width:`${Math.max(2,Number(c.cents)/Number(data.itemizedCategories[0].cents)*100)}%`,background:['#6d5ae6','#6caace','#72bca2','#f3b568'][i%4]}}/></div></div>) : <p className="empty">Confirm a receipt match to see what you bought by item category.</p>}</section>
    <div className="grid"><section className="panel"><div className="panel-head"><h2>Itemized purchases</h2><span>Receipt enrichment</span></div>{data?.purchases.length ? data.purchases.map(p => <button className="purchase" key={p.id} onClick={() => openPurchase(p.id)}><span><b>{p.merchant}</b><small>{new Date(p.purchased_at).toLocaleDateString('en-CA')} · {p.item_count} items · {p.source}</small></span><span>{money(p.total_cents,p.currency)}<small>{p.match_status || 'Unmatched'}</small></span></button>) : <p className="empty">Import itemized receipt data here when a retailer connector is ready.</p>}</section>
      <section className="panel"><div className="panel-head"><h2>Import a receipt</h2><span>Connector input format</span></div><p className="muted">Paste a normalized purchase JSON object. Its line items stay separate from the bank transaction, with a suggested match based on amount, date, and merchant.</p><textarea value={receipt} onChange={e => setReceipt(e.target.value)} placeholder={'{"source":"retailer","sourcePurchaseId":"order-123","merchant":"Example Market","purchasedAt":"2026-09-22T18:00:00-04:00","totalCents":1299,"currency":"CAD","items":[{"lineKey":"1","description":"Milk","quantity":1,"totalCents":1299,"category":"groceries.dairy"}]}'}/><button disabled={busy || !receipt.trim()} onClick={importReceipt}>Import purchase</button></section></div>
    </>}
    <footer>{tab === 'workbench' ? 'Local-only prototype · Plaid access tokens are encrypted in Postgres · Purchase matches are suggestions until confirmed'
      : 'Live data from plaid-warehouse · read-only connection · Plaid access tokens are not readable from here'}</footer>
    {selected && <div className="modal-backdrop" onClick={() => setSelected(null)}><div className="modal receipt-modal" onClick={e => e.stopPropagation()}><div className="panel-head"><h2>{selected.purchase.merchant}</h2><button className="quiet" onClick={() => setSelected(null)}>Close</button></div><p>{new Date(selected.purchase.purchased_at).toLocaleString('en-CA')} · {money(selected.purchase.total_cents,selected.purchase.currency)}</p><div className="receipt-items">{selected.items.map(i => <div key={i.line_key}><span>{i.description}<small>{i.quantity} × · {i.category || 'Uncategorized'}</small></span><b>{money(i.total_cents,selected.purchase.currency)}</b></div>)}</div>{selected.matches.map(m => <p key={m.transaction_id} className="match">{m.status === 'confirmed' ? 'Confirmed' : 'Suggested'} bank match · {Math.round(Number(m.confidence)*100)}% · {m.transaction_id}{m.status === 'probable' && <button onClick={confirmMatch} disabled={busy}>Confirm</button>}</p>)}</div></div>}
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
