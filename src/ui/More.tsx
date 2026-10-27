import { useState } from 'react';
import { APP_VERSION } from '../config';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, heldRows, retryHeld } from '../db/local';
import { TABLES } from '../db/types';
import { runSync, supabase, useSync } from '../sync/manager';
import { fmtDate, fmtTime, NumInput, settings } from './util';

export function More() {
  const sync = useSync();
  const [rest, setRest] = useState(settings.restSeconds);
  const held = useLiveQuery(() => heldRows(), [sync.held]);

  const exportJson = async () => {
    const data: Record<string, unknown[]> = {};
    for (const t of TABLES) data[t] = await db.tbl(t).toArray();
    const blob = new Blob([JSON.stringify({ exportiert: new Date().toISOString(), version: APP_VERSION, data }, null, 1)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trainings-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  return (
    <>
      <div className="topbar">
        <h1>Mehr</h1>
      </div>

      <div className="card">
        <h2>Abgleich mit der Datenbank</h2>
        <p className="small" style={{ margin: '4px 0' }}>
          {sync.pending === 0 ? 'Alles gespeichert.' : `${sync.pending} Änderungen warten aufs Senden.`}
          <br />
          <span className="muted">
            {sync.lastSync ? `Zuletzt abgeglichen ${fmtDate(sync.lastSync)}, ${fmtTime(sync.lastSync)}.` : 'Noch nie abgeglichen.'}{' '}
            {sync.online ? '' : 'Gerade kein Netz.'}
          </span>
          {sync.error && (
            <>
              <br />
              <span style={{ color: 'var(--danger)' }}>Fehler: {sync.error}</span>
            </>
          )}
        </p>
        <button className="btn small" disabled={sync.running} onClick={() => runSync()}>
          {sync.running ? 'Gleicht ab …' : 'Jetzt abgleichen'}
        </button>
        {held && held.length > 0 && (
          <div className="banner" role="alert">
            <strong>{held.length} Einträge hat die Datenbank abgelehnt.</strong> Sie liegen sicher auf diesem Gerät, halten
            aber den Rest nicht auf. Grund des ersten: {held[0].error ?? 'unbekannt'}
            <br />
            <button className="btn small" style={{ marginTop: 6 }} onClick={() => retryHeld()}>
              Erneut senden
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Pausentimer</h2>
        <label className="field">
          <span>Standard-Pause in Sekunden (je Übung änderbar)</span>
          <NumInput
            label="Standard-Pause in Sekunden"
            value={rest}
            onCommit={(n) => {
              if (n != null && n > 0) {
                settings.restSeconds = n;
                setRest(n);
              }
            }}
          />
        </label>
      </div>

      <a className="list-item" href="#/import">
        <span className="grow">Strong-Daten importieren</span>
        <span aria-hidden>›</span>
      </a>
      <button className="list-item" onClick={exportJson}>
        <span className="grow">Sicherung herunterladen (JSON)</span>
      </button>

      <div className="card small">
        <div>Angemeldet als {sync.session?.user.email ?? '—'}</div>
        <div className="muted">Version {APP_VERSION}</div>
        <button
          className="btn small danger"
          style={{ marginTop: 8 }}
          onClick={async () => {
            if (sync.pending > 0 && !confirm(`${sync.pending} Änderungen sind noch nicht gesendet. Sie bleiben auf dem Gerät. Trotzdem abmelden?`)) {
              return;
            }
            await supabase.auth.signOut({ scope: 'local' });
          }}
        >
          Abmelden
        </button>
      </div>
    </>
  );
}
