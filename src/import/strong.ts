import Papa from 'papaparse';
import { LIMITS } from '../db/limits';
import type { Exercise, SetKind, Workout, WorkoutExercise, WSet } from '../db/types';
import { stableId } from '../lib/ids';

// Liest den CSV-Export der App Strong. Strong hat das Format mehrfach geändert
// (Komma oder Semikolon, Spalten mit und ohne Einheit, Zeilen für den Pausentimer),
// darum werden die Spalten über Namen erkannt, nicht über ihre Position.

export interface ParsedSet {
  order: string; // "1", "W", "D", "F"
  kind: SetKind;
  weight_kg: number | null;
  reps: number | null;
  rpe: number | null;
  seconds: number | null;
  distance: number | null;
  note: string | null;
}

export interface ParsedExercise {
  name: string;
  sets: ParsedSet[];
}

export interface ParsedWorkout {
  key: string; // Datum|Name, eindeutig je Training
  date: Date;
  name: string;
  durationSec: number | null;
  note: string | null;
  exercises: ParsedExercise[];
}

export interface ParseResult {
  workouts: ParsedWorkout[];
  exerciseNames: { name: string; sets: number }[];
  skippedRows: number;
}

const LB = 0.45359237;

type Field =
  | 'workoutNo'
  | 'date'
  | 'workoutName'
  | 'duration'
  | 'exercise'
  | 'setOrder'
  | 'weight'
  | 'weightUnit'
  | 'reps'
  | 'rpe'
  | 'distance'
  | 'seconds'
  | 'notes'
  | 'workoutNotes';

const ALIASES: Record<Field, string[]> = {
  workoutNo: ['workout #', 'workout number'],
  date: ['date', 'datum'],
  workoutName: ['workout name', 'workout', 'trainingsname'],
  duration: ['duration', 'workout duration', 'dauer'],
  exercise: ['exercise name', 'exercise', 'übung', 'uebung'],
  setOrder: ['set order', 'set', 'satz'],
  weight: ['weight', 'gewicht'],
  weightUnit: ['weight unit', 'unit'],
  reps: ['reps', 'wiederholungen', 'wdh'],
  rpe: ['rpe'],
  distance: ['distance', 'distanz'],
  seconds: ['seconds', 'sekunden'],
  notes: ['notes', 'notizen'],
  workoutNotes: ['workout notes'],
};

function headerKey(h: string) {
  return h
    .replace(/^﻿/, '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .toLowerCase();
}

function unitOf(h: string): string | null {
  const m = h.match(/\((.*?)\)/);
  return m ? m[1].trim().toLowerCase() : null;
}

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const s = v.trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function text(v: string | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}

// "1h 5m", "45m", "3600", "01:05:00"
export function parseDuration(v: string | undefined): number | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const hms = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3] ?? 0);
  let total = 0;
  let matched = false;
  for (const [, n, u] of s.matchAll(/(\d+)\s*(h|m|min|s)\b/gi)) {
    matched = true;
    const k = u.toLowerCase();
    total += Number(n) * (k === 'h' ? 3600 : k === 's' ? 1 : 60);
  }
  return matched ? total : null;
}

// Strong schreibt "2024-05-01 18:30:12" in Ortszeit, ohne Zeitzone.
export function parseDate(v: string): Date | null {
  const s = v.trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  const de = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?/);
  if (de) return new Date(+de[3], +de[2] - 1, +de[1], +(de[4] ?? 0), +(de[5] ?? 0));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function kindOf(order: string): SetKind | null {
  const o = order.trim().toUpperCase();
  if (/^\d+$/.test(o)) return 'normal';
  if (o === 'W') return 'warmup';
  if (o === 'D') return 'drop';
  if (o === 'F') return 'failure';
  return null; // z. B. "Rest Timer"
}

export function parseStrongCsv(csv: string): ParseResult {
  const parsed = Papa.parse<string[]>(csv.replace(/^﻿/, ''), {
    skipEmptyLines: true,
    delimiter: '', // automatisch: Komma oder Semikolon
  });
  const [header, ...rows] = parsed.data;
  if (!header) throw new Error('Die Datei ist leer.');

  const col: Partial<Record<Field, number>> = {};
  let weightUnitFromHeader: string | null = null;
  header.forEach((h, i) => {
    const k = headerKey(h);
    for (const [field, names] of Object.entries(ALIASES) as [Field, string[]][]) {
      if (col[field] === undefined && names.includes(k)) {
        col[field] = i;
        if (field === 'weight') weightUnitFromHeader = unitOf(h);
      }
    }
  });
  for (const need of ['date', 'exercise', 'setOrder'] as Field[]) {
    if (col[need] === undefined) {
      throw new Error(`Spalte fehlt: ${need}. Gefunden: ${header.join(', ')}`);
    }
  }

  const get = (r: string[], f: Field) => (col[f] === undefined ? undefined : r[col[f]!]);
  const workouts = new Map<string, ParsedWorkout>();
  const counts = new Map<string, number>();
  let skipped = 0;

  for (const r of rows) {
    const date = parseDate(get(r, 'date') ?? '');
    const exName = text(get(r, 'exercise'));
    const order = (get(r, 'setOrder') ?? '').trim();
    const kind = kindOf(order);
    if (!date || !exName || !kind) {
      skipped++;
      continue;
    }
    const wName = text(get(r, 'workoutName')) ?? 'Training';
    // Schlüssel nur aus Datum (sekundengenau) und Name, nicht aus der laufenden Nummer von Strong:
    // Die kann sich zwischen zwei Exporten verschieben.
    const key = `${get(r, 'date')!.trim()}|${wName}`;
    let w = workouts.get(key);
    if (!w) {
      w = {
        key,
        date,
        name: wName,
        durationSec: parseDuration(get(r, 'duration')),
        note: text(get(r, 'workoutNotes')),
        exercises: [],
      };
      workouts.set(key, w);
    }
    // Neue Übungsgruppe, wenn der Name wechselt (gleiche Übung zweimal im Training bleibt getrennt).
    let ex = w.exercises[w.exercises.length - 1];
    if (!ex || ex.name !== exName) {
      ex = { name: exName, sets: [] };
      w.exercises.push(ex);
    }
    const unit = (text(get(r, 'weightUnit')) ?? weightUnitFromHeader ?? 'kg').toLowerCase();
    let weight = num(get(r, 'weight'));
    if (weight != null && unit.startsWith('lb')) weight = Math.round(weight * LB * 100) / 100;
    let reps = num(get(r, 'reps'));
    const notes = [text(get(r, 'notes'))];
    // Werte, die die Datenbank nicht nimmt, wandern in die Notiz statt verloren zu gehen.
    if (weight != null && (weight < 0 || weight > LIMITS.weightKg.max)) {
      notes.push(`${String(weight).replace('.', ',')} kg${weight < 0 ? ' (Unterstützung)' : ''}`);
      weight = null;
    }
    if (reps != null && (!Number.isInteger(reps) || reps < 0 || reps > LIMITS.reps.max)) {
      notes.push(`${String(reps).replace('.', ',')} Wdh.`);
      reps = reps >= 0 && reps <= LIMITS.reps.max ? Math.round(reps) : null;
    }
    ex.sets.push({
      order,
      kind,
      weight_kg: weight,
      reps,
      rpe: num(get(r, 'rpe')),
      seconds: num(get(r, 'seconds')),
      distance: num(get(r, 'distance')),
      note: notes.filter(Boolean).join(' · ') || null,
    });
    counts.set(exName, (counts.get(exName) ?? 0) + 1);
  }

  return {
    workouts: [...workouts.values()].sort((a, b) => a.date.getTime() - b.date.getTime()),
    exerciseNames: [...counts.entries()]
      .map(([name, sets]) => ({ name, sets }))
      .sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name)),
    skippedRows: skipped,
  };
}

export interface ImportRows {
  exercises: Exercise[];
  workouts: Workout[];
  workout_exercises: WorkoutExercise[];
  sets: WSet[];
}

// mapping: Strong-Name -> id einer bestehenden Übung. Fehlt ein Name, entsteht eine neue Übung.
// Alle ids sind fest aus dem Inhalt abgeleitet: Ein zweiter Import derselben Datei legt nichts doppelt an.
export async function buildImport(
  result: ParseResult,
  mapping: Record<string, string | undefined>,
  importedAt = new Date().toISOString(),
): Promise<ImportRows> {
  const out: ImportRows = { exercises: [], workouts: [], workout_exercises: [], sets: [] };
  const exerciseIds = new Map<string, string>();
  for (const { name } of result.exerciseNames) {
    const mapped = mapping[name];
    if (mapped) {
      exerciseIds.set(name, mapped);
    } else {
      const id = await stableId('strong-exercise', name);
      exerciseIds.set(name, id);
      out.exercises.push({
        id,
        name,
        unilateral: false,
        rest_seconds: null,
        note: 'aus Strong importiert',
        created_at: importedAt,
        deleted_at: null,
      });
    }
  }

  for (const w of result.workouts) {
    const started = w.date.toISOString();
    const finished = new Date(w.date.getTime() + (w.durationSec ?? 3600) * 1000).toISOString();
    const workoutId = await stableId('strong-workout', w.key);
    out.workouts.push({
      id: workoutId,
      template_id: null,
      name: w.name,
      started_at: started,
      finished_at: finished,
      note: w.note,
      source: 'strong',
      created_at: importedAt,
      deleted_at: null,
    });
    for (const [ei, ex] of w.exercises.entries()) {
      const weId = await stableId('strong-we', `${w.key}|${ei}`);
      const exerciseId = exerciseIds.get(ex.name)!;
      out.workout_exercises.push({
        id: weId,
        workout_id: workoutId,
        exercise_id: exerciseId,
        position: ei,
        note: null,
        created_at: importedAt,
        deleted_at: null,
      });
      for (const [si, s] of ex.sets.entries()) {
        out.sets.push({
          id: await stableId('strong-set', `${w.key}|${ei}|${si}`),
          workout_id: workoutId,
          workout_exercise_id: weId,
          exercise_id: exerciseId,
          position: si + 1,
          side: null,
          weight_kg: s.weight_kg,
          reps: s.reps,
          kind: s.kind,
          done_at: finished,
          rpe: s.rpe,
          note: [s.note, s.seconds ? `${s.seconds} s` : null, s.distance ? `${s.distance} m` : null]
            .filter(Boolean)
            .join(' · ') || null,
          created_at: importedAt,
          deleted_at: null,
        });
      }
    }
  }
  return out;
}

// Vorschlag für die Zuordnung: gleicher Name (ohne Groß/Klein und Klammern) oder bekanntes Wortpaar.
const HINTS: [RegExp, RegExp][] = [
  [/butterfly|pec deck|chest fly.*machine/i, /butterfly/i],
  [/cable.*(fly|crossover).*(low|up)|low.*cable.*fly/i, /kabel-flys/i],
  [/lateral raise/i, /seitheben/i],
  [/t[- ]?bar row/i, /t-bar/i],
  [/lat pull ?down.*(wide|machine)|wide.*lat pull/i, /latzug/i],
  [/reverse fly|rear delt/i, /reverse flys/i],
  [/front raise/i, /frontheben/i],
  [/external rotation/i, /außenrotation/i],
  [/wrist curl|forearm/i, /unterarme/i],
  [/hyperextension|back extension/i, /hyperextension/i],
  [/triceps.*(push ?down|extension).*cable|cable.*triceps/i, /trizeps/i],
  [/preacher curl/i, /preacher/i],
  [/(seated )?leg curl/i, /beinbeuger/i],
  [/leg extension/i, /beinstrecker/i],
  [/(hip )?adduct/i, /adduktoren/i],
  [/hack squat/i, /hackenschmidt/i],
  [/cable crunch/i, /cable crunches/i],
  [/calf.*(leg press)|calf press/i, /wadenheben/i],
  [/glute|booty|hip thrust.*machine/i, /booty/i],
  [/row.*(chest support|machine)|seated row/i, /enges rudern/i],
];

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();

export function suggestMapping(strongNames: string[], exercises: Exercise[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of strongNames) {
    const exact = exercises.find((e) => norm(e.name) === norm(name));
    if (exact) {
      out[name] = exact.id;
      continue;
    }
    const hint = HINTS.find(([from]) => from.test(name));
    const byHint = hint ? exercises.find((e) => hint[1].test(e.name)) : undefined;
    out[name] = byHint?.id;
  }
  return out;
}
