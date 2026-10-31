-- Trainings-App, Stufe 2: Körpergewicht, ein Wert je Tag.
-- Gleiche Regeln wie bei den Trainings: Jede Zeile gehört einem Nutzer, Zeilenrechte (RLS) lassen nur ihn heran,
-- gelöscht wird nur markiert (deleted_at). Die App bildet die id fest aus dem Tag (src/data/weight.ts): Zwei Geräte,
-- die denselben Tag eintragen, schreiben so in dieselbe Zeile.

create table public.body_weights (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  day date not null,
  weight_kg numeric(5, 2) not null check (weight_kg between 20 and 300),
  source text not null default 'app' check (source in ('app', 'vault')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, day)
);
comment on table public.body_weights is 'Körpergewicht, ein Wert je Tag (morgens nüchtern). source vault = aus der Vault-Notiz Körpergewicht übernommen.';

create trigger set_updated_at before insert or update on public.body_weights
for each row execute function intern.set_updated_at();
create index body_weights_sync_idx on public.body_weights (user_id, updated_at);
alter table public.body_weights enable row level security;
revoke all on public.body_weights from anon, authenticated;
grant select, insert, update on public.body_weights to authenticated;
create policy eigene_zeilen_lesen on public.body_weights for select to authenticated
  using (user_id = (select auth.uid()));
create policy eigene_zeilen_anlegen on public.body_weights for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy eigene_zeilen_aendern on public.body_weights for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- Ansicht für Auswertungen (Claude liest per SQL) ----------
-- Je Tag mit Wert: der Schnitt der 7 Tage bis einschließlich dieses Tags und der 7 Tage davor.
-- An einem Sonntag ist das Montag bis Sonntag gegen die Woche davor. Fehlende Tage zählen nicht mit (werte_7).

create view public.v_gewicht with (security_invoker = true) as
select
  b.day as datum,
  b.weight_kg as kg,
  round(avg(b.weight_kg) over w7, 2) as schnitt_7,
  count(*) over w7 as werte_7,
  round(avg(b.weight_kg) over wv, 2) as schnitt_vorwoche,
  count(*) over wv as werte_vorwoche,
  round(avg(b.weight_kg) over w7 - avg(b.weight_kg) over wv, 2) as differenz,
  b.note as notiz,
  b.source as quelle,
  b.user_id
from public.body_weights b
where b.deleted_at is null
window
  w7 as (partition by b.user_id order by b.day range between interval '6 days' preceding and current row),
  wv as (partition by b.user_id order by b.day range between interval '13 days' preceding and interval '7 days' preceding);
comment on view public.v_gewicht is 'Körpergewicht je Tag mit 7-Tage-Schnitt und Schnitt der Vorwoche (7 Tage davor). Für Auswertungen.';
revoke all on public.v_gewicht from anon, authenticated;
grant select on public.v_gewicht to authenticated;
