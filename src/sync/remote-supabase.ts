import type { SupabaseClient } from '@supabase/supabase-js';
import type { Base, TableName } from '../db/types';
import type { Remote } from './sync';

const PAGE = 1000;

export function supabaseRemote(client: SupabaseClient): Remote {
  return {
    async upsert(table, rows) {
      const { error } = await client.from(table).upsert(rows, { onConflict: 'id' });
      if (error) throw new Error(`${table}: ${error.message}`);
    },
    async pullSince(table: TableName, since) {
      const out: Base[] = [];
      for (let from = 0; ; from += PAGE) {
        let q = client.from(table).select('*');
        if (since) q = q.gte('updated_at', since);
        const { data, error } = await q
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`${table}: ${error.message}`);
        out.push(...((data ?? []) as Base[]));
        if (!data || data.length < PAGE) break;
      }
      return out.map(normalize);
    },
  };
}

// numeric kommt aus Postgres teils als Text; lokal rechnen wir mit Zahlen.
function normalize(row: Base): Base {
  const r = row as unknown as Record<string, unknown>;
  for (const k of ['weight_kg', 'rpe']) {
    if (typeof r[k] === 'string') r[k] = Number(r[k]);
  }
  return row;
}
