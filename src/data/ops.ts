import { db, nowIso, patch, save, saveMany, softDelete } from '../db/local';
import type { Exercise, SetKind, Side, Template, TemplateExercise, Workout, WorkoutExercise, WSet } from '../db/types';
import { newId, stableId } from '../lib/ids';
import { PLAN } from './plan';

const alive = <T extends { deleted_at: string | null }>(r: T) => !r.deleted_at;

// ---------- Vorbelegung ----------

// Legt den Trainingsplan an, aber nur, wenn noch gar nichts da ist (auch nicht beim Server,
// darum erst nach dem ersten erfolgreichen Abgleich aufrufen). Feste ids verhindern Doppelte.
export async function seedPlanIfEmpty(): Promise<boolean> {
  const counts = await Promise.all([db.exercises.count(), db.templates.count(), db.workouts.count()]);
  if (counts.some((c) => c > 0)) return false;
  const created = nowIso();
  const exercises = new Map<string, Exercise>();
  const templates: Template[] = [];
  const links: TemplateExercise[] = [];
  for (const [ti, t] of PLAN.entries()) {
    const template: Template = {
      id: await stableId('template', t.name),
      name: t.name,
      position: ti,
      note: null,
      created_at: created,
      deleted_at: null,
    };
    templates.push(template);
    for (const [pi, pe] of t.exercises.entries()) {
      let ex = exercises.get(pe.name);
      if (!ex) {
        ex = {
          id: await stableId('exercise', pe.name),
          name: pe.name,
          unilateral: pe.unilateral,
          rest_seconds: null,
          note: null,
          created_at: created,
          deleted_at: null,
        };
        exercises.set(pe.name, ex);
      }
      links.push({
        id: await stableId('template_exercise', `${t.name}#${pi}`),
        template_id: template.id,
        exercise_id: ex.id,
        position: pi,
        sets: pe.sets,
        note: pe.note ?? null,
        created_at: created,
        deleted_at: null,
      });
    }
  }
  await saveMany('exercises', [...exercises.values()]);
  await saveMany('templates', templates);
  await saveMany('template_exercises', links);
  return true;
}

// ---------- Training ----------

function emptySets(we: WorkoutExercise, ex: Exercise, count: number, created: string): WSet[] {
  const sides: (Side | null)[] = ex.unilateral ? ['L', 'R'] : [null];
  const out: WSet[] = [];
  for (let p = 1; p <= count; p++) {
    for (const side of sides) {
      out.push({
        id: newId(),
        workout_id: we.workout_id,
        workout_exercise_id: we.id,
        exercise_id: ex.id,
        position: p,
        side,
        weight_kg: null,
        reps: null,
        kind: 'normal',
        done_at: null,
        rpe: null,
        note: null,
        created_at: created,
        deleted_at: null,
      });
    }
  }
  return out;
}

export async function activeWorkout(): Promise<Workout | undefined> {
  const open = await db.workouts.filter((w) => !w.finished_at && !w.deleted_at).toArray();
  return open.sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
}

export async function startWorkout(templateId: string | null): Promise<string> {
  const created = nowIso();
  const template = templateId ? await db.templates.get(templateId) : undefined;
  const workout: Workout = {
    id: newId(),
    template_id: template?.id ?? null,
    name: template?.name ?? 'Freies Training',
    started_at: created,
    finished_at: null,
    note: null,
    source: 'app',
    created_at: created,
    deleted_at: null,
  };
  const wes: WorkoutExercise[] = [];
  const sets: WSet[] = [];
  if (template) {
    const links = (await db.template_exercises.where('template_id').equals(template.id).toArray())
      .filter(alive)
      .sort((a, b) => a.position - b.position);
    for (const [i, l] of links.entries()) {
      const ex = await db.exercises.get(l.exercise_id);
      if (!ex) continue;
      const we: WorkoutExercise = {
        id: newId(),
        workout_id: workout.id,
        exercise_id: ex.id,
        position: i,
        note: l.note,
        created_at: created,
        deleted_at: null,
      };
      wes.push(we);
      sets.push(...emptySets(we, ex, l.sets, created));
    }
  }
  await save('workouts', workout);
  await saveMany('workout_exercises', wes);
  await saveMany('sets', sets);
  return workout.id;
}

export async function addExerciseToWorkout(workoutId: string, exerciseId: string, setCount = 2) {
  const ex = await db.exercises.get(exerciseId);
  if (!ex) return;
  const existing = (await db.workout_exercises.where('workout_id').equals(workoutId).toArray()).filter(alive);
  const created = nowIso();
  const we: WorkoutExercise = {
    id: newId(),
    workout_id: workoutId,
    exercise_id: exerciseId,
    position: existing.reduce((m, w) => Math.max(m, w.position + 1), 0),
    note: null,
    created_at: created,
    deleted_at: null,
  };
  await save('workout_exercises', we);
  await saveMany('sets', emptySets(we, ex, setCount, created));
}

export async function addSet(weId: string) {
  const we = await db.workout_exercises.get(weId);
  if (!we) return;
  const ex = await db.exercises.get(we.exercise_id);
  if (!ex) return;
  const sets = (await db.sets.where('workout_exercise_id').equals(weId).toArray()).filter(alive);
  const next = sets.reduce((m, s) => Math.max(m, s.position), 0) + 1;
  const created = nowIso();
  const fresh = emptySets(we, ex, 1, created).map((s) => ({ ...s, position: next }));
  await saveMany('sets', fresh);
}

// Entfernt den letzten Satz (bei einarmigen Übungen beide Seiten).
export async function removeLastSet(weId: string) {
  const sets = (await db.sets.where('workout_exercise_id').equals(weId).toArray()).filter(alive);
  const last = sets.reduce((m, s) => Math.max(m, s.position), 0);
  for (const s of sets.filter((x) => x.position === last)) await softDelete('sets', s.id);
}

// Entfernt einen Satz (bei einarmigen Übungen beide Seiten); die Sätze dahinter rücken nach.
export async function removeSet(weId: string, position: number) {
  const sets = (await db.sets.where('workout_exercise_id').equals(weId).toArray()).filter(alive);
  for (const s of sets) {
    if (s.position === position) await softDelete('sets', s.id);
    else if (s.position > position) await patch('sets', s.id, { position: s.position - 1 });
  }
}

// Der Satz-Typ gilt für die ganze Satznummer, bei einarmigen Übungen also für beide Seiten.
export async function setKind(weId: string, position: number, kind: SetKind) {
  const sets = (await db.sets.where('workout_exercise_id').equals(weId).toArray()).filter(alive);
  for (const s of sets.filter((x) => x.position === position && x.kind !== kind)) await patch('sets', s.id, { kind });
}

// Satznummer → Nummer des Arbeitssatzes (Aufwärmsätze zählen nicht mit), so wie die Vorwerte zählen.
export function workRanks(sets: WSet[]): Map<number, number> {
  const positions = [...new Set(sets.filter((s) => s.kind !== 'warmup').map((s) => s.position))].sort((a, b) => a - b);
  return new Map(positions.map((p, i) => [p, i + 1]));
}

// Tauscht die Übung (etwa wenn die Maschine besetzt ist). Passen die Seiten (einarmig/beidarmig)
// nicht zusammen, entstehen gleich viele leere Sätze neu; die alten werden nur als gelöscht markiert.
export async function replaceWorkoutExercise(weId: string, exerciseId: string) {
  const we = await db.workout_exercises.get(weId);
  const ex = await db.exercises.get(exerciseId);
  if (!we || !ex || we.exercise_id === exerciseId) return;
  const old = await db.exercises.get(we.exercise_id);
  const sets = (await db.sets.where('workout_exercise_id').equals(weId).toArray()).filter(alive);
  // Der Hinweis aus dem Trainingstag gehört zur alten Übung.
  await patch('workout_exercises', weId, { exercise_id: exerciseId, note: null });
  if (!!old?.unilateral === ex.unilateral) {
    for (const s of sets) await patch('sets', s.id, { exercise_id: exerciseId });
    return;
  }
  const count = new Set(sets.map((s) => s.position)).size || 1;
  for (const s of sets) await softDelete('sets', s.id);
  await saveMany('sets', emptySets({ ...we, exercise_id: exerciseId }, ex, count, nowIso()));
}

export async function updateSet(id: string, changes: Partial<WSet>) {
  await patch('sets', id, changes);
}

export async function removeWorkoutExercise(weId: string) {
  const sets = (await db.sets.where('workout_exercise_id').equals(weId).toArray()).filter(alive);
  for (const s of sets) await softDelete('sets', s.id);
  await softDelete('workout_exercises', weId);
}

export async function moveWorkoutExercise(workoutId: string, weId: string, dir: -1 | 1) {
  const list = (await db.workout_exercises.where('workout_id').equals(workoutId).toArray())
    .filter(alive)
    .sort((a, b) => a.position - b.position);
  const i = list.findIndex((w) => w.id === weId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  for (const [p, w] of list.entries()) if (w.position !== p) await patch('workout_exercises', w.id, { position: p });
}

// Beim Beenden: Sätze mit Werten zählen als erledigt, leere Sätze fallen weg.
export async function finishWorkout(workoutId: string) {
  const finished = nowIso();
  const sets = (await db.sets.where('workout_id').equals(workoutId).toArray()).filter(alive);
  for (const s of sets) {
    const hasValues = s.weight_kg != null || s.reps != null;
    if (!hasValues && !s.done_at) await softDelete('sets', s.id);
    else if (!s.done_at) await patch('sets', s.id, { done_at: finished });
  }
  await patch('workouts', workoutId, { finished_at: finished });
}

export async function deleteWorkout(workoutId: string) {
  await softDelete('workouts', workoutId);
}

// ---------- Trainingstag nach dem Beenden anpassen ----------

// Eine Übung, wie sie im beendeten Training vorkam. Gezählt werden Arbeitssätze (Satznummern ohne
// Aufwärmsätze); Aufwärmsätze gehören nur zum Training. Übungen ganz ohne Sätze zählen als weggelassen.
interface Slot {
  exerciseId: string;
  sets: number;
  note: string | null;
}

async function workoutSlots(workoutId: string): Promise<Slot[]> {
  const wes = (await db.workout_exercises.where('workout_id').equals(workoutId).toArray())
    .filter(alive)
    .sort((a, b) => a.position - b.position);
  const out: Slot[] = [];
  for (const we of wes) {
    const sets = (await db.sets.where('workout_exercise_id').equals(we.id).toArray()).filter(alive);
    const count = workRanks(sets).size;
    if (count > 0) out.push({ exerciseId: we.exercise_id, sets: count, note: we.note });
  }
  return out;
}

// Ordnet Übungen des Trainingstags denen des Trainings zu: das k-te Vorkommen einer Übung zum k-ten
// (Reverse Flys stehen zweimal im Plan).
function matchSlots(links: TemplateExercise[], slots: Slot[]) {
  const pairs: { link: TemplateExercise; slot: Slot; at: number }[] = [];
  const used = new Set<number>();
  const removed: TemplateExercise[] = [];
  for (const link of links) {
    const at = slots.findIndex((s, i) => !used.has(i) && s.exerciseId === link.exercise_id);
    if (at < 0) removed.push(link);
    else {
      used.add(at);
      pairs.push({ link, slot: slots[at], at });
    }
  }
  const added = slots.map((slot, at) => ({ slot, at })).filter(({ at }) => !used.has(at));
  return { pairs, removed, added };
}

const saetze = (n: number) => (n === 1 ? '1 Satz' : `${n} Sätze`);

export interface TemplateChange {
  template: Template | null; // null: freies Training oder der Trainingstag ist inzwischen gelöscht
  lines: string[];
  removes: boolean; // fällt im Trainingstag etwas weg?
}

// Was sich gegenüber dem Trainingstag geändert hat; null, wenn es nichts zu fragen gibt.
export async function templateChanges(workoutId: string): Promise<TemplateChange | null> {
  const workout = await db.workouts.get(workoutId);
  if (!workout) return null;
  const slots = await workoutSlots(workoutId);
  const template = workout.template_id ? await db.templates.get(workout.template_id) : undefined;
  if (!template || template.deleted_at) return slots.length ? { template: null, lines: [], removes: false } : null;

  const links = (await db.template_exercises.where('template_id').equals(template.id).toArray())
    .filter(alive)
    .sort((a, b) => a.position - b.position);
  const { pairs, removed, added } = matchSlots(links, slots);
  const ids = [...new Set([...links.map((l) => l.exercise_id), ...slots.map((s) => s.exerciseId)])];
  const names = new Map((await db.exercises.bulkGet(ids)).filter((e): e is Exercise => !!e).map((e) => [e.id, e.name]));
  const name = (id: string) => names.get(id) ?? 'Übung';

  const lines: string[] = [];
  for (const { link, slot } of pairs) {
    if (slot.sets !== link.sets) lines.push(`${name(link.exercise_id)}: ${link.sets} → ${saetze(slot.sets)}`);
  }
  for (const { slot } of added) lines.push(`${name(slot.exerciseId)} neu (${saetze(slot.sets)})`);
  // Weggelassenes in einer Zeile, sonst wird die Liste nach einem kurzen Training sehr lang.
  // Trenner „·“, weil manche Übungsnamen selbst ein Komma enthalten.
  if (removed.length) lines.push(`Weggelassen: ${removed.map((l) => name(l.exercise_id)).join(' · ')}`);
  if (pairs.some((p, i) => i > 0 && p.at < pairs[i - 1].at)) lines.push('Reihenfolge geändert');

  if (lines.length === 0) return null;
  return { template, lines, removes: removed.length > 0 || pairs.some((p) => p.slot.sets < p.link.sets) };
}

// „Trainingstag ändern“: Der Trainingstag sieht danach aus wie das Training (Übungen, Reihenfolge,
// Satzzahl). Hinweise bleiben an ihrer Übung; Weggelassenes wird nur als gelöscht markiert.
export async function applyWorkoutToTemplate(workoutId: string) {
  const workout = await db.workouts.get(workoutId);
  if (!workout?.template_id) return;
  const templateId = workout.template_id;
  const slots = await workoutSlots(workoutId);
  const links = (await db.template_exercises.where('template_id').equals(templateId).toArray())
    .filter(alive)
    .sort((a, b) => a.position - b.position);
  const { pairs, removed } = matchSlots(links, slots);
  for (const [position, slot] of slots.entries()) {
    const link = pairs.find((p) => p.slot === slot)?.link;
    if (!link) {
      await save('template_exercises', {
        id: newId(),
        template_id: templateId,
        exercise_id: slot.exerciseId,
        position,
        sets: slot.sets,
        note: null,
        created_at: nowIso(),
        deleted_at: null,
      });
    } else if (link.sets !== slot.sets || link.position !== position) {
      await patch('template_exercises', link.id, { sets: slot.sets, position });
    }
  }
  for (const link of removed) await softDelete('template_exercises', link.id);
}

// „Als neuen Trainingstag speichern“: neuer Trainingstag aus dem Training; das Training gehört danach zu ihm.
export async function saveWorkoutAsTemplate(workoutId: string, name: string): Promise<string> {
  const id = await createTemplate(name);
  const slots = await workoutSlots(workoutId);
  const created = nowIso();
  await saveMany(
    'template_exercises',
    slots.map((slot, position) => ({
      id: newId(),
      template_id: id,
      exercise_id: slot.exerciseId,
      position,
      sets: slot.sets,
      note: slot.note,
      created_at: created,
      deleted_at: null,
    })),
  );
  await patch('workouts', workoutId, { template_id: id, name: name.trim() });
  return id;
}

// ---------- Auswertung ----------

export interface PrevSet {
  weight_kg: number | null;
  reps: number | null;
}

// Werte vom letzten Mal für eine Übung im Training: gleiche Übung im jüngsten früheren Training,
// bei mehrfachem Vorkommen (Reverse Flys) das gleiche Vorkommen. Schlüssel: "Satznummer|Seite".
export async function previousSets(we: WorkoutExercise, workout: Workout): Promise<Map<string, PrevSet>> {
  const occurrence = (await db.workout_exercises.where('workout_id').equals(workout.id).toArray())
    .filter(alive)
    .filter((w) => w.exercise_id === we.exercise_id && w.position < we.position).length;

  const candidates = (await db.workout_exercises.where('exercise_id').equals(we.exercise_id).toArray()).filter(
    (w) => alive(w) && w.workout_id !== workout.id,
  );
  const byWorkout = new Map<string, WorkoutExercise[]>();
  for (const c of candidates) byWorkout.set(c.workout_id, [...(byWorkout.get(c.workout_id) ?? []), c]);
  const workouts = (await db.workouts.bulkGet([...byWorkout.keys()]))
    .filter((w): w is Workout => !!w && alive(w) && w.started_at < workout.started_at)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));

  for (const w of workouts) {
    const wes = byWorkout.get(w.id)!.sort((a, b) => a.position - b.position);
    const match = wes[Math.min(occurrence, wes.length - 1)];
    // Aufwärmsätze zählen nicht mit; gezählt wird je Seite der 1., 2., … Arbeitssatz.
    const sets = (await db.sets.where('workout_exercise_id').equals(match.id).toArray())
      .filter((s) => alive(s) && s.kind !== 'warmup' && (s.weight_kg != null || s.reps != null))
      .sort((a, b) => a.position - b.position);
    if (sets.length === 0) continue;
    const out = new Map<string, PrevSet>();
    const rank = new Map<string, number>();
    for (const s of sets) {
      const side = s.side ?? '';
      const k = (rank.get(side) ?? 0) + 1;
      rank.set(side, k);
      out.set(`${k}|${side}`, { weight_kg: s.weight_kg, reps: s.reps });
    }
    return out;
  }
  return new Map();
}

// Vorwert für einen Satz; bei einarmigen Übungen notfalls der Wert ohne Seite (alte Strong-Daten).
export function prevFor(map: Map<string, PrevSet>, position: number, side: string | null): PrevSet | undefined {
  return map.get(`${position}|${side ?? ''}`) ?? (side ? map.get(`${position}|`) : undefined);
}

// Geschätztes Maximum für eine Wiederholung (Epley).
export function e1rm(weight: number | null, reps: number | null): number | null {
  if (weight == null || reps == null || reps <= 0 || weight <= 0) return null;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

// Sätze einer Übung in diesem Training, die beim Eintragen einen neuen Bestwert (geschätztes Maximum)
// setzen. Verglichen wird mit allen früheren Trainings und den Sätzen davor; ohne frühere Werte gibt es
// keinen Rekord, sonst wäre jede neue Übung einer.
export async function recordSetIds(workout: Workout, exerciseId: string): Promise<Set<string>> {
  const all = (await db.sets.where('exercise_id').equals(exerciseId).toArray()).filter(
    (s) => alive(s) && s.kind !== 'warmup' && s.weight_kg != null && s.reps != null,
  );
  const own = all.filter((s) => s.workout_id === workout.id);
  const otherIds = [...new Set(all.filter((s) => s.workout_id !== workout.id).map((s) => s.workout_id))];
  const earlier = new Set(
    (await db.workouts.bulkGet(otherIds))
      .filter((w): w is Workout => !!w && alive(w) && w.started_at < workout.started_at)
      .map((w) => w.id),
  );
  let top: number | null = null;
  for (const s of all) {
    if (!earlier.has(s.workout_id)) continue;
    const e = e1rm(s.weight_kg, s.reps);
    if (e != null && (top == null || e > top)) top = e;
  }
  const out = new Set<string>();
  if (top == null || own.length === 0) return out;
  const wePos = new Map(
    (await db.workout_exercises.bulkGet([...new Set(own.map((s) => s.workout_exercise_id))]))
      .filter((w): w is WorkoutExercise => !!w)
      .map((w) => [w.id, w.position]),
  );
  own.sort(
    (a, b) =>
      (wePos.get(a.workout_exercise_id) ?? 0) - (wePos.get(b.workout_exercise_id) ?? 0) ||
      a.position - b.position ||
      (a.side ?? '').localeCompare(b.side ?? ''),
  );
  for (const s of own) {
    const e = e1rm(s.weight_kg, s.reps);
    if (e != null && e > top) {
      out.add(s.id);
      top = e;
    }
  }
  return out;
}

export interface WorkoutSummary {
  sets: number;
  volume: number;
  records: { exercise: string; weight_kg: number; reps: number }[];
}

// Zusammenfassung eines Trainings: Arbeitssätze mit Werten, bewegtes Gewicht, neue Rekorde.
export async function workoutSummary(workoutId: string): Promise<WorkoutSummary | null> {
  const workout = await db.workouts.get(workoutId);
  if (!workout) return null;
  const sets = (await db.sets.where('workout_id').equals(workoutId).toArray()).filter(
    (s) => alive(s) && s.kind !== 'warmup' && (s.weight_kg != null || s.reps != null),
  );
  const wes = (await db.workout_exercises.where('workout_id').equals(workoutId).toArray())
    .filter(alive)
    .sort((a, b) => a.position - b.position);
  const records: WorkoutSummary['records'] = [];
  for (const exerciseId of new Set(wes.map((w) => w.exercise_id))) {
    const ids = await recordSetIds(workout, exerciseId);
    const best = sets.filter((s) => ids.has(s.id)).sort((a, b) => (e1rm(b.weight_kg, b.reps) ?? 0) - (e1rm(a.weight_kg, a.reps) ?? 0))[0];
    if (best) {
      const ex = await db.exercises.get(exerciseId);
      records.push({ exercise: ex?.name ?? 'Übung', weight_kg: best.weight_kg!, reps: best.reps! });
    }
  }
  return {
    sets: sets.length,
    volume: sets.reduce((v, s) => v + (s.weight_kg ?? 0) * (s.reps ?? 0), 0),
    records,
  };
}

export interface HistoryPoint {
  workoutId: string;
  date: string;
  bestE1rm: number | null;
  topWeight: number | null;
  volume: number;
  sets: WSet[];
}

export async function exerciseHistory(exerciseId: string): Promise<HistoryPoint[]> {
  const sets = (await db.sets.where('exercise_id').equals(exerciseId).toArray()).filter(
    (s) => alive(s) && s.kind !== 'warmup' && (s.weight_kg != null || s.reps != null),
  );
  const byWorkout = new Map<string, WSet[]>();
  for (const s of sets) byWorkout.set(s.workout_id, [...(byWorkout.get(s.workout_id) ?? []), s]);
  const workouts = (await db.workouts.bulkGet([...byWorkout.keys()])).filter(
    (w): w is Workout => !!w && alive(w),
  );
  return workouts
    .map((w) => {
      const ss = byWorkout.get(w.id)!.sort((a, b) => a.position - b.position || (a.side ?? '').localeCompare(b.side ?? ''));
      const e = ss.map((s) => e1rm(s.weight_kg, s.reps)).filter((x): x is number => x != null);
      const weights = ss.map((s) => s.weight_kg).filter((x): x is number => x != null);
      return {
        workoutId: w.id,
        date: w.started_at,
        bestE1rm: e.length ? Math.max(...e) : null,
        topWeight: weights.length ? Math.max(...weights) : null,
        volume: ss.reduce((v, s) => v + (s.weight_kg ?? 0) * (s.reps ?? 0), 0),
        sets: ss,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Übungen und Trainingstage ----------

export async function createExercise(name: string, unilateral: boolean): Promise<string> {
  const ex: Exercise = {
    id: newId(),
    name: name.trim(),
    unilateral,
    rest_seconds: null,
    note: null,
    created_at: nowIso(),
    deleted_at: null,
  };
  await save('exercises', ex);
  return ex.id;
}

export async function createTemplate(name: string): Promise<string> {
  const all = (await db.templates.toArray()).filter(alive);
  const t: Template = {
    id: newId(),
    name: name.trim(),
    position: all.reduce((m, x) => Math.max(m, x.position + 1), 0),
    note: null,
    created_at: nowIso(),
    deleted_at: null,
  };
  await save('templates', t);
  return t.id;
}

export async function addExerciseToTemplate(templateId: string, exerciseId: string, sets = 2) {
  const links = (await db.template_exercises.where('template_id').equals(templateId).toArray()).filter(alive);
  await save('template_exercises', {
    id: newId(),
    template_id: templateId,
    exercise_id: exerciseId,
    position: links.reduce((m, l) => Math.max(m, l.position + 1), 0),
    sets,
    note: null,
    created_at: nowIso(),
    deleted_at: null,
  });
}

export async function moveTemplateExercise(templateId: string, linkId: string, dir: -1 | 1) {
  const list = (await db.template_exercises.where('template_id').equals(templateId).toArray())
    .filter(alive)
    .sort((a, b) => a.position - b.position);
  const i = list.findIndex((l) => l.id === linkId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  for (const [p, l] of list.entries()) if (l.position !== p) await patch('template_exercises', l.id, { position: p });
}

export async function duplicateTemplate(templateId: string): Promise<string | undefined> {
  const t = await db.templates.get(templateId);
  if (!t) return;
  const id = await createTemplate(`${t.name} (Kopie)`);
  const links = (await db.template_exercises.where('template_id').equals(templateId).toArray())
    .filter(alive)
    .sort((a, b) => a.position - b.position);
  for (const l of links) await addExerciseToTemplate(id, l.exercise_id, l.sets);
  return id;
}
