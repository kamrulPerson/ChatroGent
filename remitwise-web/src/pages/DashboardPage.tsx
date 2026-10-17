import { useEffect, useState } from 'react';
import { useApp } from '../state';
import { balances as mockBalances, documents as mockDocuments, fxSeries as mockFxSeries } from '../mock/data';
import { api, useMock, type DashboardData } from '../api/client';
import { fmtBDT } from '../format';
import FxChart from '../components/FxChart';

const CURRENCY_META: Record<string, { label: string; symbol: string }> = {
  BDT: { label: 'Taka account', symbol: '৳' },
  MYR: { label: 'Student card balance', symbol: 'RM ' },
};

const DOC_LABEL: Record<string, string> = {
  admission_letter: 'Admission letter',
  cost_estimate: "University's cost estimate",
  passport: 'Valid passport',
  certificates: 'Attested certificates',
};

export default function DashboardPage() {
  const { alerts, transfers } = useApp();
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    if (useMock) return;
    api.dashboard().then(setData).catch(() => {});
  }, []);

  const balList = data
    ? data.balances.map((b) => ({ currency: b.currency, amount: b.amount, ...(CURRENCY_META[b.currency] ?? { label: b.currency, symbol: '' }) }))
    : mockBalances;

  const docList = data
    ? data.documents.map((d) => ({ name: DOC_LABEL[d.type] ?? d.type, done: d.verified }))
    : mockDocuments;

  const series = data && data.fxSeries.length ? data.fxSeries.map((f) => f.rate) : mockFxSeries;
  const lo = Math.min(...series), hi = Math.max(...series);
  const avg = series.reduce((a, b) => a + b, 0) / series.length;
  const now = series[series.length - 1];
  const pos = hi === lo ? 50 : Math.round(((now - lo) / (hi - lo)) * 100);

  const realAlerts = data
    ? data.alerts.map((a) => ({
        id: a.id,
        pair: a.pair,
        target: a.target,
        fallbackDate: a.fallbackDate,
        status: (a.status === 'active' ? 'active' : 'proposed') as 'active' | 'proposed',
      }))
    : [];
  const alertList = alerts.length ? alerts : realAlerts;

  const realTransfers = data
    ? data.transfers.map((t) => ({
        id: t.id,
        date: t.date,
        recipient: 'RemitWise transfer',
        amountBDT: t.amountBDT ?? 0,
        status: t.status,
      }))
    : [];
  const transferList = [...transfers, ...realTransfers];

  const active = alertList.find((a) => a.status === 'active');

  return (
    <div className="dash">
      <header className="pagehead"><h1>My money</h1><span className="fine">Sample data in a sandbox</span></header>

      <section className="balances" aria-label="Balances">
        {balList.map((b) => (
          <div key={b.currency} className="card bal">
            <span className="balabel">{b.label}</span>
            <span className="balamt">{b.symbol}{b.amount.toLocaleString('en-IN', { minimumFractionDigits: b.currency === 'MYR' ? 2 : 0 })}</span>
            <span className="fine">{b.currency}</span>
          </div>
        ))}
        <div className="card bal">
          <span className="balabel">Next payment due</span>
          <span className="balamt">25 Oct</span>
          <span className="fine">Tuition, University of Malaya (sample)</span>
        </div>
      </section>

      <section className="card fxpanel" aria-label="Exchange rate">
        <header className="panelhead">
          <h2>Taka per ringgit, last 30 days</h2>
          <span className="fine">Not a forecast</span>
        </header>
        <FxChart series={series} target={active?.target} />
        <div className="stats">
          <div><span className="fine">Today</span><strong>৳{now.toFixed(2)}</strong></div>
          <div><span className="fine">30-day low</span><strong>৳{lo.toFixed(2)}</strong></div>
          <div><span className="fine">30-day high</span><strong>৳{hi.toFixed(2)}</strong></div>
          <div><span className="fine">30-day average</span><strong>৳{avg.toFixed(2)}</strong></div>
        </div>
        <div className="range" role="img" aria-label={`Today's rate sits at ${pos} percent of the 30-day range`}>
          <div className="rangebar"><span className="marker" style={{ left: `${pos}%` }} /></div>
          <div className="rangelbl"><span>Lower</span><span>Higher</span></div>
        </div>
      </section>

      <div className="twocol">
        <section className="card" aria-label="Rate alerts">
          <h2>Rate alerts</h2>
          {alertList.length === 0
            ? <p className="empty">No alerts yet. Ask the assistant when to convert and it can set one up for you.</p>
            : <ul className="plain">{alertList.map((a) => (<li key={a.id}><strong>{a.pair} reaches {a.target.toFixed(2)}</strong><span className="fine">Fallback {a.fallbackDate}. {a.status === 'active' ? 'On' : 'Waiting for you'}</span></li>))}</ul>}
        </section>
        <section className="card" aria-label="Documents">
          <h2>Documents on file</h2>
          <ul className="plain">
            {docList.map((d) => (<li key={d.name} className="docrow"><span className={'tick' + (d.done ? ' ok' : '')} aria-hidden="true">{d.done ? '✓' : '○'}</span>{d.name}<span className="fine">{d.done ? 'Verified' : 'Needed'}</span></li>))}
          </ul>
        </section>
      </div>

      <section className="card" aria-label="Recent payments">
        <h2>Recent payments</h2>
        <div className="tablewrap">
          <table>
            <thead><tr><th scope="col">Date</th><th scope="col">To</th><th scope="col" className="num">Amount</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {transferList.map((t) => (<tr key={t.id}><td>{t.date}</td><td>{t.recipient}</td><td className="num">{fmtBDT(t.amountBDT)}</td><td>{t.status}</td></tr>))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
