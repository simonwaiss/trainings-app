import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseRemote } from '../../src/sync/remote-supabase';
import { RejectedError } from '../../src/sync/sync';

type Row = { id: string; updated_at: string; weight_kg?: number | string };

// Nachbau des Abfrage-Bausteins von supabase-js, nur so weit, wie remote-supabase ihn nutzt.
function fakeClient(rows: Row[], onPage?: (page: number) => void, upsertError?: { code?: string; message: string; status: number }) {
  let page = 0;
  return {
    from: () => {
      let list = [...rows];
      let limit = Infinity;
      const q = {
        select: () => q,
        gte: (_c: string, v: string) => ((list = list.filter((r) => r.updated_at >= v)), q),
        or: (expr: string) => {
          const m = expr.match(/updated_at\.gt\."(.+?)",and\(updated_at\.eq\."(.+?)",id\.gt\.(.+)\)$/)!;
          list = list.filter((r) => r.updated_at > m[1] || (r.updated_at === m[2] && r.id > m[3]));
          return q;
        },
        order: () => q,
        limit: (n: number) => {
          limit = n;
          return q;
        },
        then: (resolve: (v: unknown) => void) => {
          onPage?.(page++);
          const sorted = list.sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
          resolve({ data: sorted.slice(0, limit), error: null });
        },
        upsert: async () => ({ error: upsertError ?? null, status: upsertError?.status ?? 201 }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const ts = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString();

describe('Holen vom Server', () => {
  it('lässt keine Zeile aus, wenn sich während des Holens eine ältere Zeile ändert', async () => {
    const rows: Row[] = Array.from({ length: 25 }, (_, i) => ({ id: `id-${String(i).padStart(3, '0')}`, updated_at: ts(i) }));
    // Nach der ersten Seite ändert jemand (z. B. das iPhone) die älteste Zeile.
    const client = fakeClient(rows, (page) => {
      if (page === 1) rows[0].updated_at = ts(1000);
    });
    const got = await supabaseRemote(client, 10).pullSince('sets', null);
    const ids = new Set(got.map((r) => r.id));
    for (const r of rows) expect(ids.has(r.id), r.id).toBe(true);
  });

  it('holt auch Zeilen mit gleichem Zeitstempel über die Seitengrenze hinweg', async () => {
    const rows: Row[] = Array.from({ length: 15 }, (_, i) => ({ id: `id-${String(i).padStart(3, '0')}`, updated_at: ts(i < 12 ? 0 : i) }));
    const got = await supabaseRemote(fakeClient(rows), 10).pullSince('sets', null);
    expect(got).toHaveLength(15);
  });

  it('wandelt Zahlen aus Text um', async () => {
    const got = await supabaseRemote(fakeClient([{ id: 'a', updated_at: ts(0), weight_kg: '52.50' }])).pullSince('sets', null);
    expect((got[0] as unknown as Row).weight_kg).toBe(52.5);
  });
});

describe('Senden an den Server', () => {
  it('unterscheidet Ablehnung durch die Datenbank von Netz-, Anmelde- und Serverfehlern', async () => {
    const upsert = (e: { code?: string; message: string; status: number }) =>
      supabaseRemote(fakeClient([], undefined, e)).upsert('sets', [{}]).catch((err) => err);
    // Echte Ablehnungen: Die Zeile wird nach mehreren Versuchen zurückgehalten.
    expect(await upsert({ code: '23514', message: 'violates check constraint', status: 400 })).toBeInstanceOf(RejectedError);
    expect(await upsert({ code: '23505', message: 'duplicate key', status: 409 })).toBeInstanceOf(RejectedError);
    expect(await upsert({ code: 'PGRST204', message: 'column not found', status: 400 })).toBeInstanceOf(RejectedError);
    // Nur vorübergehend: wird später wiederholt, nie zurückgehalten.
    for (const e of [
      { message: 'TypeError: Failed to fetch', status: 0 },
      { code: '20', message: 'AbortError', status: 0 },
      { code: 'PGRST301', message: 'JWT expired', status: 401 },
      { code: '42501', message: 'permission denied for table sets', status: 401 },
      { code: '42501', message: 'permission denied', status: 403 },
      { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.', status: 503 },
      { message: 'Bad gateway', status: 502 },
      { message: 'Too many requests', status: 429 },
    ]) {
      const err = await upsert(e);
      expect(err, e.message).toBeInstanceOf(Error);
      expect(err, e.message).not.toBeInstanceOf(RejectedError);
    }
  });
});
