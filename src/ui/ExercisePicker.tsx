import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { createExercise } from '../data/ops';
import { db } from '../db/local';

// Auswahl einer Übung, mit Suche und „neu anlegen“.
export function ExercisePicker(props: { title: string; onPick: (exerciseId: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [unilateral, setUnilateral] = useState(false);
  const exercises = useLiveQuery(
    async () => (await db.exercises.toArray()).filter((e) => !e.deleted_at).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [],
  );
  const hits = (exercises ?? []).filter((e) => e.name.toLowerCase().includes(q.trim().toLowerCase()));
  const exact = (exercises ?? []).some((e) => e.name.toLowerCase() === q.trim().toLowerCase());

  return (
    <div className="modal-back" onClick={props.onClose}>
      <div className="modal" role="dialog" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 className="grow" style={{ margin: 0, fontSize: 18 }}>
            {props.title}
          </h2>
          <button className="icon-btn" aria-label="Schließen" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <input
          className="text"
          type="search"
          autoComplete="off"
          placeholder="Suchen oder neuen Namen eingeben …"
          aria-label="Übung suchen"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ margin: '8px 0' }}
        />
        {q.trim() && !exact && (
          <div className="card">
            <div className="row wrap">
              <label className="row grow">
                <input type="checkbox" checked={unilateral} onChange={(e) => setUnilateral(e.target.checked)} />
                einarmig / einbeinig
              </label>
              <button
                className="btn primary small"
                onClick={async () => props.onPick(await createExercise(q, unilateral))}
              >
                „{q.trim()}“ anlegen
              </button>
            </div>
          </div>
        )}
        {hits.map((e) => (
          <button key={e.id} className="list-item" onClick={() => props.onPick(e.id)}>
            <span className="grow">{e.name}</span>
            {e.unilateral && <span className="muted small">L/R</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
