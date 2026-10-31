import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, isDay, localDay, removeWeight, saveWeight, weekStats, weightId, weightSeries } from '../../src/data/weight';
import { db, LocalDB, pendingCount, useDatabase } from '../../src/db/local';
import { syncOnce } from '../../src/sync/sync';
import { FakeRemote } from './fake-remote';

const USER = '11111111-1111-4111-8111-111111111111';
let n = 0;
const freshDevice = () => {
  const d = new LocalDB(`gewicht-${++n}`);
  useDatabase(d);
  return d;
};

describe('Gewicht speichern', () => {
  beforeEach(() => {
    freshDevice();
  });

  it('legt je Tag genau eine Zeile an; ein zweiter Wert am selben Tag ersetzt den ersten', async () => {
    const first = await saveWeight('2026-10-31', 79);
    const second = await saveWeight('2026-10-31', 78.6);
    expect(second.id).toBe(first.id);
    expect(second.id).toBe(await weightId('2026-10-31'));
    const rows = await db.body_weights.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: '2026-10-31', weight_kg: 78.6, source: 'app', deleted_at: null, _dirty: 1 });
  });

  it('lehnt unmögliche Werte und Tage ab, statt sie zu verbiegen', async () => {
    await expect(saveWeight('2026-10-31', 7.86)).rejects.toThrow(/außerhalb/);
    await expect(saveWeight('2026-10-31', 786)).rejects.toThrow(/außerhalb/);
    await expect(saveWeight('2026-02-30', 79)).rejects.toThrow(/Ungültiger Tag/);
    await expect(saveWeight('', 79)).rejects.toThrow(/Ungültiger Tag/);
    expect(await db.body_weights.count()).toBe(0);
  });

  it('Entfernen markiert nur; erneutes Eintragen holt den Tag zurück', async () => {
    await saveWeight('2026-10-30', 78.5);
    await removeWeight('2026-10-30');
    const [gone] = await db.body_weights.toArray();
    expect(gone.deleted_at).not.toBeNull();
    await saveWeight('2026-10-30', 78.4);
    const rows = await db.body_weights.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ weight_kg: 78.4, deleted_at: null });
  });

  it('ein Wert aus dem Vault wird beim Ändern in der App zu einem App-Wert, die Notiz bleibt', async () => {
    const id = await weightId('2026-10-25');
    await db.body_weights.put({
      id,
      day: '2026-10-25',
      weight_kg: 79,
      source: 'vault',
      note: 'Diät-Ende',
      created_at: '2026-10-31T10:00:00Z',
      deleted_at: null,
      _dirty: 0,
    });
    await saveWeight('2026-10-25', 79.2);
    expect(await db.body_weights.get(id)).toMatchObject({ weight_kg: 79.2, source: 'app', note: 'Diät-Ende' });
  });
});

describe('Update der App auf die Version mit Gewicht', () => {
  it('behält alles, was die alte Version auf dem Gerät gespeichert hat, auch Ungesendetes', async () => {
    const name = `update-${++n}`;
    // So sah die lokale Datenbank vor dem Gewicht aus (version 1).
    const old = new Dexie(name);
    old.version(1).stores({
      exercises: 'id, _dirty, name',
      templates: 'id, _dirty, position',
      template_exercises: 'id, _dirty, template_id, exercise_id',
      workouts: 'id, _dirty, started_at, finished_at, template_id',
      workout_exercises: 'id, _dirty, workout_id, exercise_id',
      sets: 'id, _dirty, workout_exercise_id, workout_id, exercise_id',
      meta: 'key',
    });
    await old.table('exercises').put({ id: 'e1', name: 'Butterfly', _dirty: 1, deleted_at: null });
    await old.table('meta').put({ key: 'owner', value: USER });
    old.close();

    const next = new LocalDB(name);
    useDatabase(next);
    expect(await next.exercises.get('e1')).toMatchObject({ name: 'Butterfly', _dirty: 1 });
    expect(await next.meta.get('owner')).toMatchObject({ value: USER });
    expect(await pendingCount()).toBe(1);
    await saveWeight('2026-10-31', 79);
    expect(await pendingCount()).toBe(2);
  });
});

describe('Gewicht ohne Netz', () => {
  let remote: FakeRemote;
  beforeEach(() => {
    remote = new FakeRemote();
    freshDevice();
  });

  it('bleibt ohne Netz auf dem Gerät und geht danach genau einmal an den Server', async () => {
    remote.offline = true;
    await saveWeight('2026-10-31', 78.6);
    await expect(syncOnce(remote, USER)).rejects.toThrow();
    expect(await pendingCount()).toBe(1);
    expect(remote.rows('body_weights')).toHaveLength(0);

    remote.offline = false;
    remote.failAfterUpsert = true; // Server speichert, Antwort geht verloren
    await expect(syncOnce(remote, USER)).rejects.toThrow();
    await syncOnce(remote, USER);
    expect(await pendingCount()).toBe(0);
    const rows = remote.rows('body_weights');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: '2026-10-31', weight_kg: 78.6, user_id: USER });
  });

  it('zwei Geräte am selben Tag ergeben eine Zeile beim Server, der zuletzt gesendete Wert gilt', async () => {
    const iphone = freshDevice();
    await saveWeight('2026-10-31', 79);
    const mac = freshDevice();
    await saveWeight('2026-10-31', 78.8);
    useDatabase(iphone);
    await syncOnce(remote, USER);
    useDatabase(mac);
    await syncOnce(remote, USER);
    useDatabase(iphone);
    await syncOnce(remote, USER);
    expect(remote.rows('body_weights')).toHaveLength(1);
    expect(remote.rows('body_weights')[0]).toMatchObject({ weight_kg: 78.8 });
    expect((await iphone.body_weights.toArray()).map((r) => r.weight_kg)).toEqual([78.8]);
  });

  it('ein neues Gerät holt die Werte vom Server', async () => {
    await saveWeight('2026-10-30', 78.5);
    await saveWeight('2026-10-31', 79);
    await syncOnce(remote, USER);
    const neu = freshDevice();
    await syncOnce(remote, USER);
    expect((await neu.body_weights.orderBy('day').toArray()).map((r) => [r.day, r.weight_kg])).toEqual([
      ['2026-10-30', 78.5],
      ['2026-10-31', 79],
    ]);
  });
});

describe('7-Tage-Schnitt', () => {
  const e = (day: string, weight_kg: number, deleted_at: string | null = null) => ({ day, weight_kg, deleted_at });

  it('rechnet die 7 Tage bis heute und die 7 Tage davor, fehlende Tage zählen nicht mit', () => {
    const rows = [
      e('2026-10-18', 80), // 13 Tage vor dem 31.: Vorwoche
      e('2026-10-24', 79.4), // 7 Tage vor dem 31.: Vorwoche
      e('2026-10-25', 79), // 6 Tage vor dem 31.: diese Woche
      e('2026-10-30', 78.5),
      e('2026-10-31', 79),
      e('2026-10-17', 90), // 14 Tage davor: zählt nirgends
    ];
    const s = weekStats(rows, '2026-10-31');
    expect(s.count).toBe(3);
    expect(s.avg).toBeCloseTo((79 + 78.5 + 79) / 3, 10);
    expect(s.prevCount).toBe(2);
    expect(s.prevAvg).toBeCloseTo(79.7, 10);
  });

  it('ohne Werte gibt es keinen Schnitt; entfernte Tage zählen nicht', () => {
    expect(weekStats([], '2026-10-31')).toEqual({ avg: null, count: 0, prevAvg: null, prevCount: 0 });
    const s = weekStats([e('2026-10-31', 79), e('2026-10-30', 70, '2026-10-31T08:00:00Z')], '2026-10-31');
    expect(s).toMatchObject({ avg: 79, count: 1, prevAvg: null });
  });

  it('die Kurve hat je Tag den Wert und den Schnitt der 7 Tage bis dahin', () => {
    const series = weightSeries([e('2026-10-31', 79), e('2026-10-25', 79), e('2026-10-30', 78.5), e('2026-10-17', 80)]);
    expect(series.map((p) => p.day)).toEqual(['2026-10-17', '2026-10-25', '2026-10-30', '2026-10-31']);
    expect(series[0].avg).toBe(80);
    expect(series[1].avg).toBe(79); // 17.10. liegt 8 Tage zurück
    expect(series[3].avg).toBeCloseTo(78.8333, 4);
  });

  it('Tage rechnen über Monatsende und Zeitumstellung hinweg', () => {
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26'); // Zeitumstellung am 25.10.2026
    expect(addDays('2026-11-01', -6)).toBe('2026-10-26');
    expect(addDays('2027-01-03', -13)).toBe('2026-12-21');
    expect(isDay('2026-10-31')).toBe(true);
    expect(isDay('2026-11-31')).toBe(false);
    expect(localDay(new Date(2026, 9, 31, 0, 30))).toBe('2026-10-31');
  });
});
