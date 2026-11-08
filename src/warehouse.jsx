import React, { useEffect, useState } from 'react';

// Warehouse tabs (server/warehouse.js). Amounts arrive as dollar strings.
const dollars = (v, currency = 'CAD') => new Intl.NumberFormat('en-CA', { style: 'currency', currency: currency || 'CAD' }).format(Number(v || 0));
const signed = v => (Number(v) > 0 ? '+' : Number(v) < 0 ? '−' : '') + dollars(Math.abs(Number(v || 0)));
const title = v => (v || '—').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const label = { rrsp: 'RRSP', tfsa: 'TFSA', fhsa: 'FHSA', brokerage: 'Non-registered', checking: 'Cash' };

function useApi(path) {
  const [state, setState] = useState({ data: null, error: '' });
  useEffect(() => {
    let live = true;
    fetch('/api' + path).then(async r => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Request failed');
      if (live) setState({ data: body, error: '' });
    }).catch(e => live && setState({ data: null, error: e.message }));
    return () => { live = false; };
  }, [path]);
  return state;
}

function Stat({ label: l, value, note }) {
  return <div className="stat"><span>{l}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}

function Sparkline({ points }) {
  if (points.length < 2) return <p className="empty">Value history builds up one snapshot per day.</p>;
  const values = points.map(p => Number(p.value));
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i / (values.length - 1)) * 600},${70 - ((v - min) / span) * 60}`).join(' ');
  return <div className="spark">
    <svg viewBox="0 0 600 75" preserveAspectRatio="none" role="img" aria-label="Wealthsimple value over time"><path d={d} /></svg>
    <div className="spark-axis"><span>{points[0].date} · {dollars(values[0])}</span><span>{points.at(-1).date} · {dollars(values.at(-1))}</span></div>
  </div>;
}

export function StripeTab() {
  const { data, error } = useApi('/stripe');
  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <p className="empty">Loading Stripe…</p>;
  const y = data.ytd;
  const bal = data.balance.reduce((s, b) => s + Number(b.available) + Number(b.pending), 0);
  return <>
    <section className="stats four">
      <Stat label={`Gross sales · ${new Date().getFullYear()}`} value={dollars(y.gross)} note={`${y.charges} charges · last 12 months ${dollars(data.last12.gross)}`} />
      <Stat label="Stripe fees · YTD" value={dollars(y.fees)} note={`${Number(y.gross) > 0 ? (Number(y.fees) / Number(y.gross) * 100).toFixed(1) : '0.0'}% of sales`} />
      <Stat label="Net after fees & refunds · YTD" value={dollars(y.net)} note={Number(y.refunds) ? `${dollars(y.refunds)} refunded/disputed` : 'No refunds or disputes'} />
      <Stat label="HST included in sales · YTD" value={dollars(y.hstIncluded)} note="13/113 of sales: owed to CRA, not income" />
    </section>
    <div className="grid">
      <section className="panel"><div className="panel-head"><h2>By month</h2><span>Live mode · last 24 months</span></div>
        <div className="table-wrap"><table><thead><tr><th>Month</th><th>Charges</th><th>Gross</th><th>Fees</th><th>Paid out</th><th>Net</th></tr></thead>
          <tbody>{data.monthly.filter(m => Number(m.gross_sales) || Number(m.paid_out)).map(m => <tr key={m.month}><td>{m.month}</td><td>{m.charge_count}</td><td>{dollars(m.gross_sales)}</td><td>{dollars(m.fees)}</td><td>{dollars(m.paid_out)}</td><td>{dollars(m.net_revenue)}</td></tr>)}</tbody></table>
          {!data.monthly.some(m => Number(m.gross_sales)) && <p className="empty">No sales in the last 24 months.</p>}</div></section>
      <section className="panel"><div className="panel-head"><h2>Payouts</h2><span>Balance now {dollars(bal)}</span></div>
        {data.payouts.length ? data.payouts.map(p => <div className="account" key={p.id}><div><b>{dollars(p.amount, p.currency)}</b>
          <small>{p.arrival_date} · {title(p.status)}</small></div>
          <span className={p.bank_date ? 'pill ok' : 'pill'}>{p.bank_date ? `In ${p.bank_account} ${p.bank_date}` : 'No bank match yet'}</span></div>)
          : <p className="empty">No payouts yet.</p>}</section>
    </div>
    <section className="panel"><div className="panel-head"><h2>Charges</h2><span>Most recent 50</span></div>
      <div className="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Customer</th><th>Method</th><th>Status</th><th>Amount</th></tr></thead>
        <tbody>{data.charges.map(c => <tr key={c.id}><td>{c.date}</td><td><b>{c.description || '—'}</b>{Number(c.amount_refunded) > 0 && <small>Refunded {dollars(c.amount_refunded, c.currency)}</small>}{c.disputed && <small>Disputed</small>}</td>
          <td>{c.customer_name || '—'}</td><td>{title(c.payment_method_type)}</td><td>{title(c.status)}</td><td>{dollars(c.amount, c.currency)}</td></tr>)}</tbody></table></div></section>
  </>;
}

function FhsaExcess({ f }) {
  const taxed = f.years.filter(y => y.tax > 0);
  return <section className="panel"><div className="panel-head"><h2>FHSA over-contribution tax · {f.account}</h2><span>1% per month on the highest excess (CRA form RC728)</span></div>
    <div className="stats four inner">
      {taxed.map(y => <Stat key={y.year} label={`Tax for ${y.year}${y.approximate ? ' (approx.)' : ''}`} value={dollars(y.tax)}
        note={`Room ${dollars(y.room)} (${y.roomSource}) · RC728 due ${y.year + 1}-06-30`} />)}
      <Stat label="Total" value={dollars(f.total)} note={`${f.years.map(y => `${y.year}: in ${dollars(y.contributed)}`).join(' · ')}`} />
    </div>
    <div className="months">{f.months.filter(m => m.highest > 0).map(m => <div key={m.month} className="month"><span>{m.month}</span><b>{dollars(m.highest)}</b><small>{dollars(m.tax)}</small></div>)}</div>
    <p className="muted">Room comes from the CRA Notices of Assessment; each January 1 adds $8,000, and last year's excess eats into it.
      {taxed.some(y => y.approximate) && ' Years marked approx. include a contribution total whose dates aren\'t on file; the per-contribution dates (Wealthsimple contribution letter) would make them exact.'} CRA can waive the tax for a reasonable error that was fixed promptly.</p>
  </section>;
}

export function WealthsimpleTab() {
  const { data, error } = useApi('/wealthsimple');
  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <p className="empty">Loading Wealthsimple…</p>;
  const total = data.accounts.reduce((s, a) => s + Number(a.balance || 0), 0);
  const first = data.history[0];
  const change = first ? Number(data.history.at(-1).value) - Number(first.value) : null;
  const unrealized = data.holdings.reduce((s, h) => s + Number(h.unrealized_gain || 0), 0);
  const thisYear = new Date().getFullYear();
  const depositedYtd = data.deposits.filter(d => d.year === thisYear).reduce((s, d) => s + Number(d.deposited), 0);
  const activity = [
    ...data.activity.map(a => ({ ...a, source: 'Plaid', what: a.name, kind: a.subtype || a.type })),
    ...data.manualActivity.map(a => ({ ...a, source: 'Statement', what: a.security || title(a.type), note: a.description, kind: a.type })),
  ].sort((x, y) => y.date.localeCompare(x.date)).slice(0, 120);
  const years = [...new Set(data.deposits.map(d => d.year))];
  const types = [...new Set(data.deposits.map(d => d.account_type))];

  return <>
    <section className="stats four">
      <Stat label="Value · linked accounts" value={dollars(total)} note={`${data.accounts.length} accounts via Plaid`} />
      <Stat label={first ? `Change since ${first.date}` : 'Change'} value={change == null ? '—' : signed(change)} note="Includes deposits, not just returns" />
      <Stat label="Unrealized gain" value={signed(unrealized)} note={`${data.holdings.length} positions`} />
      <Stat label={`Put in · ${thisYear}`} value={dollars(depositedYtd)} note="RRSP, TFSA and FHSA deposits" />
    </section>
    <section className="panel"><div className="panel-head"><h2>Value over time</h2><span>Investment accounts · daily snapshots</span></div><Sparkline points={data.history} /></section>
    <div className="grid">
      <section className="panel"><div className="panel-head"><h2>Accounts</h2><span>Plaid-linked + from statements</span></div>
        {data.accounts.map(a => <div className="account" key={a.id}><div><b>{a.name.trim()}</b><small>{label[a.subtype] || title(a.subtype)} {a.mask ? `··${a.mask}` : ''} · as of {a.as_of || '—'}</small></div><b>{dollars(a.balance)}</b></div>)}
        {data.manualAccounts.map(a => <div className="account" key={a.id}><div><b>{a.name} <span className="pill">Not in Plaid</span></b>
          <small>{label[a.subtype] || a.subtype} · {title(a.owner)} · opened {a.opened_on} · in {dollars(a.contributed)} (known) · out {dollars(a.withdrawn)}</small></div>
          <span className="right"><b>{dollars(0)}</b><small>{dollars(a.last_value)} on {a.last_value_date}</small></span></div>)}
      </section>
      <section className="panel"><div className="panel-head"><h2>Money put in, by year</h2><span>Deposits / contributions</span></div>
        <div className="table-wrap"><table><thead><tr><th>Year</th>{types.map(t => <th key={t}>{label[t] || t}</th>)}</tr></thead>
          <tbody>{years.map(yr => <tr key={yr}><td>{yr}</td>{types.map(t => { const d = data.deposits.find(x => x.year === yr && x.account_type === t);
            return <td key={t}>{d ? <>{dollars(d.deposited)}<small>{d.deposits} deposits</small></> : '—'}</td>; })}</tr>)}</tbody></table></div>
        <p className="muted">FHSA from Wealthsimple's contribution letters; Plaid's history for the others starts in late 2024.</p></section>
    </div>
    {data.fhsa.map(f => <FhsaExcess key={f.account} f={f} />)}
    <section className="panel"><div className="panel-head"><h2>Holdings</h2><span>Latest snapshot</span></div>
      <div className="table-wrap"><table><thead><tr><th>Account</th><th>Security</th><th>Quantity</th><th>Price</th><th>Cost</th><th>Gain</th><th>Value</th></tr></thead>
        <tbody>{data.holdings.map((h, i) => <tr key={i}><td>{h.account}</td><td><b>{h.ticker || '—'}</b><small className="plain">{h.name}</small></td><td>{Number(h.quantity).toLocaleString('en-CA', { maximumFractionDigits: 6 })}</td>
          <td>{dollars(h.price, h.currency)}</td><td>{h.cost_basis == null ? '—' : dollars(h.cost_basis, h.currency)}</td>
          <td className={Number(h.unrealized_gain) >= 0 ? 'inflow' : 'outflow'}>{h.unrealized_gain == null ? '—' : signed(h.unrealized_gain)}</td><td>{dollars(h.value, h.currency)}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><div className="panel-head"><h2>Activity</h2><span>Most recent 120 · + into the account</span></div>
      <div className="table-wrap"><table><thead><tr><th>Date</th><th>Account</th><th>What</th><th>Type</th><th>Source</th><th>Cash</th></tr></thead>
        <tbody>{activity.map((a, i) => <tr key={i}><td>{a.date}</td><td>{a.account}</td><td className="wrap" title={a.note || undefined}><b>{a.what}</b>{a.note && <small className="plain">{a.note}</small>}</td><td>{title(a.kind)}</td><td><span className={a.source === 'Plaid' ? 'pill' : 'pill doc'} title={a.source_doc}>{a.source}</span></td>
          <td className={Number(a.cash) >= 0 ? 'inflow' : ''}>{signed(a.cash)}</td></tr>)}</tbody></table></div></section>
  </>;
}
