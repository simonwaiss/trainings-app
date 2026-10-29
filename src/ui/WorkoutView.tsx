import { useLiveQuery } from 'dexie-react-hooks';
import { Fragment, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import {
  addExerciseToWorkout,
  addSet,
  applyWorkoutToTemplate,
  deleteWorkout,
  finishWorkout,
  moveWorkoutExercise,
  prevFor,
  previousSets,
  recordSetIds,
  removeLastSet,
  removeSet,
  removeWorkoutExercise,
  replaceWorkoutExercise,
  saveWorkoutAsTemplate,
  setKind,
  templateChanges,
  updateSet,
  workoutSummary,
  workRanks,
  type PrevSet,
  type TemplateChange,
} from '../data/ops';
import { db, nowIso, patch } from '../db/local';
import type { SetKind, Workout, WorkoutExercise, WSet } from '../db/types';
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
  const [ending, setEnding] = useState<TemplateChange | null>(null);

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
                setEnding(await templateChanges(workout.id));
              }
            }}
          >
            Beenden
          </button>
        ) : null}
      </div>
      <WorkoutMeta workout={workout} />
      {!active && <Summary workout={workout} />}

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
      {ending && <EndDialog workout={workout} change={ending} onClose={() => setEnding(null)} />}
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

// Zusammenfassung über einem beendeten Training.
function Summary({ workout }: { workout: Workout }) {
  const sum = useLiveQuery(() => workoutSummary(workout.id), [workout.id]);
  if (!sum) return null;
  const seconds = (Date.parse(workout.finished_at!) - Date.parse(workout.started_at)) / 1000;
  return (
    <section className="card summary" aria-label="Zusammenfassung">
      <div className="stats">
        <div>
          <strong>{fmtDuration(seconds)}</strong>
          <span>Dauer</span>
        </div>
        <div>
          <strong>{sum.sets}</strong>
          <span>Sätze</span>
        </div>
        <div>
          <strong>{Math.round(sum.volume).toLocaleString('de-DE')} kg</strong>
          <span>bewegt</span>
        </div>
      </div>
      {sum.records.map((r) => (
        <p key={r.exercise} className="record-line">
          🏆 Neuer Rekord: {r.exercise}, {fmtKg(r.weight_kg)} × {r.reps}
        </p>
      ))}
    </section>
  );
}

// Nach dem Beenden: Gilt die Änderung nur für dieses Training oder auch für den Trainingstag?
function EndDialog({ workout, change, onClose }: { workout: Workout; change: TemplateChange; onClose: () => void }) {
  const t = change.template;
  const [naming, setNaming] = useState(!t);
  const [name, setName] = useState(t ? `${t.name} (neu)` : workout.name === 'Freies Training' ? '' : workout.name);
  const title = t ? `${t.name} geändert` : 'Als Trainingstag speichern?';

  const saveNew = async () => {
    if (!name.trim()) return;
    await saveWorkoutAsTemplate(workout.id, name);
    onClose();
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '4px 0 8px', fontSize: 18 }}>{title}</h2>
        {t ? (
          <>
            <ul className="changes">
              {change.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <p className="muted small">Gewichte und Wiederholungen merkt sich die App ohnehin als Vorwerte.</p>
          </>
        ) : (
          <p className="muted small">Dann kannst du dieses Training später mit einem Tipp wieder starten.</p>
        )}
        {naming ? (
          <>
            <label className="field">
              <span>Name des Trainingstags</span>
              <input className="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn grow" onClick={t ? () => setNaming(false) : onClose}>
                {t ? 'Zurück' : 'Nein danke'}
              </button>
              <button className="btn primary grow" disabled={!name.trim()} onClick={saveNew}>
                Speichern
              </button>
            </div>
          </>
        ) : (
          <div className="stack">
            <button className="btn primary block" onClick={onClose}>
              Nur dieses Training
            </button>
            <button
              className={`btn block${change.removes ? ' danger' : ''}`}
              onClick={async () => {
                await applyWorkoutToTemplate(workout.id);
                onClose();
              }}
            >
              {t!.name} ändern
            </button>
            <button className="btn block" onClick={() => setNaming(true)}>
              Als neuen Trainingstag speichern
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const KINDS: { kind: SetKind; label: string }[] = [
  { kind: 'normal', label: 'Normal' },
  { kind: 'warmup', label: 'Aufwärmen' },
  { kind: 'drop', label: 'Drop-Satz' },
  { kind: 'failure', label: 'Bis Versagen' },
];
const KIND_MARK: Record<SetKind, string> = { normal: '', warmup: 'A', drop: 'D', failure: 'V' };

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
  const prev = useLiveQuery(() => previousSets(we, workout), [we.id, we.exercise_id, we.position, workout.started_at]);
  const records = useLiveQuery(() => recordSetIds(workout, we.exercise_id), [workout.id, workout.started_at, we.exercise_id]);
  const [menu, setMenu] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [editNote, setEditNote] = useState(false);
  // Offene Leiste unter einer Satznummer: Satz-Typ wählen oder Entfernen bestätigen.
  const [tools, setTools] = useState<{ position: number; mode: 'menu' | 'delete' } | null>(null);

  if (!exercise || !sets) return null;

  const ranks = workRanks(sets);
  const prevOf = (s: WSet): PrevSet | undefined => {
    const rank = ranks.get(s.position);
    return prev && rank ? prevFor(prev, rank, s.side) : undefined;
  };
  // Nummer für Vorlesen und Tests: Arbeitssätze zählen 1, 2, …; Aufwärmsätze heißen A1, A2, …
  const labelOf = (s: WSet) => {
    const rank = ranks.get(s.position);
    return `${rank ?? `A${s.position}`}${s.side ? ` ${s.side}` : ''}`;
  };
  const markOf = (s: WSet) => `${KIND_MARK[s.kind] || ranks.get(s.position)}${s.side ? ` ${s.side}` : ''}`;
  const lastOfPosition = (s: WSet, i: number) => sets[i + 1]?.position !== s.position;

  const toggleDone = async (s: WSet) => {
    if (s.done_at) {
      await updateSet(s.id, { done_at: null });
      return;
    }
    const p = prevOf(s);
    await updateSet(s.id, {
      done_at: nowIso(),
      weight_kg: s.weight_kg ?? p?.weight_kg ?? null,
      reps: s.reps ?? p?.reps ?? null,
    });
    // Bei einarmigen Übungen startet die Pause erst nach der rechten Seite.
    if (!workout.finished_at && s.side !== 'L') startRest(exercise.rest_seconds ?? settings.restSeconds);
  };

  const toolsRow = (position: number) => {
    if (tools?.position !== position) return null;
    const first = sets.find((s) => s.position === position)!;
    const withValues = sets.filter((s) => s.position === position).find((s) => s.weight_kg != null || s.reps != null);
    const name = ranks.get(position) ? `Satz ${ranks.get(position)}` : 'Aufwärmsatz';
    return (
      <tr className="set-tools">
        <td colSpan={5}>
          {tools.mode === 'menu' ? (
            <div className="row wrap">
              <div className="seg" role="group" aria-label={`Typ von ${name}`}>
                {KINDS.map((k) => (
                  <button
                    key={k.kind}
                    className={first.kind === k.kind ? 'on' : ''}
                    aria-pressed={first.kind === k.kind}
                    onClick={async () => {
                      await setKind(we.id, position, k.kind);
                      setTools(null);
                    }}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <button className="btn small danger" onClick={() => setTools({ position, mode: 'delete' })}>
                Entfernen
              </button>
            </div>
          ) : (
            <div className="row">
              <span className="grow small">
                {name}
                {withValues ? ` (${fmtKg(withValues.weight_kg) || '–'} × ${withValues.reps ?? '–'})` : ''} entfernen?
              </span>
              <button className="btn small" onClick={() => setTools(null)}>
                Abbrechen
              </button>
              <button
                className="btn small delete"
                onClick={async () => {
                  setTools(null);
                  await removeSet(we.id, position);
                }}
              >
                Entfernen
              </button>
            </div>
          )}
        </td>
      </tr>
    );
  };

  return (
    <section className="card" aria-label={exercise.name}>
      <div className="ex-head">
        <h3>
          <a href={`#/uebung/${exercise.id}`}>{exercise.name}</a>
        </h3>
        <button className="icon-btn" aria-label="Übung bearbeiten" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          ⋯
        </button>
      </div>
      {editNote ? (
        <textarea
          className="text pin-edit"
          rows={2}
          autoFocus
          aria-label={`Dauerhafte Notiz zu ${exercise.name}`}
          placeholder="z. B. Sitz auf Stufe 4 – steht bei jedem Training hier"
          defaultValue={exercise.note ?? ''}
          onBlur={(e) => {
            const v = e.target.value.trim() || null;
            if (v !== exercise.note) void patch('exercises', exercise.id, { note: v });
            setEditNote(false);
          }}
        />
      ) : (
        exercise.note && (
          <button className="pin" aria-label={`Dauerhafte Notiz: ${exercise.note}`} onClick={() => setEditNote(true)}>
            📌 {exercise.note}
          </button>
        )
      )}
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
            className="btn small"
            onClick={() => {
              setMenu(false);
              setSwapping(true);
            }}
          >
            Tauschen
          </button>
          <button
            className="btn small"
            onClick={() => {
              setMenu(false);
              setEditNote(true);
            }}
          >
            Notiz
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
          {sets.map((s, i) => {
            const p = prevOf(s);
            const label = labelOf(s);
            return (
              <Fragment key={s.id}>
                <SetRow
                  done={!!s.done_at}
                  open={tools?.position === s.position}
                  onSwipe={() => setTools({ position: s.position, mode: 'delete' })}
                >
                  <td className="setno">
                    <button
                      className={`setno-btn kind-${s.kind}`}
                      aria-label={`Satz ${label}: Typ oder entfernen`}
                      onClick={() => setTools(tools?.position === s.position ? null : { position: s.position, mode: 'menu' })}
                    >
                      {markOf(s)}
                      {records?.has(s.id) && (
                        <span className="pr" role="img" aria-label="neuer Rekord">
                          🏆
                        </span>
                      )}
                    </button>
                  </td>
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
                </SetRow>
                {lastOfPosition(s, i) && toolsRow(s.position)}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="row">
        <button className="btn small grow" onClick={() => addSet(we.id)}>
          + Satz
        </button>
        <button
          className="btn small"
          disabled={sets.length === 0}
          aria-label="Letzten Satz entfernen"
          onClick={async () => {
            const last = sets.filter((s) => s.position === sets[sets.length - 1].position);
            if (last.some((s) => s.weight_kg != null || s.reps != null) && !confirm('Letzten Satz mit Werten entfernen?')) return;
            await removeLastSet(we.id);
          }}
        >
          − Satz
        </button>
      </div>
      {swapping && (
        <ExercisePicker
          title={`${exercise.name} tauschen gegen …`}
          onClose={() => setSwapping(false)}
          onPick={async (exerciseId) => {
            setSwapping(false);
            const next = await db.exercises.get(exerciseId);
            const sidesDiffer = !!next && next.unilateral !== exercise.unilateral;
            const hasValues = sets.some((s) => s.weight_kg != null || s.reps != null);
            if (sidesDiffer && hasValues && !confirm('Die neue Übung hat andere Seiten (L/R). Die eingetragenen Sätze werden dabei entfernt.')) return;
            await replaceWorkoutExercise(we.id, exerciseId);
          }}
        />
      )}
    </section>
  );
}

// Eine Satzzeile, die man nach links wischen kann (wie bei Strong): Danach erscheint darunter „Entfernen“.
function SetRow(props: { done: boolean; open: boolean; onSwipe: () => void; children: ReactNode }) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const swiped = useRef(false);
  const [dx, setDx] = useState(0);

  const end = (e: PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (s && s.id === e.pointerId && e.clientX - s.x < -60) {
      swiped.current = true;
      props.onSwipe();
    }
    setDx(0);
  };

  return (
    <tr
      className={`swipe${props.done ? ' done' : ''}${props.open ? ' open' : ''}`}
      style={dx ? { transform: `translateX(${dx}px)` } : undefined}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        swiped.current = false;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const x = e.clientX - s.x;
        const y = e.clientY - s.y;
        if (Math.abs(y) > 12 && Math.abs(y) > Math.abs(x)) {
          // Senkrecht: Das ist Scrollen, kein Wischen.
          start.current = null;
          setDx(0);
          return;
        }
        if (x < -10) {
          // Ab hier gehört die Bewegung dem Wischen, auch wenn der Finger die Zeile verlässt.
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId);
          setDx(Math.max(x, -110));
        } else if (dx) setDx(0);
      }}
      onPointerUp={end}
      onPointerCancel={() => {
        start.current = null;
        setDx(0);
      }}
      onClickCapture={(e) => {
        // Nach einem Wischen soll kein Knopf unter dem Finger ausgelöst werden.
        if (swiped.current) {
          swiped.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {props.children}
    </tr>
  );
}
