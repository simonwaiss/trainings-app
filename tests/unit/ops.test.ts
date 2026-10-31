import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, LocalDB, useDatabase } from '../../src/db/local';
import {
  addExerciseToWorkout,
  addSet,
  applyWorkoutToTemplate,
  createExercise,
  e1rm,
  exerciseHistory,
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
  seedPlanIfEmpty,
  setKind,
  startWorkout,
  templateChanges,
  updateSet,
  workoutSummary,
  workRanks,
} from '../../src/data/ops';

let n = 0;
beforeEach(async () => {
  useDatabase(new LocalDB(`ops-${++n}`));
  await seedPlanIfEmpty();
});

const torsoId = async () => (await db.templates.toArray()).find((t) => t.name === 'Torso')!.id;
const wes = async (wid: string) =>
  (await db.workout_exercises.where('workout_id').equals(wid).toArray()).sort((a, b) => a.position - b.position);
const setsOf = async (weId: string) =>
  (await db.sets.where('workout_exercise_id').equals(weId).toArray())
    .filter((s) => !s.deleted_at)
    .sort((a, b) => a.position - b.position || (a.side ?? '').localeCompare(b.side ?? ''));

describe('Trainingsplan und Training', () => {
  it('legt den Plan mit allen Übungen und Satzzahlen an', async () => {
    const wid = await startWorkout(await torsoId());
    const list = await wes(wid);
    expect(list).toHaveLength(12);
    const names = await Promise.all(list.map(async (w) => (await db.exercises.get(w.exercise_id))!.name));
    expect(names[2]).toBe('Seitheben');
    expect(await setsOf(list[2].id)).toHaveLength(3);
    // Einarmig: Sätze je Seite
    const rudern = await setsOf(list[3].id);
    expect(rudern.map((s) => `${s.position}${s.side}`)).toEqual(['1L', '1R', '2L', '2R']);
    // Reverse Flys zweimal, je 1 Satz pro Seite
    expect(names.filter((x) => x === 'Reverse Flys')).toHaveLength(2);
  });

  it('wirft leere Sätze beim Beenden weg und behält ausgefüllte', async () => {
    const wid = await startWorkout(await torsoId());
    const [butterfly] = await wes(wid);
    const [s1, s2] = await setsOf(butterfly.id);
    await updateSet(s1.id, { weight_kg: 40, reps: 12 });
    await finishWorkout(wid);
    expect((await db.sets.get(s1.id))!.done_at).not.toBeNull();
    expect((await db.sets.get(s2.id))!.deleted_at).not.toBeNull();
    expect((await db.workouts.get(wid))!.finished_at).not.toBeNull();
  });

  it('findet die Vorwerte je Satz, Seite und Vorkommen', async () => {
    const w1 = await startWorkout(await torsoId());
    const l1 = await wes(w1);
    const [rL] = await setsOf(l1[3].id);
    await updateSet(rL.id, { weight_kg: 30, reps: 10 });
    const flys1 = await setsOf(l1[6].id);
    const flys2 = await setsOf(l1[10].id);
    await updateSet(flys1[0].id, { weight_kg: 8, reps: 15 });
    await updateSet(flys2[0].id, { weight_kg: 6, reps: 20 });
    await finishWorkout(w1);

    await new Promise((r) => setTimeout(r, 5));
    const w2 = await startWorkout(await torsoId());
    const workout = (await db.workouts.get(w2))!;
    const l2 = await wes(w2);
    expect((await previousSets(l2[3], workout)).get('1|L')).toEqual({ weight_kg: 30, reps: 10 });
    expect((await previousSets(l2[6], workout)).get('1|L')).toEqual({ weight_kg: 8, reps: 15 });
    expect((await previousSets(l2[10], workout)).get('1|L')).toEqual({ weight_kg: 6, reps: 20 });
  });

  it('fügt Sätze hinzu und entfernt den letzten (einarmig: beide Seiten)', async () => {
    const wid = await startWorkout(await torsoId());
    const l = await wes(wid);
    await addSet(l[3].id);
    expect((await setsOf(l[3].id)).map((s) => `${s.position}${s.side}`)).toEqual(['1L', '1R', '2L', '2R', '3L', '3R']);
    await removeLastSet(l[3].id);
    expect(await setsOf(l[3].id)).toHaveLength(4);
  });

  it('rechnet den Kraftverlauf je Training', async () => {
    const wid = await startWorkout(await torsoId());
    const [butterfly] = await wes(wid);
    const [s1, s2] = await setsOf(butterfly.id);
    await updateSet(s1.id, { weight_kg: 60, reps: 10 });
    await updateSet(s2.id, { weight_kg: 65, reps: 6 });
    await finishWorkout(wid);
    const [point] = await exerciseHistory(butterfly.exercise_id);
    expect(point.topWeight).toBe(65);
    expect(point.bestE1rm).toBe(80);
    expect(point.volume).toBe(60 * 10 + 65 * 6);
    expect(e1rm(100, 1)).toBe(100);
    expect(e1rm(null, 5)).toBeNull();
  });
});

const templateLinks = async (templateId: string) =>
  (await db.template_exercises.where('template_id').equals(templateId).toArray())
    .filter((l) => !l.deleted_at)
    .sort((a, b) => a.position - b.position);
const fillAll = async (wid: string) => {
  for (const s of (await db.sets.where('workout_id').equals(wid).toArray()).filter((x) => !x.deleted_at)) {
    await updateSet(s.id, { weight_kg: 10, reps: 10 });
  }
};
const later = () => new Promise((r) => setTimeout(r, 5));

describe('Sätze entfernen, Satz-Typ, Übung tauschen', () => {
  it('entfernt einen Satz in der Mitte, die Sätze dahinter rücken nach (einarmig: beide Seiten)', async () => {
    const wid = await startWorkout(await torsoId());
    const l = await wes(wid);
    await addSet(l[3].id);
    const before = await setsOf(l[3].id);
    const third = before.filter((s) => s.position === 3).map((s) => s.id);
    await removeSet(l[3].id, 2);
    const after = await setsOf(l[3].id);
    expect(after.map((s) => `${s.position}${s.side}`)).toEqual(['1L', '1R', '2L', '2R']);
    expect(after.filter((s) => s.position === 2).map((s) => s.id).sort()).toEqual(third.sort());
    // Nichts ist wirklich weg, nur markiert.
    expect((await db.sets.where('workout_exercise_id').equals(l[3].id).toArray())).toHaveLength(6);
  });

  it('Aufwärmsätze zählen nicht als Arbeitssatz, die Vorwerte rutschen mit', async () => {
    const w1 = await startWorkout(await torsoId());
    const [b1] = await wes(w1);
    const [s1] = await setsOf(b1.id);
    await updateSet(s1.id, { weight_kg: 50, reps: 10 });
    await finishWorkout(w1);
    await later();
    const w2 = await startWorkout(await torsoId());
    const [b2] = await wes(w2);
    await setKind(b2.id, 1, 'warmup');
    const sets = await setsOf(b2.id);
    expect(sets.map((s) => s.kind)).toEqual(['warmup', 'normal']);
    const ranks = workRanks(sets);
    expect(ranks.get(1)).toBeUndefined();
    expect(ranks.get(2)).toBe(1);
    const prev = await previousSets(b2, (await db.workouts.get(w2))!);
    expect(prevFor(prev, ranks.get(2)!, null)).toEqual({ weight_kg: 50, reps: 10 });
  });

  it('tauscht eine Übung: gleiche Seiten behalten die Werte, andere Seiten bekommen neue leere Sätze', async () => {
    const wid = await startWorkout(await torsoId());
    const l = await wes(wid);
    const [s1] = await setsOf(l[0].id);
    await updateSet(s1.id, { weight_kg: 40, reps: 12 });
    const latzug = l[5].exercise_id; // beidarmig
    const rudern = l[3].exercise_id; // einarmig
    await replaceWorkoutExercise(l[0].id, latzug);
    expect((await db.workout_exercises.get(l[0].id))!.exercise_id).toBe(latzug);
    const kept = await setsOf(l[0].id);
    expect(kept.map((s) => [s.exercise_id, s.weight_kg])).toEqual([
      [latzug, 40],
      [latzug, null],
    ]);
    await replaceWorkoutExercise(l[0].id, rudern);
    const rebuilt = await setsOf(l[0].id);
    expect(rebuilt.map((s) => `${s.position}${s.side}`)).toEqual(['1L', '1R', '2L', '2R']);
    expect(rebuilt.every((s) => s.exercise_id === rudern && s.weight_kg == null)).toBe(true);
  });
});

describe('Trainingstag beim Beenden', () => {
  it('fragt nichts, wenn das Training dem Trainingstag entspricht', async () => {
    const wid = await startWorkout(await torsoId());
    await fillAll(wid);
    expect(await templateChanges(wid)).toBeNull();
    await finishWorkout(wid);
    expect(await templateChanges(wid)).toBeNull();
  });

  it('zeigt die Abweichungen schon vor dem Beenden; leere Sätze zählen als nicht gemacht, nichts wird entfernt', async () => {
    const tid = await torsoId();
    const wid = await startWorkout(tid);
    const l = await wes(wid);
    await fillAll(wid);
    const leer = await setsOf(l[7].id); // Frontheben: nur Satz 1 gemacht
    await updateSet(leer[leer.length - 1].id, { weight_kg: null, reps: null });
    await updateSet(leer[leer.length - 2].id, { weight_kg: null, reps: null });
    for (const s of await setsOf(l[5].id)) await updateSet(s.id, { weight_kg: null, reps: null }); // Latzug ausgelassen
    await addSet(l[3].id); // Enges Rudern 2 → 3
    for (const s of await setsOf(l[3].id)) await updateSet(s.id, { weight_kg: 30, reps: 10 });

    const change = (await templateChanges(wid))!;
    expect(change.lines).toEqual([
      'Nicht gemacht: Latzug breit, Maschine (2 Sätze)',
      'Enges Rudern, Maschine mit Brustpolster: 3 statt 2 Sätze',
      'Frontheben am Kabel: 1 statt 2 Sätze',
    ]);
    expect(change.removes).toBe(true);
    // Die Vorschau ändert nichts: Training läuft weiter, kein Satz ist weg, der Trainingstag ist wie vorher.
    expect((await db.workouts.get(wid))!.finished_at).toBeNull();
    expect(await setsOf(l[5].id)).toHaveLength(2);
    expect((await templateLinks(tid)).map((x) => x.sets)).toEqual([2, 2, 3, 2, 2, 2, 1, 2, 2, 2, 1, 2]);
    // Nach dem Beenden steht dasselbe da.
    await finishWorkout(wid);
    expect((await templateChanges(wid))!.lines).toEqual(change.lines);
  });

  it('nennt entfernte Sätze, leer gelassene Übungen und neue Übungen', async () => {
    const tid = await torsoId();
    const wid = await startWorkout(tid);
    const l = await wes(wid);
    await fillAll(wid);
    await removeSet(l[2].id, 2); // Seitheben 3 → 2
    await removeWorkoutExercise(l[5].id); // Latzug weg
    const leer = l[11]; // Hyperextensions bleiben leer und fallen beim Beenden weg
    for (const s of await setsOf(leer.id)) await updateSet(s.id, { weight_kg: null, reps: null });
    await addSet(l[0].id); // Butterfly 2 → 3
    const extra = await createExercise('Dips', false);
    await addExerciseToWorkout(wid, extra);
    for (const s of (await db.sets.where('exercise_id').equals(extra).toArray())) await updateSet(s.id, { reps: 12 });
    for (const s of await setsOf(l[0].id)) await updateSet(s.id, { weight_kg: 40, reps: 10 });
    await finishWorkout(wid);

    const change = (await templateChanges(wid))!;
    expect(change.template!.id).toBe(tid);
    expect(change.lines).toEqual([
      'Nicht gemacht: Latzug breit, Maschine (2 Sätze)',
      'Nicht gemacht: Hyperextensions (2 Sätze)',
      'Butterfly (Maschine): 3 statt 2 Sätze',
      'Seitheben: 2 statt 3 Sätze',
      'Zusätzlich: Dips (2 Sätze)',
    ]);
    expect(change.removes).toBe(true);

    // „Nur dieses Training“ ändert nichts: Der Trainingstag bleibt, wie er war.
    expect((await templateLinks(tid)).map((x) => x.sets)).toEqual([2, 2, 3, 2, 2, 2, 1, 2, 2, 2, 1, 2]);

    // „Torso ändern“: Das nächste Torso sieht aus wie dieses Training.
    await applyWorkoutToTemplate(wid);
    const links = await templateLinks(tid);
    const names = await Promise.all(links.map(async (x) => (await db.exercises.get(x.exercise_id))!.name));
    expect(names).toHaveLength(11);
    expect(names).not.toContain('Latzug breit, Maschine');
    expect(names[names.length - 1]).toBe('Dips');
    expect(links.map((x) => x.position)).toEqual([...links.keys()]);
    expect(links[0].sets).toBe(3);
    expect(links[2].sets).toBe(2);
    // Hinweise bleiben an ihrer Übung.
    expect(links.find((x) => x.note?.includes('obere Brust'))).toBeTruthy();
    await later();
    const next = await startWorkout(tid);
    expect(await setsOf((await wes(next))[2].id)).toHaveLength(2);
    expect(await templateChanges(wid)).toBeNull();
  });

  it('erkennt eine geänderte Reihenfolge und ordnet doppelte Übungen (Reverse Flys) richtig zu', async () => {
    const tid = await torsoId();
    const wid = await startWorkout(tid);
    await fillAll(wid);
    const l = await wes(wid);
    await moveWorkoutExercise(wid, l[1].id, -1);
    await finishWorkout(wid);
    const change = (await templateChanges(wid))!;
    expect(change.lines).toEqual(['Reihenfolge geändert']);
    expect(change.removes).toBe(false);
    await applyWorkoutToTemplate(wid);
    const names = await Promise.all((await templateLinks(tid)).map(async (x) => (await db.exercises.get(x.exercise_id))!.name));
    expect(names.slice(0, 2)).toEqual(['Kabel-Flys von unten nach oben', 'Butterfly (Maschine)']);
    expect(names.filter((n) => n === 'Reverse Flys')).toHaveLength(2);
  });

  it('bietet ein freies Training als neuen Trainingstag an', async () => {
    const wid = await startWorkout(null);
    const dips = await createExercise('Dips', false);
    await addExerciseToWorkout(wid, dips, 3);
    for (const s of (await db.sets.where('workout_id').equals(wid).toArray())) await updateSet(s.id, { reps: 10 });
    await finishWorkout(wid);
    const change = (await templateChanges(wid))!;
    expect(change.template).toBeNull();
    const tid = await saveWorkoutAsTemplate(wid, ' Pump ');
    const t = (await db.templates.get(tid))!;
    expect(t.name).toBe('Pump');
    expect((await templateLinks(tid)).map((x) => [x.exercise_id, x.sets])).toEqual([[dips, 3]]);
    expect((await db.workouts.get(wid))!).toMatchObject({ template_id: tid, name: 'Pump' });
  });

  it('fragt nach einem leeren freien Training nichts', async () => {
    const wid = await startWorkout(null);
    await finishWorkout(wid);
    expect(await templateChanges(wid)).toBeNull();
  });
});

describe('Rekorde und Zusammenfassung', () => {
  it('markiert nur Sätze, die den bisherigen Bestwert schlagen, und nie beim ersten Mal', async () => {
    const tid = await torsoId();
    const w1 = await startWorkout(tid);
    const [b1] = await wes(w1);
    const first = await setsOf(b1.id);
    await updateSet(first[0].id, { weight_kg: 50, reps: 10 });
    expect((await recordSetIds((await db.workouts.get(w1))!, b1.exercise_id)).size).toBe(0);
    await finishWorkout(w1);
    await later();

    const w2 = await startWorkout(tid);
    const [b2] = await wes(w2);
    const [s1, s2] = await setsOf(b2.id);
    await updateSet(s1.id, { weight_kg: 55, reps: 10 }); // besser als 50 × 10
    await updateSet(s2.id, { weight_kg: 52, reps: 10 }); // besser als früher, aber nicht als Satz 1
    const workout = (await db.workouts.get(w2))!;
    expect([...(await recordSetIds(workout, b2.exercise_id))]).toEqual([s1.id]);
    await setKind(b2.id, 1, 'warmup'); // Aufwärmsätze zählen nicht
    expect([...(await recordSetIds(workout, b2.exercise_id))]).toEqual([s2.id]);

    await finishWorkout(w2);
    const sum = (await workoutSummary(w2))!;
    expect(sum.sets).toBe(1);
    expect(sum.volume).toBe(520);
    expect(sum.records).toEqual([{ exercise: 'Butterfly (Maschine)', weight_kg: 52, reps: 10 }]);
  });
});
