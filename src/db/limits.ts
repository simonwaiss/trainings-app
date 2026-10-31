import type { RowByTable, TableName } from './types';

// Grenzen der Datenbank (supabase/migrations). Jede Änderung wird vor dem Speichern hier eingepasst,
// damit der Server keine Zeile ablehnt; eine abgelehnte Zeile käme sonst nie an.
export const LIMITS = {
  nameLength: 200,
  templateSets: { min: 1, max: 20 },
  restSeconds: { min: 0, max: 3600 },
  weightKg: { min: 0, max: 99999.99 },
  reps: { min: 0, max: 10000 },
  rpe: { min: 0, max: 10 },
  bodyWeightKg: { min: 20, max: 300 },
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function num(v: unknown, min: number, max: number, decimals: number): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return clamp(Math.round(n * f) / f, min, max);
}

function name(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim().slice(0, LIMITS.nameLength);
  return s || fallback;
}

export function sanitize<T extends TableName>(table: T, row: RowByTable[T]): RowByTable[T] {
  const r = { ...row } as Record<string, unknown>;
  switch (table) {
    case 'exercises':
      r.name = name(r.name, 'Übung');
      r.rest_seconds = num(r.rest_seconds, LIMITS.restSeconds.min, LIMITS.restSeconds.max, 0);
      r.unilateral = !!r.unilateral;
      break;
    case 'templates':
      r.name = name(r.name, 'Trainingstag');
      r.position = Math.round(Number(r.position) || 0);
      break;
    case 'template_exercises':
      r.sets = num(r.sets, LIMITS.templateSets.min, LIMITS.templateSets.max, 0) ?? 1;
      r.position = Math.round(Number(r.position) || 0);
      break;
    case 'workouts':
      r.name = name(r.name, 'Training');
      break;
    case 'workout_exercises':
      r.position = Math.round(Number(r.position) || 0);
      break;
    case 'sets':
      r.weight_kg = num(r.weight_kg, LIMITS.weightKg.min, LIMITS.weightKg.max, 2);
      r.reps = num(r.reps, LIMITS.reps.min, LIMITS.reps.max, 0);
      r.rpe = num(r.rpe, LIMITS.rpe.min, LIMITS.rpe.max, 1);
      r.position = Math.max(1, Math.round(Number(r.position) || 1));
      if (r.side !== 'L' && r.side !== 'R') r.side = null;
      if (!['normal', 'warmup', 'drop', 'failure'].includes(r.kind as string)) r.kind = 'normal';
      break;
    case 'body_weights':
      // saveWeight lässt nur Werte in diesem Bereich zu; das hier fängt nur Ausreißer ab.
      r.weight_kg = num(r.weight_kg, LIMITS.bodyWeightKg.min, LIMITS.bodyWeightKg.max, 2);
      if (r.source !== 'vault') r.source = 'app';
      break;
  }
  return r as unknown as RowByTable[T];
}
