import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, LocalDB, patch, pendingCount, useDatabase } from '../../src/db/local';
import { finishWorkout, previousSets, seedPlanIfEmpty, startWorkout, updateSet } from '../../src/data/ops';
import { heldRows, retryHeld } from '../../src/db/local';
import { MAX_FAILS, pull, push, syncOnce } from '../../src/sync/sync';
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

  it('eine abgelehnte Zeile hält den Rest nicht auf und wird nach mehreren Versuchen zurückgehalten', async () => {
    const wid = await logTorso();
    const bad = (await db.sets.where('workout_id').equals(wid).toArray()).find((s) => s.reps === 9)!;
    remote.reject = (table, row) => table === 'sets' && row.id === bad.id;

    const first = await syncOnce(remote, USER);
    expect(first.rejected).toBe(1);
    // Alles andere ist angekommen, auch das Training selbst und die anderen Sätze.
    expect(remote.rows('workouts')).toHaveLength(1);
    expect(remote.rows('sets').length).toBe((await db.sets.count()) - 1);
    expect((await db.sets.get(bad.id))!._dirty).toBe(1);

    for (let i = 1; i < MAX_FAILS; i++) await syncOnce(remote, USER);
    expect((await db.sets.get(bad.id))!._dirty).toBe(2);
    expect(await pendingCount()).toBe(0);
    expect(await heldRows()).toEqual([{ table: 'sets', id: bad.id, error: 'sets: violates check constraint' }]);

    // Neue Sätze kommen weiter an.
    const other = (await db.sets.where('workout_id').equals(wid).toArray()).find((s) => s.reps == null)!;
    await patch('sets', other.id, { weight_kg: 20, reps: 5 });
    await syncOnce(remote, USER);
    expect(remote.rows('sets').find((s) => s.id === other.id)).toMatchObject({ weight_kg: 20, reps: 5 });

    // Nach einer Korrektur (z. B. neue App-Version) lässt sie sich erneut senden.
    remote.reject = () => false;
    await retryHeld();
    await syncOnce(remote, USER);
    expect(remote.rows('sets').some((s) => s.id === bad.id)).toBe(true);
    expect(await pendingCount(2)).toBe(0);
  });

  it('holt Änderungen vom Server auch dann, wenn das Senden scheitert', async () => {
    await logTorso();
    await syncOnce(remote, USER);
    const s = remote.rows('sets')[0];
    await remote.upsert('sets', [{ ...s, reps: 42 } as never]);
    await patch('sets', remote.rows('sets')[1].id, { reps: 1 });
    const original = remote.upsert.bind(remote);
    remote.upsert = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(syncOnce(remote, USER)).rejects.toThrow();
    remote.upsert = original;
    expect((await db.sets.get(s.id))!.reps).toBe(42);
  });

  it('passt Werte vor dem Speichern an die Grenzen der Datenbank an', async () => {
    const wid = await logTorso();
    const s = (await db.sets.where('workout_id').equals(wid).toArray())[0];
    await patch('sets', s.id, { weight_kg: 100000, reps: 7.6 });
    expect(await db.sets.get(s.id)).toMatchObject({ weight_kg: 99999.99, reps: 8 });
  });

  it('sendet nichts, wenn auf dem Gerät Daten eines anderen Kontos liegen', async () => {
    await logTorso();
    await syncOnce(remote, USER);
    await patch('sets', (await db.sets.toArray())[0].id, { reps: 1 });
    await expect(syncOnce(remote, '22222222-2222-4222-8222-222222222222')).rejects.toThrow(/anderen Kontos/);
    expect(remote.rows('sets').some((s) => (s as unknown as { reps: number }).reps === 1)).toBe(false);
  });
});
