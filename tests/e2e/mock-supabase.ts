import type { BrowserContext, Route } from '@playwright/test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// Nachbau der Supabase-Schnittstellen (Login, Datenbank, Funktion), den die echte App im Browser anspricht.
// Er verhält sich wie der Server: upsert über id, updated_at setzt der Server.
// In WebKit läuft der Nachbau als echter Server: Dort umgehen Anfragen einer Seite unter dem Service Worker
// das Abfangen durch Playwright, und die App bekäme nie Antwort.
export const MOCK_PORT = 5302;
export const MOCK_URL = process.env.MOCK_HTTP ? `http://127.0.0.1:${MOCK_PORT}` : 'https://mock.supabase.test';
export const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'simon@example.org' };

function b64url(obj: unknown) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function session() {
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: USER.id, email: USER.email, role: 'authenticated', aud: 'authenticated', exp })}.sig`;
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 24 * 3600,
    expires_at: exp,
    refresh_token: 'refresh-token',
    user: { id: USER.id, email: USER.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-27T00:00:00Z' },
  };
}

export class MockSupabase {
  tables = new Map<string, Map<string, Record<string, unknown>>>();
  upserts = 0;
  // Kein Netz: Jede Anfrage scheitert wie bei einem echten Funkloch.
  offline = false;
  private clock = Date.now();

  rows(table: string) {
    return [...(this.tables.get(table)?.values() ?? [])];
  }

  async install(context: BrowserContext) {
    if (process.env.MOCK_HTTP) {
      current = this;
      if (!httpStarted) {
        httpStarted = true;
        serveHttp(MOCK_PORT, () => current!).unref();
      }
      return;
    }
    await context.route(`${MOCK_URL}/**`, (route) => this.handle(route));
  }

  private json(route: Route, status: number, body: unknown) {
    return route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' },
      body: body === undefined ? '' : JSON.stringify(body),
    });
  }

  async handle(route: Route) {
    if (this.offline) return route.abort('internetdisconnected');
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') return this.json(route, 200, undefined);

    if (url.pathname === '/auth/v1/token') return this.json(route, 200, session());
    if (url.pathname === '/auth/v1/user') return this.json(route, 200, session().user);
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    if (url.pathname === '/functions/v1/konto-einrichten') return this.json(route, 200, { ok: true });

    const m = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
    if (!m) return this.json(route, 404, { message: 'unbekannt' });
    const table = m[1];
    const t = this.tables.get(table) ?? new Map();
    this.tables.set(table, t);

    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>[];
      this.upserts++;
      for (const r of Array.isArray(body) ? body : [body]) {
        this.clock += 1;
        t.set(r.id as string, { ...t.get(r.id as string), ...r, updated_at: new Date(this.clock).toISOString() });
      }
      return this.json(route, 201, undefined);
    }

    // GET mit updated_at=gte.<zeit>, Seiten nach Schlüssel (or=…), limit
    let rows = [...t.values()];
    const gte = url.searchParams.get('updated_at');
    if (gte?.startsWith('gte.')) rows = rows.filter((r) => (r.updated_at as string) >= gte.slice(4));
    const or = url.searchParams.get('or')?.match(/updated_at\.gt\."(.+?)",and\(updated_at\.eq\."(.+?)",id\.gt\.(.+)\)\)$/);
    if (or) {
      rows = rows.filter(
        (r) => (r.updated_at as string) > or[1] || ((r.updated_at as string) === or[2] && (r.id as string) > or[3]),
      );
    }
    rows.sort((a, b) => (a.updated_at as string).localeCompare(b.updated_at as string) || (a.id as string).localeCompare(b.id as string));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 1000);
    return this.json(route, 200, rows.slice(offset, offset + limit));
  }
}

let current: MockSupabase | null = null;
let httpStarted = false;

// Der Nachbau als echter HTTP-Server (für WebKit und für Proben von Hand im iPhone-Simulator).
// gate() kann eine Anfrage vorher abfangen, etwa um ein Funkloch nachzustellen; dann true zurückgeben.
export function serveHttp(port: number, mock: () => MockSupabase, gate?: (req: IncomingMessage, res: ServerResponse) => boolean) {
  const server = createServer((req, res) => {
    if (gate?.(req, res)) return;
    if (mock().offline) return void res.destroy();
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
        'access-control-max-age': '600',
      });
      return void res.end();
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = `http://127.0.0.1:${port}${req.url ?? '/'}`;
      const route = {
        request: () => ({ url: () => url, method: () => req.method ?? 'GET', postDataJSON: () => JSON.parse(body) }),
        fulfill: async (o: { status?: number; headers?: Record<string, string>; contentType?: string; body?: string | Buffer }) => {
          res.writeHead(o.status ?? 200, { ...o.headers, 'access-control-allow-origin': '*', ...(o.contentType ? { 'content-type': o.contentType } : {}) });
          res.end(o.body ?? '');
        },
        abort: async () => void res.destroy(),
      };
      void mock().handle(route as unknown as Route);
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}
