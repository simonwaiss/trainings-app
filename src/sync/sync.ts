import { db, getMeta, setMeta } from '../db/local';
import { TABLES, type Base, type TableName } from '../db/types';

// Gegenstelle, gegen die abgeglichen wird. In der App ist das Supabase,
// in den Tests ein Nachbau im Speicher.
export interface Remote {
  upsert(table: TableName, rows: Record<string, unknown>[]): Promise<void>;
  // Alle Zeilen mit updated_at >= since (oder alle, wenn since null), aufsteigend nach updated_at.
  pullSince(table: TableName, since: string | null): Promise<Base[]>;
}

const BATCH = 400;
// Beim Holen etwas Überlappung, damit keine Zeile durch gleichzeitige Schreibvorgänge durchrutscht.
const OVERLAP_MS = 5 * 60 * 1000;

function toServer(row: Base, userId: string): Record<string, unknown> {
  const { _dirty, _rev, updated_at, ...rest } = row;
  void _dirty;
  void _rev;
  void updated_at;
  return { ...rest, user_id: userId };
}

// Schickt alle lokal geänderten Zeilen. Gleiche id = gleiche Zeile, darum entstehen nie doppelte Sätze,
// auch wenn ein Senden abbricht und wiederholt wird.
export async function push(remote: Remote, userId: string): Promise<number> {
  let sent = 0;
  for (const name of TABLES) {
    const t = db.tbl(name);
    const dirty = (await t.where('_dirty').equals(1).toArray()) as Base[];
    for (let i = 0; i < dirty.length; i += BATCH) {
      const batch = dirty.slice(i, i + BATCH);
      await remote.upsert(
        name,
        batch.map((r) => toServer(r, userId)),
      );
      // Nur als gesendet markieren, wenn sich die Zeile seitdem nicht wieder geändert hat.
      await db.transaction('rw', t, async () => {
        for (const r of batch) {
          const cur = (await t.get(r.id)) as Base | undefined;
          if (cur && cur._rev === r._rev) await t.update(r.id, { _dirty: 0 } as never);
        }
      });
      sent += batch.length;
    }
  }
  return sent;
}

// Holt, was sich beim Server geändert hat. Lokal ungesendete Änderungen gewinnen; sie gehen beim nächsten Senden raus.
export async function pull(remote: Remote): Promise<number> {
  let received = 0;
  for (const name of TABLES) {
    const t = db.tbl(name);
    const cursor = await getMeta<string>(`pull:${name}`);
    const since = cursor ? new Date(new Date(cursor).getTime() - OVERLAP_MS).toISOString() : null;
    const rows = await remote.pullSince(name, since);
    if (rows.length === 0) continue;
    let max = cursor ?? '';
    await db.transaction('rw', t, async () => {
      for (const r of rows) {
        const cur = (await t.get(r.id)) as Base | undefined;
        if (cur?._dirty === 1) continue;
        await t.put({ ...r, _dirty: 0, _rev: cur?._rev ?? 0 } as never);
        if (r.updated_at && r.updated_at > max) max = r.updated_at;
      }
    });
    if (max) await setMeta(`pull:${name}`, max);
    received += rows.length;
  }
  return received;
}

export async function syncOnce(remote: Remote, userId: string) {
  const owner = await getMeta<string>('owner');
  if (owner && owner !== userId) {
    throw new Error('Auf diesem Gerät liegen Daten eines anderen Kontos. Nichts gesendet.');
  }
  if (!owner) await setMeta('owner', userId);
  const sent = await push(remote, userId);
  const received = await pull(remote);
  await setMeta('lastSync', new Date().toISOString());
  return { sent, received };
}
