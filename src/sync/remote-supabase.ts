import type { SupabaseClient } from '@supabase/supabase-js';
import type { Base, TableName } from '../db/types';
import { RejectedError, type Remote } from './sync';

// Fehler mit Postgres- oder PostgREST-Code heißen: Der Server hat geantwortet und abgelehnt.
// Ohne Code war es das Netz (oder eine Zeitüberschreitung) und wird später wiederholt.
function isRejection(error: { code?: string; message?: string }) {
  return !!error.code && /^(2\d|42|PGRST)/.test(error.code);
}

// Holt Seite für Seite nach Schlüssel (updated_at, id), nicht nach Versatz: Ändert sich währenddessen
// eine ältere Zeile, rutscht so keine andere durch.
export function supabaseRemote(client: SupabaseClient, pageSize = 1000): Remote {
  return {
    async upsert(table, rows) {
      const { error } = await client.from(table).upsert(rows, { onConflict: 'id' });
      if (error) {
        const msg = `${table}: ${error.message}`;
        throw isRejection(error) ? new RejectedError(msg) : new Error(msg);
      }
    },
    async pullSince(table: TableName, since) {
      const out: Base[] = [];
      let last: Base | null = null;
      for (;;) {
        let q = client.from(table).select('*');
        if (since) q = q.gte('updated_at', since);
        if (last) q = q.or(`updated_at.gt."${last.updated_at}",and(updated_at.eq."${last.updated_at}",id.gt.${last.id})`);
        const { data, error } = await q
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(pageSize);
        if (error) throw new Error(`${table}: ${error.message}`);
        const page = (data ?? []) as Base[];
        out.push(...page);
        if (page.length < pageSize) break;
        last = page[page.length - 1];
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
