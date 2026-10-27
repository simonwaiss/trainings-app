import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../db/local';
import { applyImport } from '../import/apply';
import { buildImport, parseStrongCsv, suggestMapping, type ParseResult } from '../import/strong';
import { fmtDate, go } from './util';

export function Import() {
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const exercises = useLiveQuery(
    async () => (await db.exercises.toArray()).filter((e) => !e.deleted_at).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [],
  );

  const onFile = async (file: File) => {
    setError(null);
    setResult(null);
    try {
      const p = parseStrongCsv(await file.text());
      setParsed(p);
      setMapping(suggestMapping(p.exerciseNames.map((e) => e.name), exercises ?? []));
    } catch (e) {
      setParsed(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="topbar">
        <button className="link" onClick={() => go('/mehr')}>
          ‹ Mehr
        </button>
      </div>
      <h1 style={{ fontSize: 22 }}>Strong-Daten importieren</h1>
      <p className="muted small">
        In Strong: Einstellungen → Daten exportieren. Die CSV-Datei hier auswählen. Ein zweiter Import derselben Datei legt nichts doppelt an.
      </p>
      <input
        type="file"
        accept=".csv,text/csv,text/plain"
        aria-label="CSV-Datei aus Strong"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      {error && <div className="banner">{error}</div>}

      {parsed && (
        <>
          <div className="card">
            <strong>{parsed.workouts.length} Trainings</strong>
            {parsed.workouts.length > 0 && (
              <span className="muted small">
                {' '}
                von {fmtDate(parsed.workouts[0].date.toISOString())} bis {fmtDate(parsed.workouts[parsed.workouts.length - 1].date.toISOString())}
              </span>
            )}
            <div className="muted small">
              {parsed.exerciseNames.reduce((n, e) => n + e.sets, 0)} Sätze, {parsed.exerciseNames.length} Übungen
              {parsed.skippedRows ? `, ${parsed.skippedRows} Zeilen ohne Satz übersprungen (z. B. Pausentimer)` : ''}
            </div>
          </div>
          <h2 style={{ fontSize: 17 }}>Übungen zuordnen</h2>
          <p className="muted small">Gleiche Übung unter anderem Namen? Hier zuordnen, dann erscheinen die alten Werte als Vorwerte.</p>
          {parsed.exerciseNames.map(({ name, sets }) => (
            <label key={name} className="field">
              <span>
                {name} ({sets} Sätze)
              </span>
              <select
                className="text"
                value={mapping[name] ?? ''}
                onChange={(e) => setMapping({ ...mapping, [name]: e.target.value || undefined })}
              >
                <option value="">als neue Übung „{name}“ anlegen</option>
                {(exercises ?? []).map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    → {ex.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button
            className="btn primary block"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await applyImport(await buildImport(parsed, mapping));
                setResult(`Importiert: ${r.workouts} Trainings, ${r.sets} Sätze, ${r.exercises} neue Übungen.`);
                setParsed(null);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Importiere …' : 'Importieren'}
          </button>
        </>
      )}
      {result && <div className="card">{result} Der Abgleich mit der Datenbank läuft im Hintergrund.</div>}
    </>
  );
}
