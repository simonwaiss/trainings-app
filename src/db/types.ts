// Zeilen wie in der Datenbank (supabase/migrations). Lokal kommen _dirty und _rev dazu.

export interface Base {
  id: string;
  user_id?: string;
  created_at: string;
  updated_at?: string; // setzt der Server
  deleted_at: string | null;
  _dirty?: 0 | 1 | 2; // 1 = noch nicht beim Server, 2 = vom Server mehrfach abgelehnt, zurückgehalten
  _rev?: number; // lokaler Zähler, damit eine Änderung während des Sendens nicht verloren geht
  _fails?: number; // wie oft der Server diese Zeile abgelehnt hat
  _error?: string | null; // letzter Ablehnungsgrund
}

export interface Exercise extends Base {
  name: string;
  unilateral: boolean; // einarmig/einbeinig: Sätze je Seite
  rest_seconds: number | null;
  note: string | null;
}

export interface Template extends Base {
  name: string;
  position: number;
  note: string | null;
}

export interface TemplateExercise extends Base {
  template_id: string;
  exercise_id: string;
  position: number;
  sets: number;
  note: string | null;
}

export interface Workout extends Base {
  template_id: string | null;
  name: string;
  started_at: string;
  finished_at: string | null;
  note: string | null;
  source: 'app' | 'strong';
}

export interface WorkoutExercise extends Base {
  workout_id: string;
  exercise_id: string;
  position: number;
  note: string | null;
}

export type Side = 'L' | 'R';
export type SetKind = 'normal' | 'warmup' | 'drop' | 'failure';

export interface WSet extends Base {
  workout_id: string;
  workout_exercise_id: string;
  exercise_id: string;
  position: number; // Satznummer ab 1
  side: Side | null;
  weight_kg: number | null;
  reps: number | null;
  kind: SetKind;
  done_at: string | null;
  rpe: number | null;
  note: string | null;
}

export type TableName =
  | 'exercises'
  | 'templates'
  | 'template_exercises'
  | 'workouts'
  | 'workout_exercises'
  | 'sets';

// Reihenfolge beim Senden: erst Eltern, dann Kinder (Fremdschlüssel).
export const TABLES: TableName[] = [
  'exercises',
  'templates',
  'template_exercises',
  'workouts',
  'workout_exercises',
  'sets',
];

export interface RowByTable {
  exercises: Exercise;
  templates: Template;
  template_exercises: TemplateExercise;
  workouts: Workout;
  workout_exercises: WorkoutExercise;
  sets: WSet;
}
