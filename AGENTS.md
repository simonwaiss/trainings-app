# Trainings-App (Simon privat)

Simons eigene Trainings-App, ersetzt Strong. Web-App für den Home-Bildschirm des iPhones, läuft auch am Mac im Browser.
Adresse: https://simonwaiss.github.io/trainings-app/. Anforderungen und Stand des Vorhabens: Vault
`~/AI-OS/02 Projekte/Trainings-App.md`. Das Repo ist öffentlich; die Daten liegen nur in Supabase.

## Aufbau

- `src/db/local.ts`: lokale Kopie im Browser (IndexedDB über Dexie). Jede Änderung geht über `save`/`patch`, markiert die
  Zeile mit `_dirty = 1` und stößt den Abgleich an.
- `src/sync/`: Abgleich mit Supabase. Senden per upsert über die id (keine Doppelten), Holen über `updated_at`, das der
  Server setzt. Ungesendete lokale Änderungen gewinnen.
- `src/data/ops.ts`: Training starten/beenden, Vorwerte, Kraftverlauf, Vorbelegung aus `src/data/plan.ts`. Beim
  Beenden vergleicht `templateChanges` das Training mit seinem Trainingstag (Übungen, Reihenfolge, Zahl der
  Arbeitssätze; Aufwärmsätze gehören nur zum Training) und fragt, ob die Änderung nur heute gilt; Gewichte merkt
  sich ein Trainingstag nie, Vorwerte kommen immer aus dem letzten Training. Rekorde: `recordSetIds`.
- `src/import/strong.ts`: Strong-CSV lesen und in Zeilen mit festen ids umwandeln.
- `src/data/weight.ts`: Körpergewicht, ein Wert je Tag; die id kommt fest aus dem Tag (`stableId('gewicht', tag)`),
  darum schreiben zwei Geräte und ein Import per SQL in dieselbe Zeile. 7-Tage-Schnitt wie die Ansicht `v_gewicht`.
- `supabase/migrations/`: Datenbank-Schema samt Zeilenrechten (RLS). `supabase/functions/konto-einrichten`: legt einmalig
  Simons Konto an.

## Harte Regeln

- **Kein Datenverlust.** Nie wirklich löschen, nur `deleted_at` setzen (die App hat kein DELETE-Recht). Schema-Änderungen
  nur als neue Migrationsdatei, die bestehende Daten übernimmt; vor jeder Migration eine Sicherung als Datei nach
  `~/Backups/trainings-app/` (außerhalb jedes Repos). Ohne Datenbank-Passwort geht das so: im Supabase-Dashboard
  (Simons Chrome) im SQL-Editor je Tabelle `count(*)` und `json_agg(t)::text` abfragen, „Export → Download CSV“, die CSV
  in eine JSON-Datei umwandeln und die Zeilenzahlen gegen `count(*)` prüfen. Die lokale Datenbank (Dexie) nur mit neuer `version()` ändern,
  nie eine bestehende Version umschreiben.
- **Nichts Geheimes ins Repo:** nur Projekt-Adresse und öffentlicher Schlüssel (`src/config.ts`). Keine Mail-Adressen,
  keine Strong-Exporte (`*.csv` ist ausgeschlossen), keine Sicherungen.
- **Erst grüne Tests, dann ausrollen.** `npm run pruefen` (Bauen, Vitest inkl. Zeilenrechte-Test, Playwright). Der
  GitHub-Lauf rollt nur nach grünen Tests auf GitHub Pages aus. Bei Änderungen am Abgleich oder an der Oberfläche
  zusätzlich: `PW_BROWSER=webkit npx playwright test` (Safari-Engine wie auf dem iPhone),
  `FUZZ_RUNS=200 npx vitest run tests/unit/sync-fuzz.test.ts` (zwei Geräte, schlechtes Netz, einige Minuten) und mit
  einem echten Strong-Export `STRONG_CSV=<pfad> npx playwright test stress` (Datei nie ins Repo).
- **Supabase:** Projekt `trainings-app` in Simons privater Organisation, Zugang über die Anbindung `supabase-privat`.
  Die Organisation `raban` und das Projekt `raban-frankfurt` nie anfassen; Johannes hat dort Zugriff.
- Neue Tabellen bekommen dieselben Zeilenrechte wie die bestehenden (siehe Migration); der Test in `tests/db/` prüft
  jede Tabelle in `public` automatisch.
- **Jede Grenze der Datenbank** (Check, Zahlentyp, Länge) steht auch in `src/db/limits.ts`; dort werden alle
  Änderungen vor dem Speichern eingepasst. Lehnt der Server trotzdem eine Zeile ab, wird sie nach 3 Versuchen
  zurückgehalten (`_dirty = 2`, sichtbar unter „Mehr“) und hält den Rest nicht auf.

## Git

Direkt auf `main`, deutsch committen, nur eigene Pfade stagen. Vor dem Push `npm run pruefen`.

## Daten auswerten (Claude per SQL)

Ansicht `public.v_saetze`: ein gültiger Satz je Zeile mit `datum`, `training`, `uebung`, `satz`, `seite`, `kg`, `wdh`,
`e1rm` (geschätztes Maximum nach Epley), `quelle` (app/strong). Gelöschte und leere Sätze sind schon herausgefiltert.

Ansicht `public.v_gewicht`: ein Tag mit Gewicht je Zeile mit `datum`, `kg`, `schnitt_7` (Schnitt der 7 Tage bis
einschließlich dieses Tags), `werte_7`, `schnitt_vorwoche` (die 7 Tage davor), `werte_vorwoche`, `differenz`, `notiz`,
`quelle` (app/vault). Sonntags ist das Montag bis Sonntag gegen die Woche davor. Gewicht nachtragen per SQL nur mit der
id aus `stableId('gewicht', tag)` (sonst lehnt `unique (user_id, day)` die App-Zeile desselben Tags ab).
