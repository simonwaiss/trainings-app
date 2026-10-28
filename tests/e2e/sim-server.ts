import { join } from 'node:path';
import { MockSupabase, serveHttp } from './mock-supabase.ts';
import { StaticServer } from './server.ts';

// Für Proben von Hand im iPhone-Simulator (echtes Safari): App und Supabase-Nachbau als echte Server auf dem Mac.
//   npx vite build --outDir dist-sim (mit VITE_SUPABASE_URL=http://127.0.0.1:5301)
//   node tests/e2e/sim-server.ts   →  App: http://127.0.0.1:5300/trainings-app/
// Funkloch schalten: curl 127.0.0.1:5301/__netz?modus=weg|haengt|da
const mock = new MockSupabase();
let modus: 'da' | 'weg' | 'haengt' = 'da';

serveHttp(5301, () => mock, (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:5301');
  if (url.pathname === '/__netz') {
    modus = (url.searchParams.get('modus') as typeof modus) ?? 'da';
    const counts = Object.fromEntries([...mock.tables].map(([t, m]) => [t, m.size]));
    res.end(JSON.stringify({ modus, counts }) + '\n');
    return true;
  }
  if (modus === 'weg') return (res.destroy(), true);
  if (modus === 'haengt') return (setTimeout(() => res.destroy(), 120_000), true);
  return false;
});

const app = new StaticServer(join(import.meta.dirname, '../../dist-sim'));
(app as unknown as { server: { listen(p: number, h: string, cb: () => void): void } }).server.listen(5300, '127.0.0.1', () =>
  console.log('App: http://127.0.0.1:5300/trainings-app/  ·  Nachbau: http://127.0.0.1:5301'),
);
