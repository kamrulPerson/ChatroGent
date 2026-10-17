import { useEffect, useState } from 'react';
import { useApp } from '../state';
import { api, useMock } from '../api/client';
import type { AuditEvent, Tier } from '../types';
import TierBadge from '../components/TierBadge';

function toTime(ts: unknown): string {
  try {
    return new Date(ts as string).toLocaleTimeString();
  } catch {
    return '';
  }
}

export default function AuditPage() {
  const { audit } = useApp();
  const [rows, setRows] = useState<AuditEvent[] | null>(null);

  useEffect(() => {
    if (useMock) return;
    api
      .audit()
      .then((list) =>
        setRows(
          (list as any[]).map((a) => ({
            id: String(a._id),
            time: toTime(a.ts),
            event: a.decision && a.decision !== 'n/a' ? `${a.event} (${a.decision})` : a.event,
            tool: a.tool,
            tier: (a.tier || 'SYS') as Tier | 'SYS',
            outcome: a.outcome || '',
          })),
        ),
      )
      .catch(() => {});
  }, []);

  const list = rows ?? audit;

  return (
    <div className="dash">
      <header className="pagehead"><h1>Activity log</h1><span className="fine">Everything the assistant did on your behalf</span></header>
      <section className="card" aria-label="Audit trail">
        <div className="tablewrap">
          <table>
            <thead><tr><th scope="col">Time</th><th scope="col">What happened</th><th scope="col">Tool</th><th scope="col">Level</th><th scope="col">Result</th></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">{a.time}</td>
                  <td>{a.event}</td>
                  <td>{a.tool ? <code>{a.tool}</code> : <span className="fine">None</span>}</td>
                  <td><TierBadge tier={a.tier} /></td>
                  <td>{a.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine">This log is append-only. You can read it but not edit it.</p>
      </section>
    </div>
  );
}
