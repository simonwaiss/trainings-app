import { useLiveQuery } from 'dexie-react-hooks';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { activeWorkout } from '../data/ops';
import { db } from '../db/local';
import { useSync } from '../sync/manager';
import { Exercises, ExerciseDetail } from './Exercises';
import { History } from './History';
import { Home } from './Home';
import { Import } from './Import';
import { Login } from './Login';
import { More } from './More';
import { RestTimer } from './RestTimer';
import { TemplateEdit } from './TemplateEdit';
import { useRoute } from './util';
import { WorkoutView } from './WorkoutView';

function Page({ route }: { route: string }) {
  const [, section, id] = route.split('/');
  switch (section) {
    case 'training':
      return <WorkoutView id={id} />;
    case 'tag':
      return <TemplateEdit id={id} />;
    case 'verlauf':
      return <History />;
    case 'uebungen':
      return <Exercises />;
    case 'uebung':
      return <ExerciseDetail id={id} />;
    case 'import':
      return <Import />;
    case 'mehr':
      return <More />;
    default:
      return <Home />;
  }
}

function SyncBadge() {
  return (
    <span aria-live="polite">
      <SyncText />
    </span>
  );
}

function SyncText() {
  const s = useSync();
  if (s.held > 0) return <a className="status error" href="#/mehr">⚠︎ {s.held} zurückgehalten</a>;
  // Netz- und Serverfehler gehen vorbei; die App versucht es von selbst wieder. Darum hier kein Rot.
  if (s.pending > 0) return <span className="status pending">{!s.online ? 'offline ·' : s.error ? '⏸' : '↻'} {s.pending} offen</span>;
  if (!s.online) return <span className="status">offline · alles gespeichert</span>;
  if (s.error) return <span className="status">alles gespeichert · Server gerade nicht erreichbar</span>;
  return <span className="status">✓ gespeichert</span>;
}

export function App() {
  const route = useRoute();
  const sync = useSync();
  const owner = useLiveQuery(async () => (await db.meta.get('owner'))?.value ?? null, []);
  const active = useLiveQuery(() => activeWorkout(), []);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (owner === undefined) return null;
  // Erstes Mal auf diesem Gerät: ohne Anmeldung gibt es nichts zu zeigen.
  // Gibt es schon Daten auf dem Gerät, erscheint die App sofort, auch wenn die Anmeldung noch erneuert wird.
  if (!owner && !sync.authReady) return null;
  if (!sync.session && !owner) {
    return (
      <div className="app">
        <Login />
      </div>
    );
  }

  const section = route.split('/')[1] ?? '';
  const tab = (path: string, label: string, ico: string, match: string[]) => (
    <a href={`#${path}`} className={match.includes(section) ? 'active' : ''}>
      <span className="ico" aria-hidden>
        {ico}
      </span>
      {label}
    </a>
  );

  return (
    <div className="app">
      <div className="row" style={{ justifyContent: 'flex-end', minHeight: 20 }}>
        <SyncBadge />
      </div>
      {!sync.session && (sync.signedOut || (sync.authReady && sync.online)) && (
        <div className="banner">
          Abgemeldet. Alles bleibt auf dem Gerät gespeichert; zum Senden bitte anmelden.
          <Login />
        </div>
      )}
      {needRefresh && (
        <div className="banner row">
          <span className="grow">Neue Version da.</span>
          <button className="btn small primary" onClick={() => updateServiceWorker(true)}>
            Aktualisieren
          </button>
        </div>
      )}
      <Page route={route} />
      <RestTimer />
      <nav className="tabbar" aria-label="Hauptmenü">
        {tab(active ? `/training/${active.id}` : '/', active ? 'Läuft' : 'Training', '🏋️', ['', 'training', 'tag'])}
        {tab('/verlauf', 'Verlauf', '🗓️', ['verlauf'])}
        {tab('/uebungen', 'Übungen', '📈', ['uebungen', 'uebung'])}
        {tab('/mehr', 'Mehr', '⋯', ['mehr', 'import'])}
      </nav>
    </div>
  );
}
