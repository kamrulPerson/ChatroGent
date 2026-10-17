import type { ToolStep } from '../types';
import TierBadge from './TierBadge';

const glyph: Record<ToolStep['status'], string> = { pending: '○', running: '◌', done: '✓', blocked: '✕' };

export default function ToolTrace({ steps }: { steps: ToolStep[] }) {
  return (
    <ol className="trace" aria-label="What the assistant did">
      {steps.map((s) => (
        <li key={s.id} className={'step ' + s.status}>
          <span className="glyph" aria-hidden="true">{glyph[s.status]}</span>
          <code className="toolname">{s.tool}</code>
          <TierBadge tier={s.tier} />
          <span className="stepsum">{s.summary}</span>
        </li>
      ))}
    </ol>
  );
}
