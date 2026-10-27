import { db, saveMany } from '../db/local';
import type { ImportRows } from './strong';

// Schreibt den Import in die lokale Kopie; von dort geht er wie jede Änderung an den Server.
// Zeilen, die es schon gibt (früherer Import), bleiben unangetastet.
export async function applyImport(rows: ImportRows) {
  const fresh = async <K extends keyof ImportRows>(table: K) => {
    const list = rows[table];
    const existing = await db.tbl(table).bulkGet(list.map((r) => r.id));
    return list.filter((_, i) => !existing[i]) as ImportRows[K];
  };
  const exercises = await fresh('exercises');
  const workouts = await fresh('workouts');
  const wes = await fresh('workout_exercises');
  const sets = await fresh('sets');
  await saveMany('exercises', exercises);
  await saveMany('workouts', workouts);
  await saveMany('workout_exercises', wes);
  await saveMany('sets', sets);
  return { exercises: exercises.length, workouts: workouts.length, sets: sets.length };
}
