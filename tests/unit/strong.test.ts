import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, LocalDB, useDatabase } from '../../src/db/local';
import { previousSets, seedPlanIfEmpty, startWorkout } from '../../src/data/ops';
import { applyImport } from '../../src/import/apply';
import { buildImport, parseDuration, parseStrongCsv, suggestMapping } from '../../src/import/strong';

// Neueres Strong-Format: Komma, Einheit in der Kopfzeile, Zeilen für den Pausentimer.
const NEW_FORMAT = `Workout #,Date,Workout Name,Duration (sec),Exercise Name,Set Order,Weight (kg),Reps,RPE,Distance (meters),Seconds,Notes,Workout Notes
1,2026-10-20 18:02:11,Torso,4210,Butterfly (Machine),W,30,12,,,,,
1,2026-10-20 18:02:11,Torso,4210,Butterfly (Machine),1,55,11,8,,,,
1,2026-10-20 18:02:11,Torso,4210,Butterfly (Machine),2,55,9,,,,"schwer, gut",
1,2026-10-20 18:02:11,Torso,4210,Butterfly (Machine),Rest Timer,,,,,90,,
1,2026-10-20 18:02:11,Torso,4210,Lateral Raise (Cable),1,7.5,15,,,,,
1,2026-10-20 18:02:11,Torso,4210,Reverse Fly (Cable),1,10,14,,,,,
1,2026-10-20 18:02:11,Torso,4210,Lateral Raise (Cable),1,7.5,14,,,,,
2,2026-10-23 17:30:00,Limbs,3600,Preacher Curl (Machine),1,25,10,,,,,Beine müde
2,2026-10-23 17:30:00,Limbs,3600,Preacher Curl (Machine),2,25,8,,,,,Beine müde
`;

// Älteres Format: Semikolon, eigene Einheiten-Spalte, Dauer als Text, Pfund.
const OLD_FORMAT = `Date;Workout Name;Exercise Name;Set Order;Weight;Weight Unit;Reps;RPE;Distance;Distance Unit;Seconds;Notes;Workout Notes;Workout Duration
2025-03-01 09:15:00;Push;Bench Press (Barbell);1;135;lbs;8;;;;;;;1h 5m
2025-03-01 09:15:00;Push;Bench Press (Barbell);2;135;lbs;7;;;;;;;1h 5m
2025-03-01 09:15:00;Push;Plank;1;;;;;;;60;;;1h 5m
`;

let n = 0;
beforeEach(() => useDatabase(new LocalDB(`strong-${++n}`)));

describe('Strong-Import', () => {
  it('liest das neue Format samt Aufwärmsätzen und ohne Pausentimer-Zeilen', () => {
    const r = parseStrongCsv(NEW_FORMAT);
    expect(r.workouts).toHaveLength(2);
    expect(r.skippedRows).toBe(1);
    const torso = r.workouts[0];
    expect(torso.name).toBe('Torso');
    expect(torso.durationSec).toBe(4210);
    expect(torso.exercises.map((e) => e.name)).toEqual([
      'Butterfly (Machine)',
      'Lateral Raise (Cable)',
      'Reverse Fly (Cable)',
      'Lateral Raise (Cable)',
    ]);
    expect(torso.exercises[0].sets.map((s) => s.kind)).toEqual(['warmup', 'normal', 'normal']);
    expect(torso.exercises[0].sets[2]).toMatchObject({ weight_kg: 55, reps: 9, note: 'schwer, gut', rpe: null });
    expect(r.workouts[1].note).toBe('Beine müde');
    expect(r.exerciseNames[0]).toEqual({ name: 'Butterfly (Machine)', sets: 3 });
  });

  it('liest das alte Format mit Semikolon und rechnet Pfund in Kilo um', () => {
    const r = parseStrongCsv(OLD_FORMAT);
    expect(r.workouts).toHaveLength(1);
    expect(r.workouts[0].durationSec).toBe(3900);
    const bench = r.workouts[0].exercises[0];
    expect(bench.sets[0].weight_kg).toBeCloseTo(61.23, 2);
    expect(r.workouts[0].exercises[1].sets[0].seconds).toBe(60);
  });

  it('versteht die Dauer in mehreren Schreibweisen', () => {
    expect(parseDuration('45m')).toBe(2700);
    expect(parseDuration('1h 5m')).toBe(3900);
    expect(parseDuration('01:05:00')).toBe(3900);
    expect(parseDuration('3600')).toBe(3600);
    expect(parseDuration('')).toBeNull();
  });

  it('meldet eine fremde Datei verständlich', () => {
    expect(() => parseStrongCsv('a,b,c\n1,2,3\n')).toThrow(/Spalte fehlt/);
  });

  it('ordnet Strong-Namen den Übungen aus dem Plan zu und importiert ohne Doppelte', async () => {
    await seedPlanIfEmpty();
    const exercises = await db.exercises.toArray();
    const parsed = parseStrongCsv(NEW_FORMAT);
    const mapping = suggestMapping(parsed.exerciseNames.map((e) => e.name), exercises);
    const byName = (id?: string) => exercises.find((e) => e.id === id)?.name;
    expect(byName(mapping['Butterfly (Machine)'])).toBe('Butterfly (Maschine)');
    expect(byName(mapping['Lateral Raise (Cable)'])).toBe('Seitheben');
    expect(byName(mapping['Preacher Curl (Machine)'])).toBe('Preacher Curls');

    const first = await applyImport(await buildImport(parsed, mapping));
    expect(first).toEqual({ exercises: 0, workouts: 2, sets: 8 });
    const second = await applyImport(await buildImport(parsed, mapping));
    expect(second).toEqual({ exercises: 0, workouts: 0, sets: 0 });
    expect(await db.sets.count()).toBe(8);

    // Danach zeigt ein neues Torso-Training die Strong-Werte als Vorwerte.
    const torso = (await db.templates.toArray()).find((t) => t.name === 'Torso')!;
    const wid = await startWorkout(torso.id);
    const workout = (await db.workouts.get(wid))!;
    const butterfly = (await db.workout_exercises.where('workout_id').equals(wid).toArray()).find((w) => w.position === 0)!;
    const prev = await previousSets(butterfly, workout);
    // Der Aufwärmsatz aus Strong zählt nicht mit.
    expect(prev.get('1|')).toEqual({ weight_kg: 55, reps: 11 });
    expect(prev.get('2|')).toEqual({ weight_kg: 55, reps: 9 });
  });

  it('legt Trainings nicht doppelt an, wenn Strong die Nummern verschiebt', async () => {
    const shifted = NEW_FORMAT.replace(/^1,/gm, '7,').replace(/^2,/gm, '8,');
    const a = await buildImport(parseStrongCsv(NEW_FORMAT), {});
    const b = await buildImport(parseStrongCsv(shifted), {});
    expect(b.workouts.map((w) => w.id)).toEqual(a.workouts.map((w) => w.id));
    expect(b.sets.map((s) => s.id)).toEqual(a.sets.map((s) => s.id));
  });

  it('übernimmt Werte, die die Datenbank nicht nimmt, in die Notiz', () => {
    const csv = `Date,Workout Name,Exercise Name,Set Order,Weight,Reps
2026-01-05 10:00:00,Rücken,Assisted Pull Up,1,-20,8
2026-01-05 10:00:00,Rücken,Assisted Pull Up,2,-20,7.5
`;
    const [set1, set2] = parseStrongCsv(csv).workouts[0].exercises[0].sets;
    expect(set1).toMatchObject({ weight_kg: null, reps: 8, note: '-20 kg (Unterstützung)' });
    expect(set2).toMatchObject({ weight_kg: null, reps: 8, note: '-20 kg (Unterstützung) · 7,5 Wdh.' });
  });

  it('legt unbekannte Übungen neu an', async () => {
    const parsed = parseStrongCsv(OLD_FORMAT);
    const rows = await buildImport(parsed, {});
    expect(rows.exercises.map((e) => e.name).sort()).toEqual(['Bench Press (Barbell)', 'Plank']);
    expect(rows.sets.find((s) => s.reps === null)?.note).toBe('60 s');
  });
});
