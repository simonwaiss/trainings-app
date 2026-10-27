-- Trainings-App, Stufe 1: Übungen, Trainingstage, Trainings, Sätze.
-- Regeln: Jede Zeile gehört einem Nutzer (user_id). Zeilenrechte (RLS) lassen nur den eigenen Nutzer an seine Zeilen.
-- Gelöscht wird nie wirklich, nur markiert (deleted_at); die App darf gar nicht löschen (kein DELETE-Recht).
-- Ein Konto mit Daten lässt sich nicht löschen (on delete restrict), damit kein Klick im Dashboard alles mitnimmt.

-- Interner Bereich, nicht über die Datenschnittstelle erreichbar.
create schema if not exists intern;
revoke all on schema intern from public, anon, authenticated;

create or replace function intern.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------- Tabellen ----------

create table public.exercises (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  name text not null check (length(name) between 1 and 200),
  unilateral boolean not null default false,
  rest_seconds integer check (rest_seconds between 0 and 3600),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.exercises is 'Übungen. unilateral = einarmig/einbeinig, Sätze je Seite (L/R).';

create table public.templates (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  name text not null check (length(name) between 1 and 200),
  position integer not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.templates is 'Trainingstage (Vorlagen), z. B. Torso, Limbs.';

create table public.template_exercises (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  template_id uuid not null references public.templates (id),
  exercise_id uuid not null references public.exercises (id),
  position integer not null,
  sets integer not null default 2 check (sets between 0 and 20),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.template_exercises is 'Übungen eines Trainingstags in Reihenfolge, mit geplanter Satzzahl (je Seite bei einarmigen Übungen).';

create table public.workouts (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  template_id uuid references public.templates (id),
  name text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  note text,
  source text not null default 'app' check (source in ('app', 'strong')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.workouts is 'Ein Training. finished_at null = läuft noch. source strong = aus Strong importiert.';

create table public.workout_exercises (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  workout_id uuid not null references public.workouts (id),
  exercise_id uuid not null references public.exercises (id),
  position integer not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.sets (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  workout_id uuid not null references public.workouts (id),
  workout_exercise_id uuid not null references public.workout_exercises (id),
  exercise_id uuid not null references public.exercises (id),
  position integer not null check (position >= 1),
  side text check (side in ('L', 'R')),
  weight_kg numeric(7, 2) check (weight_kg >= 0),
  reps integer check (reps >= 0),
  kind text not null default 'normal' check (kind in ('normal', 'warmup', 'drop', 'failure')),
  done_at timestamptz,
  rpe numeric(3, 1),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.sets is 'Ein Satz. side L/R nur bei einarmigen Übungen. Gültig sind Zeilen mit deleted_at null; erledigt = done_at nicht null.';

-- ---------- Auslöser, Indizes, Rechte ----------

do $$
declare t text;
begin
  foreach t in array array['exercises', 'templates', 'template_exercises', 'workouts', 'workout_exercises', 'sets'] loop
    execute format('create trigger set_updated_at before insert or update on public.%I
                    for each row execute function intern.set_updated_at()', t);
    execute format('create index %I on public.%I (user_id, updated_at)', t || '_sync_idx', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('create policy eigene_zeilen_lesen on public.%I for select to authenticated
                    using (user_id = (select auth.uid()))', t);
    execute format('create policy eigene_zeilen_anlegen on public.%I for insert to authenticated
                    with check (user_id = (select auth.uid()))', t);
    execute format('create policy eigene_zeilen_aendern on public.%I for update to authenticated
                    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

grant execute on function intern.set_updated_at() to authenticated;
grant usage on schema intern to authenticated;

create index template_exercises_template_idx on public.template_exercises (template_id);
create index workout_exercises_workout_idx on public.workout_exercises (workout_id);
create index sets_workout_exercise_idx on public.sets (workout_exercise_id);
create index sets_exercise_idx on public.sets (exercise_id);
create index sets_workout_idx on public.sets (workout_id);
create index workouts_started_idx on public.workouts (user_id, started_at);

-- ---------- Ansicht für Auswertungen (Claude liest per SQL) ----------

create view public.v_saetze with (security_invoker = true) as
select
  w.started_at::date as datum,
  w.started_at,
  w.name as training,
  e.name as uebung,
  we.position as uebung_nr,
  s.position as satz,
  s.side as seite,
  s.kind as art,
  s.weight_kg as kg,
  s.reps as wdh,
  case when s.weight_kg > 0 and s.reps > 0
       then round(s.weight_kg * (1 + s.reps / 30.0), 1) end as e1rm,
  s.rpe,
  s.note as notiz,
  w.source as quelle,
  s.user_id,
  s.exercise_id,
  s.workout_id
from public.sets s
join public.workouts w on w.id = s.workout_id
join public.workout_exercises we on we.id = s.workout_exercise_id
join public.exercises e on e.id = s.exercise_id
where s.deleted_at is null
  and w.deleted_at is null
  and we.deleted_at is null
  and (s.weight_kg is not null or s.reps is not null);
comment on view public.v_saetze is 'Alle gültigen Sätze mit Datum, Übung und geschätztem Maximum (e1rm, Epley). Für Auswertungen.';
revoke all on public.v_saetze from anon, authenticated;
grant select on public.v_saetze to authenticated;

-- ---------- Nur Simon kommt rein ----------
-- Die Datenbank lehnt jedes neue Konto ab, außer der Adresse in intern.erlaubte_adressen,
-- und auch die nur, solange es noch gar kein Konto gibt. Die Adresse steht nicht im (öffentlichen) Code;
-- sie wird einmal per SQL eingetragen.

create table intern.erlaubte_adressen (email text primary key);
revoke all on intern.erlaubte_adressen from public, anon, authenticated;

create or replace function intern.nur_erlaubte_konten() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from intern.erlaubte_adressen a where a.email = lower(new.email)) then
    raise exception 'Registrierung gesperrt';
  end if;
  if exists (select 1 from auth.users) then
    raise exception 'Registrierung gesperrt';
  end if;
  return new;
end $$;
revoke all on function intern.nur_erlaubte_konten() from public, anon, authenticated;

create trigger nur_erlaubte_konten before insert on auth.users
for each row execute function intern.nur_erlaubte_konten();
