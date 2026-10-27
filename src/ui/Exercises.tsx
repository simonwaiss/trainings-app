import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { createExercise, exerciseHistory } from '../data/ops';
import { db, patch, softDelete } from '../db/local';
import { LineChart } from './Chart';
import { fmtDate, fmtKg, go, NumInput, settings } from './util';

export function Exercises() {
  const [q, setQ] = useState('');
  const exercises = useLiveQuery(
    async () => (await db.exercises.toArray()).filter((e) => !e.deleted_at).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [],
  );
  if (!exercises) return <p className="muted">Lädt …</p>;
  const hits = exercises.filter((e) => e.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="topbar">
        <h1>Übungen</h1>
        <button
          className="btn small"
          onClick={async () => {
            const name = prompt('Name der neuen Übung');
            if (!name?.trim()) return;
            const unilateral = confirm('Einarmig bzw. einbeinig (Sätze je Seite)?');
            go(`/uebung/${await createExercise(name, unilateral)}`);
          }}
        >
          + Neu
        </button>
      </div>
      <input className="text" placeholder="Suchen" aria-label="Übung suchen" value={q} onChange={(e) => setQ(e.target.value)} />
      {hits.map((e) => (
        <button key={e.id} className="list-item" onClick={() => go(`/uebung/${e.id}`)}>
          <span className="grow">{e.name}</span>
          {e.unilateral && <span className="muted small">L/R</span>}
          <span aria-hidden>›</span>
        </button>
      ))}
    </>
  );
}

type Metric = 'e1rm' | 'top' | 'volume';
const METRICS: Record<Metric, { label: string; unit: string }> = {
  e1rm: { label: 'Geschätztes Maximum (1 Wdh.)', unit: 'kg' },
  top: { label: 'Schwerster Satz', unit: 'kg' },
  volume: { label: 'Volumen (kg × Wdh.)', unit: 'kg' },
};

export function ExerciseDetail({ id }: { id: string }) {
  const exercise = useLiveQuery(() => db.exercises.get(id), [id]);
  const hist = useLiveQuery(() => exerciseHistory(id), [id]);
  const [metric, setMetric] = useState<Metric>('e1rm');

  if (exercise === undefined || hist === undefined) return <p className="muted">Lädt …</p>;
  if (!exercise) return <p>Diese Übung gibt es nicht.</p>;

  const points = hist
    .map((h) => ({
      date: h.date,
      value: metric === 'e1rm' ? h.bestE1rm : metric === 'top' ? h.topWeight : h.volume,
    }))
    .filter((p): p is { date: string; value: number } => p.value != null && p.value > 0);

  return (
    <>
      <div className="topbar">
        <button className="link" onClick={() => window.history.back()}>
          ‹ Zurück
        </button>
      </div>
      <h1 style={{ fontSize: 22, margin: '4px 0' }}>{exercise.name}</h1>

      <div className="card">
        <div className="row wrap" style={{ marginBottom: 6 }}>
          <h2 className="grow" style={{ fontSize: 15 }}>
            {METRICS[metric].label}
          </h2>
          <div className="seg" role="group" aria-label="Messgröße">
            {(Object.keys(METRICS) as Metric[]).map((m) => (
              <button key={m} className={m === metric ? 'on' : ''} aria-pressed={m === metric} onClick={() => setMetric(m)}>
                {m === 'e1rm' ? 'Max' : m === 'top' ? 'Gewicht' : 'Volumen'}
              </button>
            ))}
          </div>
        </div>
        <LineChart points={points} unit={METRICS[metric].unit} label={METRICS[metric].label} />
      </div>

      <div className="card">
        <h2>Einstellungen</h2>
        <label className="field">
          <span>Name</span>
          <input
            className="text"
            defaultValue={exercise.name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== exercise.name) void patch('exercises', id, { name: v });
            }}
          />
        </label>
        <label className="row" style={{ minHeight: 44 }}>
          <input type="checkbox" checked={exercise.unilateral} onChange={(e) => patch('exercises', id, { unilateral: e.target.checked })} />
          einarmig / einbeinig (Sätze je Seite)
        </label>
        <label className="field">
          <span>Pause in Sekunden (leer = Standard {settings.restSeconds})</span>
          <NumInput label="Pause in Sekunden" value={exercise.rest_seconds} onCommit={(n) => patch('exercises', id, { rest_seconds: n })} />
        </label>
        <label className="field">
          <span>Notiz</span>
          <textarea
            className="text"
            rows={2}
            defaultValue={exercise.note ?? ''}
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== exercise.note) void patch('exercises', id, { note: v });
            }}
          />
        </label>
        <button
          className="btn danger small"
          onClick={async () => {
            if (confirm(`„${exercise.name}“ ausblenden? Vergangene Sätze bleiben erhalten.`)) {
              await softDelete('exercises', id);
              go('/uebungen');
            }
          }}
        >
          Übung ausblenden
        </button>
      </div>

      <div className="card">
        <h2>Verlauf</h2>
        {hist.length === 0 && <p className="muted small">Noch nicht trainiert.</p>}
        <table className="plain">
          <tbody>
            {[...hist].reverse().slice(0, 40).map((h) => (
              <tr key={h.workoutId} onClick={() => go(`/training/${h.workoutId}`)} style={{ cursor: 'pointer' }}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(h.date)}</td>
                <td>
                  {h.sets
                    .filter((s) => s.kind !== 'warmup')
                    .map((s) => `${s.side ? `${s.side} ` : ''}${fmtKg(s.weight_kg) || '–'}×${s.reps ?? '–'}`)
                    .join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
