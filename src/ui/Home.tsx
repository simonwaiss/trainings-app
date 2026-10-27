import { useLiveQuery } from 'dexie-react-hooks';
import { createTemplate, startWorkout } from '../data/ops';
import { db } from '../db/local';
import { fmtDate, go } from './util';

const alive = <T extends { deleted_at: string | null }>(r: T) => !r.deleted_at;

export function Home() {
  const data = useLiveQuery(async () => {
    const templates = (await db.templates.toArray()).filter(alive).sort((a, b) => a.position - b.position);
    const workouts = (await db.workouts.toArray()).filter(alive);
    const active = workouts.filter((w) => !w.finished_at).sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    const lastByTemplate = new Map<string, string>();
    for (const w of workouts) {
      if (!w.finished_at) continue;
      const key = w.template_id ?? w.name;
      if ((lastByTemplate.get(key) ?? '') < w.started_at) lastByTemplate.set(key, w.started_at);
    }
    const counts = new Map<string, number>();
    for (const l of (await db.template_exercises.toArray()).filter(alive)) {
      counts.set(l.template_id, (counts.get(l.template_id) ?? 0) + 1);
    }
    return { templates, active, lastByTemplate, counts };
  }, []);

  if (!data) return <p className="muted">Lädt …</p>;
  const { templates, active, lastByTemplate, counts } = data;

  const start = async (templateId: string | null) => {
    if (active && !confirm(`Es läuft noch „${active.name}“. Trotzdem ein neues Training starten?`)) return;
    go(`/training/${await startWorkout(templateId)}`);
  };

  return (
    <>
      <div className="topbar">
        <h1>Training</h1>
      </div>

      {active && (
        <button className="list-item" style={{ borderColor: 'var(--accent)' }} onClick={() => go(`/training/${active.id}`)}>
          <span className="grow">
            <strong>Läuft: {active.name}</strong>
            <br />
            <span className="muted small">seit {fmtDate(active.started_at)} – weiter loggen</span>
          </span>
          <span aria-hidden>›</span>
        </button>
      )}

      {templates.map((t) => {
        const last = lastByTemplate.get(t.id) ?? lastByTemplate.get(t.name);
        return (
          <div key={t.id} className="card">
            <div className="row">
              <div className="grow">
                <h2>{t.name}</h2>
                <div className="muted small">
                  {counts.get(t.id) ?? 0} Übungen{last ? ` · zuletzt ${fmtDate(last)}` : ''}
                </div>
              </div>
              <button className="btn small" onClick={() => go(`/tag/${t.id}`)} aria-label={`${t.name} bearbeiten`}>
                Bearbeiten
              </button>
            </div>
            <button className="btn primary block" style={{ marginTop: 10 }} onClick={() => start(t.id)}>
              {t.name} starten
            </button>
          </div>
        );
      })}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn grow" onClick={() => start(null)}>
          Freies Training
        </button>
        <button
          className="btn grow"
          onClick={async () => {
            const name = prompt('Name des neuen Trainingstags');
            if (name?.trim()) go(`/tag/${await createTemplate(name)}`);
          }}
        >
          + Trainingstag
        </button>
      </div>
    </>
  );
}
