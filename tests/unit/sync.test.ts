import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, LocalDB, patch, pendingCount, useDatabase } from '../../src/db/local';
import { finishWorkout, previousSets, seedPlanIfEmpty, startWorkout, updateSet } from '../../src/data/ops';
import { pull, push, syncOnce } from '../../src/sync/sync';
import { FakeRemote } from './fake-remote';

const USER = '11111111-1111-4111-8111-111111111111';
let n = 0;
const freshDevice = () => {
  const d = new LocalDB(`test-${++n}`);
  useDatabase(d);
  return d;
};

async function logTorso() {
  await seedPlanIfEmpty();
  const torso = (await db.templates.toArray()).find((t) => t.name === 'Torso')!;
  const wid = await startWorkout(torso.id);
  const first = (await db.workout_exercises.where('workout_id').equals(wid).toArray()).find((w) => w.position === 0)!;
  const sets = (await db.sets.where('workout_exercise_id').equals(first.id).toArray()).sort((a, b) => a.position - b.position);
  await updateSet(sets[0].id, { weight_kg: 50, reps: 10, done_at: new Date().toISOString() });
  await updateSet(sets[1].id, { weight_kg: 50, reps: 9, done_at: new Date().toISOString() });
  return wid;
}

describe('Abgleich mit dem Server', () => {
  let remote: FakeRemote;
  beforeEach(() => {
    remote = new FakeRemote();
    freshDevice();
  });

  it('hält Sätze ohne Netz fest und sendet sie später genau einmal', async () => {
    remote.offline = true;
    const wid = await logTorso();
    await expect(syncOnce(remote, USER)).rejects.toThrow();
    expect(await pendingCount()).toBeGreaterThan(0);
    expect(remote.rows('sets')).toHaveLength(0);

    remote.offline = false;
    await syncOnce(remote, USER);
    expect(await pendingCount()).toBe(0);
    const serverSets = remote.rows('sets').filter((s) => (s as never as { workout_id: string }).workout_id === wid);
    const localSets = await db.sets.where('workout_id').equals(wid).count();
    expect(serverSets).toHaveLength(localSets);
    expect(serverSets.every((s) => s.user_id === USER)).toBe(true);
  });

  it('legt keine doppelten Sätze an, wenn die Antwort des Servers verloren geht', async () => {
    await logTorso();
    remote.failAfterUpsert = true;
    await expect(push(remote, USER)).rejects.toThrow();
    await syncOnce(remote, USER);
    await syncOnce(remote, USER);
    const ids = remote.rows('sets').map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(await db.sets.count());
  });

  it('verliert keine Eingabe, die während des Sendens passiert', async () => {
    const wid = await logTorso();
    const target = (await db.sets.where('workout_id').equals(wid).toArray()).find((s) => s.reps === 10)!;
    const original = remote.upsert.bind(remote);
    let edited = false;
    remote.upsert = async (table, rows) => {
      await original(table, rows);
      if (table === 'sets' && !edited) {
        edited = true;
        await patch('sets', target.id, { reps: 12 });
      }
    };
    await push(remote, USER);
    expect((await db.sets.get(target.id))!._dirty).toBe(1);
    await push(remote, USER);
    const onServer = remote.rows('sets').find((s) => s.id === target.id) as unknown as { reps: number };
    expect(onServer.reps).toBe(12);
  });

  it('übernimmt Änderungen vom Server, aber nicht über ungesendete eigene', async () => {
    const wid = await logTorso();
    await syncOnce(remote, USER);
    const [a, b] = (await db.sets.where('workout_id').equals(wid).toArray()).filter((s) => s.reps != null);
    // Am Mac geändert:
    await remote.upsert('sets', [{ ...remote.rows('sets').find((s) => s.id === a.id)!, reps: 7 } as never]);
    await remote.upsert('sets', [{ ...remote.rows('sets').find((s) => s.id === b.id)!, reps: 3 } as never]);
    // Am Handy gleichzeitig b geändert, noch nicht gesendet:
    await patch('sets', b.id, { reps: 11 });
    await pull(remote);
    expect((await db.sets.get(a.id))!.reps).toBe(7);
    expect((await db.sets.get(b.id))!.reps).toBe(11);
  });

  it('zeigt auf dem zweiten Gerät die Werte vom letzten Mal', async () => {
    const wid = await logTorso();
    await finishWorkout(wid);
    await syncOnce(remote, USER);

    freshDevice(); // z. B. der Mac
    await syncOnce(remote, USER);
    expect(await seedPlanIfEmpty()).toBe(false);
    const torso = (await db.templates.toArray()).find((t) => t.name === 'Torso')!;
    const next = await startWorkout(torso.id);
    const workout = (await db.workouts.get(next))!;
    const first = (await db.workout_exercises.where('workout_id').equals(next).toArray()).find((w) => w.position === 0)!;
    const prev = await previousSets(first, workout);
    expect(prev.get('1|')).toEqual({ weight_kg: 50, reps: 10 });
    expect(prev.get('2|')).toEqual({ weight_kg: 50, reps: 9 });
  });

  it('legt den Trainingsplan auf zwei Geräten nicht doppelt an', async () => {
    await seedPlanIfEmpty();
    freshDevice();
    await seedPlanIfEmpty(); // zweites Gerät ohne Netz: gleiche feste ids
    await syncOnce(remote, USER);
    freshDevice();
    await seedPlanIfEmpty();
    await syncOnce(remote, USER);
    expect(remote.rows('templates')).toHaveLength(2);
    expect(remote.rows('template_exercises')).toHaveLength(21);
  });

  it('sendet nichts, wenn auf dem Gerät Daten eines anderen Kontos liegen', async () => {
    await logTorso();
    await syncOnce(remote, USER);
    await patch('sets', (await db.sets.toArray())[0].id, { reps: 1 });
    await expect(syncOnce(remote, '22222222-2222-4222-8222-222222222222')).rejects.toThrow(/anderen Kontos/);
    expect(remote.rows('sets').some((s) => (s as unknown as { reps: number }).reps === 1)).toBe(false);
  });
});
