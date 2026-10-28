import 'fake-indexeddb/auto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import {
  addExerciseToWorkout,
  addSet,
  createExercise,
  deleteWorkout,
  finishWorkout,
  moveWorkoutExercise,
  removeLastSet,
  seedPlanIfEmpty,
  startWorkout,
  updateSet,
} from '../../src/data/ops';
import { db, LocalDB, patch, softDelete, useDatabase } from '../../src/db/local';
import { TABLES, type Base, type TableName, type WSet } from '../../src/db/types';
import { supabaseRemote } from '../../src/sync/remote-supabase';
import { MAX_FAILS, syncOnce } from '../../src/sync/sync';

// Zufallstest für den Abgleich: zwei Geräte (iPhone und Mac, ein Konto), ein gemeinsamer Server im Speicher,
// ein schlechtes Netz. Der Server ist so nachgebaut, wie Supabase sich zeigt: PostgREST-Abfragen mit Seiten
// (über den echten supabaseRemote), ein Zeitstempel je Anweisung, Prüfungen und Fremdschlüssel aus der Migration.
// Nachstellen eines Fehlschlags: FUZZ_SEED=<seed> npx vitest run tests/unit/sync-fuzz.test.ts

const USER = '11111111-1111-4111-8111-111111111111';

// Feste ids je Durchlauf, damit ein seed immer denselben Ablauf ergibt.
const idSource = vi.hoisted(() => ({ next: (): string => crypto.randomUUID() }));
vi.mock('../../src/lib/ids', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/ids')>()),
  newId: () => idSource.next(),
}));

// ---------- Zufall ----------

function rngFrom(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    weighted<K extends string>(w: Record<K, number>): K {
      const entries = Object.entries(w) as [K, number][];
      let x = next() * entries.reduce((s, [, v]) => s + v, 0);
      for (const [k, v] of entries) if ((x -= v) < 0) return k;
      return entries[entries.length - 1][0];
    },
  };
}
type Rng = ReturnType<typeof rngFrom>;

function uuidFrom(r: Rng) {
  const h = Array.from({ length: 32 }, () => Math.floor(r.next() * 16).toString(16));
  h[12] = '4';
  h[16] = '89ab'[Math.floor(r.next() * 4)];
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function hash01(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h / 4294967296;
}

// ---------- Zeitstempel wie Postgres ----------

const TS_COLS = ['created_at', 'deleted_at', 'done_at', 'started_at', 'finished_at', 'updated_at'];

function toMicros(s: string): number {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)$/.exec(s);
  if (!m) throw new Error(`Zeitstempel nicht lesbar: ${s}`);
  return Date.parse(m[1] + m[3]) * 1000 + (m[2] ? Math.round(Number(`0${m[2]}`) * 1e6) : 0);
}

// So gibt Postgres timestamptz als JSON aus (mit PGlite nachgesehen): Mikrosekunden, Nullen am Ende weg, +00:00.
function pgTime(us: number): string {
  const sec = Math.floor(us / 1e6);
  const frac = String(us - sec * 1e6).padStart(6, '0').replace(/0+$/, '');
  return `${new Date(sec * 1000).toISOString().slice(0, 19)}${frac ? `.${frac}` : ''}+00:00`;
}

// ---------- Server ----------

type Row = Record<string, unknown> & { id: string };

// Spalten und Fremdschlüssel aus supabase/migrations/20261027000001_training.sql.
const COMMON = ['id', 'user_id', 'note', 'created_at', 'updated_at', 'deleted_at'];
const COLUMNS: Record<TableName, string[]> = {
  exercises: [...COMMON, 'name', 'unilateral', 'rest_seconds'],
  templates: [...COMMON, 'name', 'position'],
  template_exercises: [...COMMON, 'template_id', 'exercise_id', 'position', 'sets'],
  workouts: [...COMMON, 'template_id', 'name', 'started_at', 'finished_at', 'source'],
  workout_exercises: [...COMMON, 'workout_id', 'exercise_id', 'position'],
  sets: [...COMMON, 'workout_id', 'workout_exercise_id', 'exercise_id', 'position', 'side', 'weight_kg', 'reps', 'kind', 'done_at', 'rpe'],
};
const FK: Record<TableName, [string, TableName, boolean][]> = {
  exercises: [],
  templates: [],
  template_exercises: [['template_id', 'templates', true], ['exercise_id', 'exercises', true]],
  workouts: [['template_id', 'templates', false]],
  workout_exercises: [['workout_id', 'workouts', true], ['exercise_id', 'exercises', true]],
  sets: [['workout_id', 'workouts', true], ['workout_exercise_id', 'workout_exercises', true], ['exercise_id', 'exercises', true]],
};

const isInt = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const nameOk = (v: unknown) => typeof v === 'string' && v.length >= 1 && v.length <= 200;
const INT4 = 2147483647;

// Prüfungen der Datenbank. Gibt [Code, Meldung] zurück, wie Postgres ablehnen würde, sonst null.
function violation(table: TableName, r: Row): [string, string] | null {
  for (const k of Object.keys(r)) if (!COLUMNS[table].includes(k)) return ['PGRST204', `column ${k} not found`];
  if (r.user_id !== USER) return ['42501', 'new row violates row-level security policy'];
  if (typeof r.created_at !== 'string') return ['23502', 'created_at is null'];
  const ok = (() => {
    switch (table) {
      case 'exercises':
        return nameOk(r.name) && typeof r.unilateral === 'boolean' && (r.rest_seconds == null || isInt(r.rest_seconds, 0, 3600));
      case 'templates':
        return nameOk(r.name) && isInt(r.position, -INT4, INT4);
      case 'template_exercises':
        return isInt(r.position, -INT4, INT4) && isInt(r.sets, 0, 20);
      case 'workouts':
        return typeof r.name === 'string' && typeof r.started_at === 'string' && (r.source === 'app' || r.source === 'strong');
      case 'workout_exercises':
        return isInt(r.position, -INT4, INT4);
      case 'sets':
        return (
          isInt(r.position, 1, INT4) &&
          (r.side == null || r.side === 'L' || r.side === 'R') &&
          (r.weight_kg == null || (typeof r.weight_kg === 'number' && r.weight_kg >= 0 && r.weight_kg < 100000)) &&
          (r.reps == null || isInt(r.reps, 0, INT4)) &&
          ['normal', 'warmup', 'drop', 'failure'].includes(r.kind as string) &&
          (r.rpe == null || (typeof r.rpe === 'number' && Math.abs(r.rpe) < 100))
        );
    }
  })();
  if (!ok) return ['23514', 'violates check constraint'];
  return null;
}

class Server {
  tables = new Map<TableName, Map<string, Row>>(TABLES.map((t) => [t, new Map()]));
  rejectRow: (table: TableName, id: string) => boolean = () => false;
  rejections: string[] = [];
  private clock = toMicros('2026-10-27T10:00:00Z');
  constructor(private r: Rng) {}

  has(table: TableName, id: unknown) {
    return typeof id === 'string' && this.tables.get(table)!.has(id);
  }

  // now() in Postgres: ein Zeitstempel je Anweisung, oft gleich für viele Zeilen. Manchmal wird eine Anweisung,
  // die früher begonnen hat, erst nach einer späteren sichtbar (Zeitstempel kleiner als schon geholte).
  private stamp(): number {
    const x = this.r.next();
    if (x < 0.35) {
      // gleicher Zeitstempel wie die Anweisung davor
    } else if (x < 0.7) this.clock += this.r.int(1, 2000);
    else if (x < 0.95) this.clock += this.r.int(1, 120) * 1e6;
    else this.clock += this.r.int(5, 15) * 60e6;
    return this.r.chance(0.1) ? this.clock - this.r.int(0, 60e6) : this.clock;
  }

  // upsert über die id. Eine fehlerhafte Zeile lässt die ganze Anweisung scheitern, wie bei Postgres.
  upsert(table: TableName, rows: Row[]): { code: string; message: string } | null {
    for (const r of rows) {
      let v: [string, string] | null = this.rejectRow(table, r.id) ? ['23514', 'violates check constraint'] : violation(table, r);
      if (!v) {
        for (const [col, parent, required] of FK[table]) {
          if (r[col] == null ? required : !this.has(parent, r[col])) {
            v = ['23503', `violates foreign key constraint (${col})`];
            break;
          }
        }
      }
      if (v) {
        this.rejections.push(`${table}/${r.id}: ${v[1]}`);
        return { code: v[0], message: v[1] };
      }
    }
    const ts = pgTime(this.stamp());
    const t = this.tables.get(table)!;
    for (const r of rows) {
      const stored: Row = { id: r.id };
      for (const c of COLUMNS[table]) {
        const v = r[c] ?? null;
        stored[c] = TS_COLS.includes(c) && typeof v === 'string' ? pgTime(toMicros(v)) : v;
      }
      stored.updated_at = ts;
      t.set(r.id, stored);
    }
    return null;
  }
}

// ---------- Netz ----------

interface Net {
  offline: boolean;
  preFail: number; // Anfrage scheitert, bevor der Server etwas speichert
  lostAnswer: number; // Server speichert, die Antwort geht verloren
  failAtCall: number; // genau diese Anfrage scheitert (Fehler zwischen zwei Paketen oder zwei Seiten)
  pageSize: number;
  interleave: number; // Simon tippt weiter, während der Abgleich läuft
  calls: number;
  during: (() => Promise<void>) | null;
}

const PERFECT = (): Net => ({ offline: false, preFail: 0, lostAnswer: 0, failAtCall: 0, pageSize: 3, interleave: 0, calls: 0, during: null });
// So meldet supabase-js einen Netzfehler: Fehler ohne Code.
const NET_ERROR = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' };

// Nachbau des Abfrage-Bausteins von supabase-js, so weit supabaseRemote ihn nutzt.
function fakeClient(server: Server, ctx: { net: Net }, r: Rng): SupabaseClient {
  async function request<T>(apply: () => T, write: boolean): Promise<T | { data: null; error: typeof NET_ERROR; status: number }> {
    const net = ctx.net;
    const call = ++net.calls;
    if (net.offline || call === net.failAtCall || r.chance(net.preFail)) return { data: null, error: NET_ERROR, status: 0 };
    if (net.during && r.chance(net.interleave)) await net.during();
    const out = apply();
    if (net.during && r.chance(net.interleave)) await net.during();
    if (write && r.chance(net.lostAnswer)) return { data: null, error: NET_ERROR, status: 0 };
    return out;
  }
  const compare = (a: Row, b: Row, col: string) => {
    if (col === 'updated_at') return toMicros(a.updated_at as string) - toMicros(b.updated_at as string);
    if (col === 'id') return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    throw new Error(`Sortierung nach ${col} nicht nachgebaut`);
  };
  return {
    from(table: TableName) {
      const filters: ((row: Row) => boolean)[] = [];
      const orders: string[] = [];
      let limit = Infinity;
      const q = {
        select: () => q,
        gte: (col: string, v: string) => {
          filters.push((row) => toMicros(row[col] as string) >= toMicros(v));
          return q;
        },
        or: (expr: string) => {
          const m = /^updated_at\.gt\."(.+?)",and\(updated_at\.eq\."(.+?)",id\.gt\.(.+)\)$/.exec(expr);
          if (!m) throw new Error(`Filter nicht nachgebaut: ${expr}`);
          const gt = toMicros(m[1]);
          const eq = toMicros(m[2]);
          filters.push((row) => {
            const u = toMicros(row.updated_at as string);
            return u > gt || (u === eq && row.id > m[3]);
          });
          return q;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          if (opts?.ascending === false) throw new Error('absteigend nicht nachgebaut');
          orders.push(col);
          return q;
        },
        limit: (n: number) => {
          limit = n;
          return q;
        },
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          request(() => {
            const rows = [...server.tables.get(table)!.values()].filter((row) => filters.every((f) => f(row)));
            rows.sort((a, b) => {
              for (const c of orders) {
                const d = compare(a, b, c);
                if (d) return d;
              }
              return 0;
            });
            return { data: rows.slice(0, limit).map((x) => ({ ...x })), error: null };
          }, false).then(resolve, reject),
        upsert: (rows: Row[], opts?: { onConflict?: string }) => {
          if (opts?.onConflict !== 'id') throw new Error('upsert ohne onConflict id');
          return request(() => {
            // Wie PostgREST: Fremdschlüssel verletzt → 409, andere Regel → 400, sonst 201.
            const error = server.upsert(table, rows.map((x) => ({ ...x })));
            return { data: null, error, status: error ? (error.code === '23503' ? 409 : 400) : 201 };
          }, true);
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

// ---------- Geräte und Buchführung ----------

class Device {
  db: LocalDB;
  revs = new Map<string, number>();
  constructor(public name: string, runId: string) {
    this.db = new LocalDB(`fuzz-${runId}-${name}`);
  }
}

const alive = <T extends { deleted_at: string | null }>(x: T) => !x.deleted_at;
const short = (id: string) => id.slice(0, 8);
const plain = (row: object) => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_')));
// Inhalt einer Zeile ohne Felder, die nur Gerät oder Server setzen; Zeitpunkte als Zahl.
function content(row: object) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_') || k === 'updated_at' || k === 'user_id') continue;
    out[k] = TS_COLS.includes(k) && typeof v === 'string' ? toMicros(v) : v;
  }
  return out;
}
const canon = (o: object) => JSON.stringify(Object.keys(o).sort().map((k) => [k, (o as Record<string, unknown>)[k]]));

// Merkt sich jede Änderung, die ein Gerät selbst gemacht hat: Speichern erhöht _rev, Holen nicht.
class Tracker {
  writers = new Map<string, Set<string>>();
  last = new Map<string, Map<string, Record<string, unknown>>>();
  sets = new Set<string>();

  async scan(d: Device) {
    for (const table of TABLES) {
      for (const row of (await d.db.tbl(table).where('_dirty').anyOf(1, 2).toArray()) as Base[]) {
        const key = `${table}/${row.id}`;
        const rev = row._rev ?? 0;
        if (rev <= (d.revs.get(key) ?? 0)) continue;
        d.revs.set(key, rev);
        if (!this.writers.has(key)) this.writers.set(key, new Set());
        this.writers.get(key)!.add(d.name);
        if (!this.last.has(d.name)) this.last.set(d.name, new Map());
        this.last.get(d.name)!.set(key, content(row));
        if (table === 'sets') this.sets.add(row.id);
      }
    }
  }
}

// ---------- Was Simon tut ----------

const NAMES = ['Bankdrücken', 'Rudern eng', 'Kniebeuge', '  ', 'x'.repeat(230), 'Übung 7'];

function randomSetChange(r: Rng): Partial<WSet> {
  const weight = () => r.pick([0, 2.5, 20, 42.5, 60, 61.25, 100, 52.555, 150000, -5]);
  const reps = () => r.pick([0, 1, 5, 8, 10, 12, 7.6, 20000]);
  switch (r.int(0, 5)) {
    case 0:
      return { weight_kg: weight() };
    case 1:
      return { reps: reps() };
    case 2:
      return { weight_kg: weight(), reps: reps(), done_at: new Date().toISOString() };
    case 3:
      return { done_at: null };
    case 4:
      return { kind: r.pick(['normal', 'warmup', 'drop', 'failure'] as const) };
    default:
      return { rpe: r.pick([null, 7, 8.5, 12]) };
  }
}

async function userOp(r: Rng, say: (s: string) => void): Promise<void> {
  const workouts = (await db.workouts.toArray()).filter(alive);
  const open = workouts.filter((w) => !w.finished_at);
  const openIds = new Set(open.map((w) => w.id));
  const workoutIds = new Set(workouts.map((w) => w.id));
  const wes = (await db.workout_exercises.toArray()).filter((x) => alive(x) && workoutIds.has(x.workout_id));
  // Meist im laufenden Training, manchmal in einem alten.
  const pool = <T extends { workout_id: string }>(xs: T[]) => {
    const o = xs.filter((x) => openIds.has(x.workout_id));
    return o.length && r.chance(0.85) ? o : xs;
  };
  const op = r.weighted({
    start: 1,
    addSet: 3,
    editSet: 8,
    deleteSet: 1.5,
    removeLast: 1,
    addExercise: 1,
    finish: 1,
    newExercise: 0.7,
    rename: 1.2,
    move: 0.6,
    deleteWorkout: 0.15,
  });
  switch (op) {
    case 'addSet': {
      const p = pool(wes);
      if (!p.length) break;
      const we = r.pick(p);
      await addSet(we.id);
      return say(`Satz dazu in ${short(we.id)}`);
    }
    case 'editSet': {
      const sets = pool((await db.sets.toArray()).filter((s) => alive(s) && workoutIds.has(s.workout_id)));
      if (!sets.length) break;
      const s = r.pick(sets);
      const ch = randomSetChange(r);
      await updateSet(s.id, ch);
      return say(`Satz ${short(s.id)} ändern ${JSON.stringify(ch)}`);
    }
    case 'deleteSet': {
      const sets = pool((await db.sets.toArray()).filter(alive));
      if (!sets.length) break;
      const s = r.pick(sets);
      await softDelete('sets', s.id);
      return say(`Satz ${short(s.id)} löschen`);
    }
    case 'removeLast': {
      const p = pool(wes);
      if (!p.length) break;
      const we = r.pick(p);
      await removeLastSet(we.id);
      return say(`letzten Satz in ${short(we.id)} löschen`);
    }
    case 'addExercise': {
      const ex = (await db.exercises.toArray()).filter(alive);
      if (!open.length || !ex.length) break;
      const w = r.pick(open);
      const e = r.pick(ex);
      await addExerciseToWorkout(w.id, e.id, r.int(1, 3));
      return say(`Übung ${short(e.id)} in Training ${short(w.id)}`);
    }
    case 'finish': {
      if (!open.length) break;
      const w = r.pick(open);
      await finishWorkout(w.id);
      return say(`Training ${short(w.id)} beenden`);
    }
    case 'newExercise': {
      const id = await createExercise(r.pick(NAMES), r.chance(0.3));
      return say(`Übung ${short(id)} anlegen`);
    }
    case 'rename': {
      const ex = await db.exercises.toArray();
      if (!ex.length) break;
      const e = r.pick(ex);
      const name = r.pick(NAMES);
      await patch('exercises', e.id, { name });
      return say(`Übung ${short(e.id)} umbenennen in ${JSON.stringify(name.slice(0, 20))}`);
    }
    case 'move': {
      const p = pool(wes);
      if (!p.length) break;
      const we = r.pick(p);
      await moveWorkoutExercise(we.workout_id, we.id, r.chance(0.5) ? -1 : 1);
      return say(`Übung ${short(we.id)} verschieben`);
    }
    case 'deleteWorkout': {
      if (!workouts.length) break;
      const w = r.pick(workouts);
      await deleteWorkout(w.id);
      return say(`Training ${short(w.id)} löschen`);
    }
    case 'start':
      break;
  }
  const templates = (await db.templates.toArray()).filter(alive);
  const t = templates.length && !r.chance(0.2) ? r.pick(templates).id : null;
  const id = await startWorkout(t);
  say(`Training ${short(id)} starten`);
}

// ---------- Ein Durchlauf ----------

type Mode = 'netz' | 'ablehnung';

async function runOnce(seed: number, mode: Mode, log: string[]) {
  const r = rngFrom(seed);
  const idRng = rngFrom(seed ^ 0x5bd1e995);
  idSource.next = () => uuidFrom(idRng);
  vi.setSystemTime(Date.parse('2026-10-28T06:00:00Z'));
  const say = (s: string) => log.push(s);

  const server = new Server(r);
  const ctx = { net: PERFECT() };
  const client = fakeClient(server, ctx, r);
  const sync = () => syncOnce(supabaseRemote(client, ctx.net.pageSize), USER);
  const devices = [new Device('iPhone', `${mode}-${seed}`), new Device('Mac', `${mode}-${seed}`)];
  const tr = new Tracker();
  const use = (d: Device) => useDatabase(d.db);

  try {
    // Anfang wie in der App: iPhone legt den Plan an, der Mac holt ihn.
    use(devices[0]);
    await seedPlanIfEmpty();
    await tr.scan(devices[0]);
    await sync();
    use(devices[1]);
    await sync();
    const initial = new Set(TABLES.flatMap((t) => [...server.tables.get(t)!.keys()]));
    if (mode === 'ablehnung') {
      server.rejectRow = (table, id) => !initial.has(id) && hash01(`${seed}:${table}/${id}`) < 0.12;
    }

    const steps = r.int(30, 80);
    for (let i = 0; i < steps; i++) {
      const d = r.pick(devices);
      use(d);
      vi.setSystemTime(Date.now() + r.int(0, 90_000));
      if (r.chance(0.3)) {
        ctx.net = {
          offline: r.chance(0.15),
          preFail: r.pick([0, 0, 0.05, 0.2]),
          lostAnswer: r.pick([0, 0, 0.1, 0.3]),
          failAtCall: r.chance(0.3) ? r.int(1, 12) : 0,
          pageSize: r.pick([1, 2, 3, 5, 8, 1000]),
          interleave: r.pick([0, 0, 0.1, 0.3]),
          calls: 0,
          during: () => userOp(r, (s) => say(`${d.name}:   (während des Abgleichs) ${s}`)),
        };
        const n = ctx.net;
        const how = n.offline ? 'ohne Netz' : `Seite ${n.pageSize}, Ausfall ${n.preFail}, Antwort weg ${n.lostAnswer}, Abbruch bei ${n.failAtCall}`;
        try {
          const res = await sync();
          say(`${d.name}: Abgleich (${how}) gesendet ${res.sent}, abgelehnt ${res.rejected}, geholt ${res.received}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/Failed to fetch/.test(msg)) throw e; // nur Netzfehler sind hier erwartet
          say(`${d.name}: Abgleich (${how}) scheitert: ${msg}`);
        } finally {
          ctx.net = PERFECT();
        }
      } else {
        await userOp(r, (s) => say(`${d.name}: ${s}`));
      }
      await tr.scan(d);
    }

    // Netz wieder da: abgleichen, bis eine ganze Runde nichts mehr sendet.
    const maxRounds = mode === 'netz' ? 4 : MAX_FAILS + 3;
    let quiet = false;
    for (let round = 0; round < maxRounds && !quiet; round++) {
      quiet = true;
      for (const d of devices) {
        use(d);
        const res = await sync();
        say(`${d.name}: Abschluss-Abgleich ${round + 1}: gesendet ${res.sent}, abgelehnt ${res.rejected}, geholt ${res.received}`);
        await tr.scan(d);
        if (res.sent || res.rejected) quiet = false;
      }
    }

    const problems: string[] = [];
    if (!quiet) problems.push(`nach ${maxRounds} Runden wird immer noch gesendet oder abgelehnt`);
    if (mode === 'netz' && server.rejections.length) {
      problems.push(`Server hat abgelehnt, obwohl alles gültig sein sollte: ${server.rejections.slice(0, 3).join('; ')}`);
    }

    const held = new Set<string>(); // table/id, auf irgendeinem Gerät zurückgehalten
    for (const d of devices) {
      for (const table of TABLES) {
        const srv = server.tables.get(table)!;
        const local = (await d.db.tbl(table).toArray()) as Base[];
        const localIds = new Set(local.map((x) => x.id));
        for (const row of local) {
          const key = `${table}/${row.id}`;
          // (1) nichts mehr offen
          if (row._dirty === 1) problems.push(`${d.name}: ${key} ist noch offen (_dirty 1)`);
          if (row._dirty === 2) {
            held.add(key);
            const rec = row as unknown as Row;
            const why =
              server.rejectRow(table, row.id) ||
              FK[table].some(([col, parent]) => rec[col] != null && !server.has(parent, rec[col]));
            if (mode === 'netz') problems.push(`${d.name}: ${key} zurückgehalten, obwohl der Server nichts ablehnt`);
            else if (!why) problems.push(`${d.name}: ${key} zurückgehalten ohne Grund`);
            if (row._fails !== MAX_FAILS) problems.push(`${d.name}: ${key} zurückgehalten nach ${row._fails} statt ${MAX_FAILS} Versuchen`);
            if (srv.has(row.id)) problems.push(`${d.name}: ${key} zurückgehalten, liegt aber beim Server`);
            continue;
          }
          // (2) Zeile für Zeile wie beim Server
          const s = srv.get(row.id);
          if (!s) problems.push(`${d.name}: ${key} fehlt beim Server`);
          else if (canon(plain(row)) !== canon(s)) {
            problems.push(`${d.name}: ${key} weicht ab\n    Gerät:  ${canon(plain(row))}\n    Server: ${canon(s)}`);
          }
        }
        for (const id of srv.keys()) if (!localIds.has(id)) problems.push(`${d.name}: ${table}/${id} vom Server fehlt auf dem Gerät`);
      }
    }

    // (3) kein Satz verloren; gelöscht heißt deleted_at, nie verschwunden
    for (const id of tr.sets) {
      if (!server.has('sets', id) && !held.has(`sets/${id}`)) problems.push(`Satz ${id} ist verloren (nicht beim Server)`);
    }
    // (4) nur ein Gerät hat die Zeile geändert: dessen letzte Fassung steht beim Server
    for (const [key, who] of tr.writers) {
      if (who.size !== 1 || held.has(key)) continue;
      const [dev] = [...who];
      const [table, id] = key.split('/') as [TableName, string];
      const s = server.tables.get(table)!.get(id);
      const mine = tr.last.get(dev)!.get(key)!;
      if (!s) problems.push(`${key} (nur ${dev} geändert) fehlt beim Server`);
      else if (canon(content(s)) !== canon(mine)) {
        problems.push(`${key}: beim Server steht nicht die letzte Fassung von ${dev}\n    ${dev}: ${canon(mine)}\n    Server: ${canon(content(s))}`);
      }
    }

    if (problems.length) {
      throw new Error(`${problems.length} Abweichung(en):\n  ${problems.slice(0, 8).join('\n  ')}`);
    }
    return { held: held.size, rows: TABLES.reduce((n, t) => n + server.tables.get(t)!.size, 0) };
  } finally {
    for (const d of devices) await d.db.delete();
  }
}

async function fuzz(mode: Mode, runs: number, firstSeed: number) {
  const seeds = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: runs }, (_, i) => firstSeed + i);
  let held = 0;
  for (const seed of seeds) {
    const log: string[] = [];
    const t0 = performance.now();
    try {
      held += (await runOnce(seed, mode, log)).held;
      if (process.env.FUZZ_VERBOSE) console.log(`${mode} seed ${seed}: ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      throw new Error(
        `Abgleich-Zufallstest (${mode}) scheitert bei seed ${seed}.\n` +
          `Nachstellen: FUZZ_SEED=${seed} npx vitest run tests/unit/sync-fuzz.test.ts -t ${mode}\n${msg}\n` +
          `Letzte Schritte:\n  ${log.slice(-40).join('\n  ')}`,
      );
    }
  }
  return held;
}

describe('Abgleich im Zufallstest (zwei Geräte, schlechtes Netz)', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  // Im normalen Testlauf wenige Durchläufe (schnell); gründlich mit FUZZ_RUNS=200 (dauert einige Minuten).
  const RUNS = Number(process.env.FUZZ_RUNS ?? 20);

  it('netz: alle Geräte enden gleich wie der Server, nichts geht verloren', async () => {
    await fuzz('netz', RUNS, 1);
  }, 1_800_000);

  it('ablehnung: abgelehnte Zeilen werden nach 3 Versuchen zurückgehalten, der Rest kommt an', async () => {
    const held = await fuzz('ablehnung', Math.ceil(RUNS / 2), 10_001);
    // Der Block prüft nur etwas, wenn wirklich Zeilen zurückgehalten wurden.
    if (!process.env.FUZZ_SEED && held === 0) throw new Error('kein Durchlauf hat eine Zeile zurückgehalten');
  }, 1_800_000);
});
