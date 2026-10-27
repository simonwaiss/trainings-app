import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import {
  addExerciseToWorkout,
  addSet,
  deleteWorkout,
  finishWorkout,
  moveWorkoutExercise,
  prevFor,
  previousSets,
  removeLastSet,
  removeWorkoutExercise,
  updateSet,
} from '../data/ops';
import { db, nowIso, patch } from '../db/local';
import type { Workout, WorkoutExercise, WSet } from '../db/types';
import { ExercisePicker } from './ExercisePicker';
import { startRest } from './RestTimer';
import { fmtDate, fmtDuration, fmtKg, fmtTime, go, NumInput, settings, useNow } from './util';

const alive = <T extends { deleted_at: string | null }>(r: T) => !r.deleted_at;

export function WorkoutView({ id }: { id: string }) {
  const workout = useLiveQuery(() => db.workouts.get(id), [id]);
  const wes = useLiveQuery(
    async () =>
      (await db.workout_exercises.where('workout_id').equals(id).toArray())
        .filter(alive)
        .sort((a, b) => a.position - b.position),
    [id],
  );
  const [picking, setPicking] = useState(false);

  if (workout === undefined || wes === undefined) return <p className="muted">Lädt …</p>;
  if (!workout || workout.deleted_at) {
    return (
      <div className="card">
        Dieses Training gibt es nicht (mehr). <button className="link" onClick={() => go('/')}>Zur Übersicht</button>
      </div>
    );
  }
  const active = !workout.finished_at;

  return (
    <>
      <div className="topbar">
        <h1>{workout.name}</h1>
        {active ? (
          <button
            className="btn primary small"
            onClick={async () => {
              if (confirm('Training beenden? Sätze ohne Werte werden entfernt.')) {
                await finishWorkout(workout.id);
                go(`/training/${workout.id}`);
              }
            }}
          >
            Beenden
          </button>
        ) : null}
      </div>
      <WorkoutMeta workout={workout} />

      {wes.map((we, i) => (
        <ExerciseBlock key={we.id} we={we} workout={workout} first={i === 0} last={i === wes.length - 1} />
      ))}

      <button className="btn block" onClick={() => setPicking(true)} style={{ marginTop: 8 }}>
        + Übung hinzufügen
      </button>

      <label className="field">
        <span>Notiz zum Training</span>
        <textarea
          className="text"
          rows={2}
          defaultValue={workout.note ?? ''}
          onBlur={(e) => {
            const v = e.target.value.trim() || null;
            if (v !== workout.note) void patch('workouts', workout.id, { note: v });
          }}
        />
      </label>

      <button
        className="btn danger block"
        onClick={async () => {
          if (confirm(active ? 'Training verwerfen?' : 'Training löschen?')) {
            await deleteWorkout(workout.id);
            go(active ? '/' : '/verlauf');
          }
        }}
      >
        {active ? 'Training verwerfen' : 'Training löschen'}
      </button>

      {picking && (
        <ExercisePicker
          title="Übung hinzufügen"
          onClose={() => setPicking(false)}
          onPick={async (exerciseId) => {
            setPicking(false);
            await addExerciseToWorkout(workout.id, exerciseId);
          }}
        />
      )}
    </>
  );
}

function WorkoutMeta({ workout }: { workout: Workout }) {
  const now = useNow(1000);
  const end = workout.finished_at ? Date.parse(workout.finished_at) : now;
  return (
    <p className="muted small" style={{ margin: '0 0 4px' }}>
      {fmtDate(workout.started_at)}, {fmtTime(workout.started_at)} · {fmtDuration((end - Date.parse(workout.started_at)) / 1000)}
      {workout.source === 'strong' ? ' · aus Strong' : ''}
      {workout.finished_at ? ' · beendet' : ''}
    </p>
  );
}

function ExerciseBlock(props: { we: WorkoutExercise; workout: Workout; first: boolean; last: boolean }) {
  const { we, workout } = props;
  const exercise = useLiveQuery(() => db.exercises.get(we.exercise_id), [we.exercise_id]);
  const sets = useLiveQuery(
    async () =>
      (await db.sets.where('workout_exercise_id').equals(we.id).toArray())
        .filter(alive)
        .sort((a, b) => a.position - b.position || (a.side ?? '').localeCompare(b.side ?? '')),
    [we.id],
  );
  const prev = useLiveQuery(() => previousSets(we, workout), [we.id, we.position, workout.started_at]);
  const [menu, setMenu] = useState(false);

  if (!exercise || !sets) return null;

  const toggleDone = async (s: WSet) => {
    if (s.done_at) {
      await updateSet(s.id, { done_at: null });
      return;
    }
    const p = prev ? prevFor(prev, s.position, s.side) : undefined;
    await updateSet(s.id, {
      done_at: nowIso(),
      weight_kg: s.weight_kg ?? p?.weight_kg ?? null,
      reps: s.reps ?? p?.reps ?? null,
    });
    // Bei einarmigen Übungen startet die Pause erst nach der rechten Seite.
    if (!workout.finished_at && s.side !== 'L') startRest(exercise.rest_seconds ?? settings.restSeconds);
  };

  return (
    <section className="card" aria-label={exercise.name}>
      <div className="ex-head">
        <h3>
          <button onClick={() => go(`/uebung/${exercise.id}`)}>{exercise.name}</button>
        </h3>
        <button className="icon-btn" aria-label="Übung bearbeiten" onClick={() => setMenu(!menu)}>
          ⋯
        </button>
      </div>
      {we.note && <p className="note">{we.note}</p>}
      {menu && (
        <div className="row wrap" style={{ margin: '6px 0' }}>
          <button className="btn small" disabled={props.first} onClick={() => moveWorkoutExercise(workout.id, we.id, -1)}>
            ↑ nach oben
          </button>
          <button className="btn small" disabled={props.last} onClick={() => moveWorkoutExercise(workout.id, we.id, 1)}>
            ↓ nach unten
          </button>
          <button
            className="btn small danger"
            onClick={async () => {
              if (confirm(`${exercise.name} aus diesem Training entfernen?`)) await removeWorkoutExercise(we.id);
            }}
          >
            Entfernen
          </button>
        </div>
      )}
      <table className="sets">
        <thead>
          <tr>
            <th>Satz</th>
            <th>Vorher</th>
            <th>kg</th>
            <th>Wdh.</th>
            <th aria-label="erledigt">✓</th>
          </tr>
        </thead>
        <tbody>
          {sets.map((s) => {
            const p = prev ? prevFor(prev, s.position, s.side) : undefined;
            const label = `${s.position}${s.side ? ` ${s.side}` : ''}`;
            return (
              <tr key={s.id} className={s.done_at ? 'done' : ''}>
                <td className="setno">{s.kind === 'warmup' ? 'A' : label}</td>
                <td>
                  <button
                    className="prev"
                    aria-label={`Vorwert für Satz ${label} übernehmen`}
                    disabled={!p}
                    onClick={() => p && updateSet(s.id, { weight_kg: p.weight_kg, reps: p.reps })}
                  >
                    {p ? `${fmtKg(p.weight_kg) || '–'} × ${p.reps ?? '–'}` : '–'}
                  </button>
                </td>
                <td>
                  <NumInput
                    label={`kg Satz ${label}`}
                    decimal
                    value={s.weight_kg}
                    placeholder={fmtKg(p?.weight_kg)}
                    onCommit={(n) => updateSet(s.id, { weight_kg: n })}
                  />
                </td>
                <td>
                  <NumInput
                    label={`Wiederholungen Satz ${label}`}
                    value={s.reps}
                    placeholder={p?.reps != null ? String(p.reps) : ''}
                    onCommit={(n) => updateSet(s.id, { reps: n })}
                  />
                </td>
                <td>
                  <button
                    className={`check${s.done_at ? ' on' : ''}`}
                    aria-label={`Satz ${label} erledigt`}
                    aria-pressed={!!s.done_at}
                    onClick={() => toggleDone(s)}
                  >
                    ✓
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row">
        <button className="btn small grow" onClick={() => addSet(we.id)}>
          + Satz
        </button>
        <button className="btn small" disabled={sets.length === 0} onClick={() => removeLastSet(we.id)} aria-label="Letzten Satz entfernen">
          − Satz
        </button>
      </div>
    </section>
  );
}
