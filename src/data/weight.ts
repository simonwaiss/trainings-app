import { LIMITS } from '../db/limits';
import { db, nowIso, save, softDelete } from '../db/local';
import type { BodyWeight } from '../db/types';
import { stableId } from '../lib/ids';

// Körpergewicht: ein Wert je Tag. Die id kommt fest aus dem Tag: Zweimal Speichern, zwei Geräte am selben Tag
// und der Import aus dem Vault schreiben so immer in dieselbe Zeile, doppelte Tage gibt es nicht.
export const weightId = (day: string) => stableId('gewicht', day);

// Tag in Ortszeit als JJJJ-MM-TT.
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Tage verschieben; gerechnet wird in UTC, damit die Zeitumstellung keinen Tag verschluckt.
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;

export const weightOk = (kg: number | null): kg is number =>
  kg != null && kg >= LIMITS.bodyWeightKg.min && kg <= LIMITS.bodyWeightKg.max;

export async function saveWeight(day: string, kg: number): Promise<BodyWeight> {
  if (!isDay(day)) throw new Error(`Ungültiger Tag: ${day}`);
  if (!weightOk(kg)) throw new Error(`Gewicht außerhalb von ${LIMITS.bodyWeightKg.min} bis ${LIMITS.bodyWeightKg.max} kg`);
  const id = await weightId(day);
  const current = await db.body_weights.get(id);
  return save('body_weights', {
    ...(current ?? { id, day, note: null, created_at: nowIso() }),
    weight_kg: kg,
    source: 'app',
    deleted_at: null,
  });
}

export async function removeWeight(day: string) {
  await softDelete('body_weights', await weightId(day));
}

type Entry = Pick<BodyWeight, 'day' | 'weight_kg' | 'deleted_at'>;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function inRange(rows: Entry[], from: string, to: string) {
  return rows.filter((r) => !r.deleted_at && r.day >= from && r.day <= to).map((r) => r.weight_kg);
}

export interface WeekStats {
  avg: number | null; // Schnitt der 7 Tage bis einschließlich heute
  count: number; // so viele dieser Tage haben einen Wert
  prevAvg: number | null; // Schnitt der 7 Tage davor
  prevCount: number;
}

// Wie die Ansicht v_gewicht in der Datenbank: Fehlende Tage zählen nicht mit.
export function weekStats(rows: Entry[], today: string): WeekStats {
  const week = inRange(rows, addDays(today, -6), today);
  const prev = inRange(rows, addDays(today, -13), addDays(today, -7));
  return { avg: mean(week), count: week.length, prevAvg: mean(prev), prevCount: prev.length };
}

// Je Tag mit Wert: der Wert und der Schnitt der 7 Tage bis zu diesem Tag (für die Kurve).
export function weightSeries(rows: Entry[]): { day: string; kg: number; avg: number }[] {
  const alive = rows.filter((r) => !r.deleted_at).sort((a, b) => a.day.localeCompare(b.day));
  return alive.map((r) => ({ day: r.day, kg: r.weight_kg, avg: mean(inRange(alive, addDays(r.day, -6), r.day))! }));
}
