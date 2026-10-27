import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../db/local';
import { fmtDate, fmtDuration } from './util';

export function History() {
  const [limit, setLimit] = useState(30);
  const data = useLiveQuery(async () => {
    const all = (await db.workouts.orderBy('started_at').reverse().toArray()).filter((w) => !w.deleted_at && w.finished_at);
    const page = all.slice(0, limit);
    const stats = await Promise.all(
      page.map(async (w) => {
        const sets = (await db.sets.where('workout_id').equals(w.id).toArray()).filter(
          (s) => !s.deleted_at && (s.weight_kg != null || s.reps != null),
        );
        return { sets: sets.length, volume: sets.reduce((v, s) => v + (s.weight_kg ?? 0) * (s.reps ?? 0), 0) };
      }),
    );
    return { total: all.length, items: page.map((w, i) => ({ w, ...stats[i] })) };
  }, [limit]);

  if (!data) return <p className="muted">Lädt …</p>;
  return (
    <>
      <div className="topbar">
        <h1>Verlauf</h1>
        <span className="muted small">{data.total} Trainings</span>
      </div>
      {data.items.length === 0 && <p className="muted">Noch kein beendetes Training.</p>}
      {data.items.map(({ w, sets, volume }) => (
        <a key={w.id} className="list-item" href={`#/training/${w.id}`}>
          <span className="grow">
            <strong>{w.name}</strong>
            <br />
            <span className="muted small">
              {fmtDate(w.started_at)} · {fmtDuration((Date.parse(w.finished_at!) - Date.parse(w.started_at)) / 1000)} · {sets} Sätze ·{' '}
              {Math.round(volume).toLocaleString('de-DE')} kg
              {w.source === 'strong' ? ' · Strong' : ''}
            </span>
          </span>
          <span aria-hidden>›</span>
        </a>
      ))}
      {data.total > limit && (
        <button className="btn block" onClick={() => setLimit(limit + 50)}>
          Ältere zeigen
        </button>
      )}
    </>
  );
}
