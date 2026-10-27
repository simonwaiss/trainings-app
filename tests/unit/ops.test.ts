import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, LocalDB, useDatabase } from '../../src/db/local';
import {
  addSet,
  e1rm,
  exerciseHistory,
  finishWorkout,
  previousSets,
  removeLastSet,
  seedPlanIfEmpty,
  startWorkout,
  updateSet,
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
