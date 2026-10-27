import Dexie, { type Table } from 'dexie';
import { sanitize } from './limits';
import type {
  Exercise,
  RowByTable,
  TableName,
  Template,
  TemplateExercise,
  Workout,
  WorkoutExercise,
  WSet,
} from './types';

// Lokale Zwischenkopie im Browser (IndexedDB). Die Wahrheit liegt in Supabase;
// hier liegt, was noch nicht gesendet ist (_dirty = 1), und alles zum Anzeigen ohne Netz.
export class LocalDB extends Dexie {
  exercises!: Table<Exercise, string>;
  templates!: Table<Template, string>;
  template_exercises!: Table<TemplateExercise, string>;
  workouts!: Table<Workout, string>;
  workout_exercises!: Table<WorkoutExercise, string>;
  sets!: Table<WSet, string>;
  meta!: Table<{ key: string; value: unknown }, string>;

  constructor(name = 'trainings-app') {
    super(name);
    this.version(1).stores({
      exercises: 'id, _dirty, name',
      templates: 'id, _dirty, position',
      template_exercises: 'id, _dirty, template_id, exercise_id',
      workouts: 'id, _dirty, started_at, finished_at, template_id',
      workout_exercises: 'id, _dirty, workout_id, exercise_id',
      sets: 'id, _dirty, workout_exercise_id, workout_id, exercise_id',
      meta: 'key',
    });
  }

  tbl<T extends TableName>(name: T): Table<RowByTable[T], string> {
    return this[name] as unknown as Table<RowByTable[T], string>;
  }
}

export let db = new LocalDB();

// Nur für Tests: frische Datenbank.
export function useDatabase(next: LocalDB) {
  db = next;
}

let onChange: (() => void) | null = null;
export function setChangeListener(fn: (() => void) | null) {
  onChange = fn;
}

export function nowIso() {
  return new Date().toISOString();
}

// Jede Änderung geht hier durch: Zeile als „noch zu senden“ markieren und Senden anstoßen.
export async function save<T extends TableName>(table: T, row: RowByTable[T]): Promise<RowByTable[T]> {
  const t = db.tbl(table);
  const saved = await db.transaction('rw', t, async () => {
    const current = await t.get(row.id);
    const next = { ...sanitize(table, row), _dirty: 1 as const, _rev: (current?._rev ?? 0) + 1, _fails: 0, _error: null };
    await t.put(next);
    return next;
  });
  onChange?.();
  return saved;
}

export async function saveMany<T extends TableName>(table: T, rows: RowByTable[T][]) {
  if (rows.length === 0) return;
  const t = db.tbl(table);
  await db.transaction('rw', t, async () => {
    const current = await t.bulkGet(rows.map((r) => r.id));
    await t.bulkPut(
      rows.map((r, i) => ({ ...sanitize(table, r), _dirty: 1 as const, _rev: (current[i]?._rev ?? 0) + 1, _fails: 0, _error: null })),
    );
  });
  onChange?.();
}

export async function patch<T extends TableName>(
  table: T,
  id: string,
  changes: Partial<RowByTable[T]>,
): Promise<void> {
  const t = db.tbl(table);
  await db.transaction('rw', t, async () => {
    const current = await t.get(id);
    if (!current) throw new Error(`${table}/${id} fehlt`);
    await t.put({ ...sanitize(table, { ...current, ...changes }), _dirty: 1, _rev: (current._rev ?? 0) + 1, _fails: 0, _error: null });
  });
  onChange?.();
}

// Löschen heißt immer: als gelöscht markieren. Nichts verschwindet wirklich.
export function softDelete<T extends TableName>(table: T, id: string) {
  return patch(table, id, { deleted_at: nowIso() } as Partial<RowByTable[T]>);
}

export async function getMeta<V>(key: string): Promise<V | undefined> {
  return (await db.meta.get(key))?.value as V | undefined;
}

export async function setMeta(key: string, value: unknown) {
  await db.meta.put({ key, value });
}

const ALL: TableName[] = ['exercises', 'templates', 'template_exercises', 'workouts', 'workout_exercises', 'sets'];

export async function pendingCount(state: 1 | 2 = 1): Promise<number> {
  let n = 0;
  for (const name of ALL) n += await db.tbl(name).where('_dirty').equals(state).count();
  return n;
}

// Zurückgehaltene Zeilen (vom Server abgelehnt), zum Anzeigen unter „Mehr“.
export async function heldRows() {
  const out: { table: TableName; id: string; error: string | null }[] = [];
  for (const name of ALL) {
    for (const r of await db.tbl(name).where('_dirty').equals(2).toArray()) {
      out.push({ table: name, id: r.id, error: r._error ?? null });
    }
  }
  return out;
}

// Zurückgehaltene Zeilen noch einmal senden (nach einem Update der App oder der Datenbank).
export async function retryHeld() {
  for (const name of ALL) {
    const t = db.tbl(name);
    await db.transaction('rw', t, async () => {
      for (const r of await t.where('_dirty').equals(2).toArray()) {
        await t.put({ ...sanitize(name, r), _dirty: 1, _fails: 0, _error: null });
      }
    });
  }
  onChange?.();
}
