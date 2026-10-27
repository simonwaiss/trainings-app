import { useState } from 'react';
import { fmtShort } from './util';

// Linienchart für eine Messgröße über die Zeit (eine Achse, eine Linie).
// Antippen oder Überfahren zeigt den Wert des nächsten Punkts.
export interface Point {
  date: string;
  value: number;
}

const W = 340;
const H = 190;
const PAD = { l: 38, r: 14, t: 14, b: 24 };

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  const end = Math.ceil(max / step) * step;
  for (let v = Math.floor(min / step) * step; v <= end + step * 0.001; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

const fmtVal = (v: number) =>
  v >= 10000 ? `${(v / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} T` : v.toLocaleString('de-DE', { maximumFractionDigits: 1 });

export { niceTicks };

export function LineChart({ points, unit, label }: { points: Point[]; unit: string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return <p className="muted small">Noch keine Daten für diesen Chart.</p>;

  const t = points.map((p) => Date.parse(p.date));
  const v = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(...v), Math.max(...v));
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const tMin = Math.min(...t);
  const tMax = Math.max(...t);
  const x = (ms: number) => PAD.l + (tMax === tMin ? (W - PAD.l - PAD.r) / 2 : ((ms - tMin) / (tMax - tMin)) * (W - PAD.l - PAD.r));
  const y = (val: number) => PAD.t + (1 - (val - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b);
  const path = points.map((_, i) => `${i ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(v[i]).toFixed(1)}`).join(' ');
  const xLabels = points.length === 1 ? [0] : [0, Math.floor((points.length - 1) / 2), points.length - 1].filter((i, k, a) => a.indexOf(i) === k);
  const last = points.length - 1;
  const h = hover ?? null;

  const nearest = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(t[i]) - px) < Math.abs(x(t[best]) - px)) best = i;
    return best;
  };

  return (
    <figure style={{ margin: 0 }}>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label}: ${points.length} Trainings, zuletzt ${fmtVal(v[last])} ${unit}`}
        onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget))}
        onPointerDown={(e) => setHover(nearest(e.clientX, e.currentTarget))}
        onPointerLeave={() => setHover(null)}
        style={{ touchAction: 'pan-y' }}
      >
        {ticks.map((tk) => (
          <g key={tk}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(tk)} y2={y(tk)} stroke="var(--line)" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(tk) + 4} textAnchor="end">
              {fmtVal(tk)}
            </text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text key={i} x={x(t[i])} y={H - 6} textAnchor={i === 0 && points.length > 1 ? 'start' : i === last && points.length > 1 ? 'end' : 'middle'}>
            {fmtShort(points[i].date)}
          </text>
        ))}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.length <= 60 &&
          points.map((_, i) => <circle key={i} cx={x(t[i])} cy={y(v[i])} r={4} fill="var(--accent)" stroke="var(--card)" strokeWidth={2} />)}
        {h != null && (
          <g>
            <line x1={x(t[h])} x2={x(t[h])} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeWidth={1} />
            <circle cx={x(t[h])} cy={y(v[h])} r={6} fill="var(--accent)" stroke="var(--card)" strokeWidth={2} />
          </g>
        )}
      </svg>
      <figcaption className="small" style={{ minHeight: 20, textAlign: 'center' }}>
        {h != null ? (
          <>
            <strong>
              {fmtVal(v[h])} {unit}
            </strong>{' '}
            <span className="muted">am {fmtShort(points[h].date)}</span>
          </>
        ) : (
          <span className="muted">
            zuletzt {fmtVal(v[last])} {unit} · Antippen für Werte
          </span>
        )}
      </figcaption>
    </figure>
  );
}
