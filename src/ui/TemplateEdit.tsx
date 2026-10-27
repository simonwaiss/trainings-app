import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { addExerciseToTemplate, duplicateTemplate, moveTemplateExercise } from '../data/ops';
import { LIMITS } from '../db/limits';
import { db, patch, softDelete } from '../db/local';
import { ExercisePicker } from './ExercisePicker';
import { go } from './util';

const alive = <T extends { deleted_at: string | null }>(r: T) => !r.deleted_at;

export function TemplateEdit({ id }: { id: string }) {
  const template = useLiveQuery(() => db.templates.get(id), [id]);
  const links = useLiveQuery(async () => {
    const list = (await db.template_exercises.where('template_id').equals(id).toArray())
      .filter(alive)
      .sort((a, b) => a.position - b.position);
    const exercises = await db.exercises.bulkGet(list.map((l) => l.exercise_id));
    return list.map((l, i) => ({ link: l, exercise: exercises[i] }));
  }, [id]);
  const [picking, setPicking] = useState(false);

  if (template === undefined || links === undefined) return <p className="muted">Lädt …</p>;
  if (!template || template.deleted_at) return <p>Diesen Trainingstag gibt es nicht (mehr).</p>;

  return (
    <>
      <div className="topbar">
        <button className="link" onClick={() => go('/')}>
          ‹ Training
        </button>
      </div>
      <label className="field">
        <span>Name des Trainingstags</span>
        <input
          className="text"
          defaultValue={template.name}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== template.name) void patch('templates', template.id, { name: v });
          }}
        />
      </label>

      {links.map(({ link, exercise }, i) => (
        <div key={link.id} className="card">
          <div className="row">
            <div className="grow">
              <strong>{exercise?.name ?? '?'}</strong>
              {exercise?.unilateral && <span className="muted small"> · je Seite</span>}
              {link.note && <div className="note">{link.note}</div>}
            </div>
          </div>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <span className="muted small">Sätze</span>
            <button
              className="btn small"
              aria-label="Ein Satz weniger"
              disabled={link.sets <= 1}
              onClick={() => patch('template_exercises', link.id, { sets: link.sets - 1 })}
            >
              −
            </button>
            <strong aria-label="Sätze">{link.sets}</strong>
            <button
              className="btn small"
              aria-label="Ein Satz mehr"
              disabled={link.sets >= LIMITS.templateSets.max}
              onClick={() => patch('template_exercises', link.id, { sets: link.sets + 1 })}
            >
              +
            </button>
            <span className="grow" />
            <button className="icon-btn" aria-label="nach oben" disabled={i === 0} onClick={() => moveTemplateExercise(id, link.id, -1)}>
              ↑
            </button>
            <button
              className="icon-btn"
              aria-label="nach unten"
              disabled={i === links.length - 1}
              onClick={() => moveTemplateExercise(id, link.id, 1)}
            >
              ↓
            </button>
            <button
              className="icon-btn"
              aria-label="aus dem Trainingstag entfernen"
              onClick={() => {
                if (confirm(`${exercise?.name} aus ${template.name} entfernen?`)) void softDelete('template_exercises', link.id);
              }}
            >
              ✕
            </button>
          </div>
          <input
            className="text small"
            style={{ marginTop: 6, minHeight: 36 }}
            placeholder="Hinweis (optional)"
            aria-label="Hinweis"
            defaultValue={link.note ?? ''}
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== link.note) void patch('template_exercises', link.id, { note: v });
            }}
          />
        </div>
      ))}

      <button className="btn block" onClick={() => setPicking(true)}>
        + Übung hinzufügen
      </button>
      <div className="row" style={{ marginTop: 16 }}>
        <button
          className="btn grow"
          onClick={async () => {
            const copy = await duplicateTemplate(id);
            if (copy) go(`/tag/${copy}`);
          }}
        >
          Duplizieren
        </button>
        <button
          className="btn danger grow"
          onClick={async () => {
            if (confirm(`Trainingstag „${template.name}“ löschen? Vergangene Trainings bleiben erhalten.`)) {
              await softDelete('templates', id);
              go('/');
            }
          }}
        >
          Löschen
        </button>
      </div>

      {picking && (
        <ExercisePicker
          title={`Übung zu ${template.name}`}
          onClose={() => setPicking(false)}
          onPick={async (exerciseId) => {
            setPicking(false);
            await addExerciseToTemplate(id, exerciseId);
          }}
        />
      )}
    </>
  );
}
