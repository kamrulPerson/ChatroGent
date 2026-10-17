import type { Proposal } from '../types';
import { fmtBDT, fmtMoney, ruleStatusLabel } from '../format';
import TierBadge from './TierBadge';

interface Props {
  proposal: Proposal;
  onConfirm: () => void;
  onCancel: () => void;
  disabled: boolean;
}

export default function ConfirmCard({ proposal, onConfirm, onCancel, disabled }: Props) {
  const p = proposal;
  const pending = p.status === 'pending';
  const receive = p.route.net == null ? 'No quote' : fmtMoney(p.route.net, p.route.currency);
  return (
    <section className="card confirm" aria-label="Payment confirmation">
      <header className="confirmhead">
        <h3>Confirm this payment</h3>
        <TierBadge tier="T3" />
      </header>
      <dl className="facts">
        <div><dt>You send</dt><dd>{fmtBDT(p.amountBDT)}</dd></div>
        <div><dt>To</dt><dd>{p.recipient}</dd></div>
        <div><dt>Route</dt><dd>{p.route.name}</dd></div>
        <div><dt>Fee</dt><dd>{fmtBDT(p.route.feeBDT)}</dd></div>
        <div><dt>They receive</dt><dd className="strong">{receive}</dd></div>
        <div><dt>Arrives in</dt><dd>{p.route.etaDays} {p.route.etaDays === 1 ? 'day' : 'days'}</dd></div>
      </dl>
      {p.rules ? (
        <ul className="checks">
          {p.rules.map((r) => {
            const s = ruleStatusLabel(r);
            return (
              <li key={r.ruleId} className={'rule ' + s.tone}>
                <span aria-hidden="true">{s.mark}</span> <code>{r.ruleId}</code> {s.label}
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="checks">
          {p.checks.map((c) => (<li key={c}><span aria-hidden="true">✓</span> {c}</li>))}
        </ul>
      )}
      {p.hash && (
        <p className="fine">
          Approval hash <code>{p.hash.slice(0, 16)}…</code>. The confirmation is single-use and bound to this exact proposal.
        </p>
      )}
      {pending ? (
        <div className="actions">
          <button className="btn ghost" onClick={onCancel} disabled={disabled}>Cancel</button>
          <button className="btn primary" onClick={onConfirm} disabled={disabled}>Confirm payment</button>
        </div>
      ) : (
        <p className={'status ' + p.status}>
          {p.status === 'confirmed' ? 'Confirmed by you' : p.status === 'failed' ? 'Payment failed and was refunded' : 'Cancelled'}
        </p>
      )}
      <p className="fine">Sandbox payment. Your approval is valid for this exact amount and recipient only.</p>
    </section>
  );
}
