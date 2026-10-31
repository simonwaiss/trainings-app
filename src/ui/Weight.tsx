import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState, type FormEvent } from 'react';
import { addDays, isDay, localDay, removeWeight, saveWeight, weekStats, weightOk, weightSeries } from '../data/weight';
import { LIMITS } from '../db/limits';
import { db } from '../db/local';
import { LineChart } from './Chart';
import { fmtDate, fmtShort, parseNum } from './util';

// Mittag statt Mitternacht: So landet der Tag in jeder Zeitzone auf dem richtigen Datum.
const noon = (day: string) => `${day}T12:00:00`;
const dayLabel = (day: string) => fmtDate(noon(day));
const kg1 = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
// Tageswerte immer mit Komma, damit 79,0 neben 78,6 nicht wie ein anderer Wert aussieht.
const fmtWeight = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const round1 = (n: number) => Math.round(n * 10) / 10;

function signed(n: number) {
  if (n === 0) return '±0,0';
  return `${n > 0 ? '+' : '−'}${kg1(Math.abs(n))}`;
}

export function Weight() {
  // Kommt die App aus dem Hintergrund (etwa am nächsten Morgen), gilt wieder heute.
  const [, setTick] = useState(0);
  const [picked, setPicked] = useState<string | null>(null); // null = heute
  const [text, setText] = useState<string | null>(null); // null = gespeicherter Wert des Tags
  const [msg, setMsg] = useState('');
  const [showAll, setShowAll] = useState(false);
  const rows = useLiveQuery(() => db.body_weights.toArray(), []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setPicked(null);
      setText(null);
      setMsg('');
      setTick((t) => t + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (!rows) return <p className="muted">Lädt …</p>;
  const today = localDay();
  const day = picked ?? today;
  const alive = rows.filter((r) => !r.deleted_at);
  const existing = alive.find((r) => r.day === day);
  const value = text ?? (existing ? fmtWeight(existing.weight_kg) : '');

  const pickDay = (d: string) => {
    setPicked(d === today ? null : d);
    setText(null);
    setMsg('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const kg = parseNum(value);
    if (!weightOk(kg)) {
      setMsg(`Bitte ein Gewicht zwischen ${LIMITS.bodyWeightKg.min} und ${LIMITS.bodyWeightKg.max} kg eintragen, etwa 78,6.`);
      return;
    }
    if (!isDay(day) || day > today) {
      setMsg('Bitte einen Tag bis heute wählen.');
      return;
    }
    await saveWeight(day, kg);
    setPicked(null);
    setText(null);
    setMsg(`Gespeichert: ${fmtWeight(kg)} kg am ${dayLabel(day)}.`);
    (document.activeElement as HTMLElement | null)?.blur(); // Tastatur schließen
  };

  const remove = async () => {
    if (!existing || !confirm(`Wert vom ${dayLabel(day)} (${fmtWeight(existing.weight_kg)} kg) entfernen?`)) return;
    await removeWeight(day);
    setPicked(null);
    setText(null);
    setMsg(`Entfernt: ${dayLabel(day)}.`);
  };

  const s = weekStats(alive, today);
  const diff = s.avg != null && s.prevAvg != null ? round1(round1(s.avg) - round1(s.prevAvg)) : null;
  const series = weightSeries(alive);
  const list = [...alive].sort((a, b) => b.day.localeCompare(a.day));
  const shown = showAll ? list : list.slice(0, 14);

  return (
    <>
      <div className="topbar">
        <h1>Gewicht</h1>
      </div>

      <form className="card" onSubmit={submit} aria-label="Gewicht eintragen">
        <div className="row">
          <label className="field grow">
            <span>Tag</span>
            <input className="text" type="date" value={day} max={today} onChange={(e) => pickDay(e.target.value)} />
          </label>
          <label className="field grow">
            <span>Gewicht in kg</span>
            <input
              className="text"
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              placeholder="78,6"
              value={value}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        </div>
        {existing && text == null && !msg && (
          <p className="muted small" style={{ margin: '0 0 8px' }}>
            Eingetragen. Ein neuer Wert ersetzt ihn.
          </p>
        )}
        <div className="row">
          <button className="btn primary grow" type="submit">
            Speichern
          </button>
          {existing && (
            <button className="btn danger" type="button" onClick={remove}>
              Entfernen
            </button>
          )}
        </div>
        <p className="small" role="status" style={{ margin: msg ? '8px 0 0' : 0 }}>
          {msg}
        </p>
      </form>

      <section className="card" aria-label="7-Tage-Schnitt">
        <div className="muted small">
          7-Tage-Schnitt, {fmtShort(noon(addDays(today, -6)))} bis {fmtShort(noon(today))}
        </div>
        {s.avg == null ? (
          <p style={{ margin: '4px 0' }}>Noch keine Werte in den letzten 7 Tagen.</p>
        ) : (
          <div className="row" style={{ alignItems: 'baseline' }}>
            <span className="big-number">{kg1(s.avg)} kg</span>
            <span className="muted small">
              aus {s.count} {s.count === 1 ? 'Wert' : 'Werten'}
            </span>
          </div>
        )}
        <div style={{ marginTop: 4 }}>
          {s.prevAvg == null ? (
            <span className="muted">Vorwoche: noch keine Werte</span>
          ) : (
            <>
              Vorwoche {kg1(s.prevAvg)} kg
              {diff != null && <strong> · {signed(diff)} kg</strong>}
              <span className="muted small">
                {' '}
                (aus {s.prevCount} {s.prevCount === 1 ? 'Wert' : 'Werten'})
              </span>
            </>
          )}
        </div>
      </section>

      {series.length >= 2 && (
        <div className="card">
          <h2>Verlauf</h2>
          <LineChart
            points={series.map((p) => ({ date: noon(p.day), value: p.kg }))}
            avg={series.map((p) => p.avg)}
            unit="kg"
            label="Körpergewicht"
            noun="Tage"
          />
        </div>
      )}

      {list.length === 0 && <p className="muted">Noch kein Gewicht eingetragen.</p>}
      {shown.map((r) => (
        <button
          key={r.id}
          className="list-item"
          aria-label={`${dayLabel(r.day)}: ${fmtWeight(r.weight_kg)} kg, ändern`}
          onClick={() => {
            pickDay(r.day);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          <span className="grow">
            {dayLabel(r.day)}
            {r.source === 'vault' && <span className="muted small"> · aus dem Vault</span>}
          </span>
          <strong>{fmtWeight(r.weight_kg)} kg</strong>
        </button>
      ))}
      {list.length > shown.length && (
        <button className="btn block" onClick={() => setShowAll(true)}>
          Alle {list.length} Tage zeigen
        </button>
      )}
    </>
  );
}
