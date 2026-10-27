import type { BrowserContext, Route } from '@playwright/test';

// Nachbau der Supabase-Schnittstellen (Login, Datenbank, Funktion), den die echte App im Browser anspricht.
// Er verhält sich wie der Server: upsert über id, updated_at setzt der Server.
export const MOCK_URL = 'https://mock.supabase.test';
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
  private clock = Date.now();

  rows(table: string) {
    return [...(this.tables.get(table)?.values() ?? [])];
  }

  async install(context: BrowserContext) {
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

  private async handle(route: Route) {
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

    // GET mit updated_at=gte.<zeit>, offset, limit
    let rows = [...t.values()];
    const gte = url.searchParams.get('updated_at');
    if (gte?.startsWith('gte.')) rows = rows.filter((r) => (r.updated_at as string) >= gte.slice(4));
    rows.sort((a, b) => (a.updated_at as string).localeCompare(b.updated_at as string) || (a.id as string).localeCompare(b.id as string));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 1000);
    return this.json(route, 200, rows.slice(offset, offset + limit));
  }
}
