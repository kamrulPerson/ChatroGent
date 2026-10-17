interface Props { series: number[]; target?: number }

export default function FxChart({ series, target }: Props) {
  const W = 640, H = 210, padL = 44, padR = 12, padT = 14, padB = 30;
  const lo = Math.min(...series, target ?? Infinity) - 0.1;
  const hi = Math.max(...series, target ?? -Infinity) + 0.1;
  const x = (i: number) => padL + (i * (W - padL - padR)) / (series.length - 1);
  const y = (v: number) => padT + ((hi - v) * (H - padT - padB)) / (hi - lo);
  const avg = series.reduce((a, b) => a + b, 0) / series.length;
  const path = series.map((v, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
  const last = series[series.length - 1];
  return (
    <svg className="fx" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Taka per ringgit over the last 30 days. Now ${last.toFixed(2)}, average ${avg.toFixed(2)}.`}>
      <line className="axis" x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} />
      <line className="avgline" x1={padL} y1={y(avg)} x2={W - padR} y2={y(avg)} />
      <text className="lbl" x={padL - 6} y={y(avg) + 4} textAnchor="end">{avg.toFixed(1)}</text>
      {target !== undefined && (
        <g>
          <line className="targetline" x1={padL} y1={y(target)} x2={W - padR} y2={y(target)} />
          <text className="lbl amber" x={W - padR} y={y(target) - 5} textAnchor="end">Target {target.toFixed(2)}</text>
        </g>
      )}
      <path className="fxline" d={path} />
      <circle className="fxdot" cx={x(series.length - 1)} cy={y(last)} r="4" />
      <text className="lbl" x={padL} y={H - 8}>30 days ago</text>
      <text className="lbl" x={W - padR} y={H - 8} textAnchor="end">Today</text>
    </svg>
  );
}
