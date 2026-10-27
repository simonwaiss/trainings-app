import { db, getMeta, setMeta } from '../db/local';
import { TABLES, type Base, type TableName } from '../db/types';

// Gegenstelle, gegen die abgeglichen wird. In der App ist das Supabase,
// in den Tests ein Nachbau im Speicher.
export interface Remote {
  // Wirft RejectedError, wenn der Server die Daten ablehnt, sonst (Netz) einen anderen Fehler.
  upsert(table: TableName, rows: Record<string, unknown>[]): Promise<void>;
  // Alle Zeilen mit updated_at >= since (oder alle, wenn since null), aufsteigend nach updated_at.
  pullSince(table: TableName, since: string | null): Promise<Base[]>;
}

// Der Server hat die Daten abgelehnt (Regel verletzt), das Netz war nicht schuld.
export class RejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RejectedError';
  }
}

const BATCH = 400;
// Nach so vielen Ablehnungen wird eine Zeile zurückgehalten, damit sie den Rest nicht aufhält.
export const MAX_FAILS = 3;
// Beim Holen etwas Überlappung, damit keine Zeile durch gleichzeitige Schreibvorgänge durchrutscht.
const OVERLAP_MS = 5 * 60 * 1000;

function toServer(row: Base, userId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('_') && k !== 'updated_at') out[k] = v;
  }
  out.user_id = userId;
  return out;
}

async function markSent(table: TableName, rows: Base[]) {
  const t = db.tbl(table);
  await db.transaction('rw', t, async () => {
    for (const r of rows) {
      const cur = (await t.get(r.id)) as Base | undefined;
      // Nur als gesendet markieren, wenn sich die Zeile seitdem nicht wieder geändert hat.
      if (cur && cur._rev === r._rev) await t.update(r.id, { _dirty: 0, _fails: 0, _error: null } as never);
    }
  });
}

async function markRejected(table: TableName, row: Base, error: string) {
  const t = db.tbl(table);
  await db.transaction('rw', t, async () => {
    const cur = (await t.get(row.id)) as Base | undefined;
    if (!cur || cur._rev !== row._rev) return; // inzwischen geändert: neuer Versuch mit neuem Stand
    const fails = (cur._fails ?? 0) + 1;
    await t.update(row.id, { _fails: fails, _error: error, _dirty: fails >= MAX_FAILS ? 2 : 1 } as never);
  });
}

export interface PushResult {
  sent: number;
  rejected: number;
}

// Schickt alle lokal geänderten Zeilen. Gleiche id = gleiche Zeile, darum entstehen nie doppelte Sätze,
// auch wenn ein Senden abbricht und wiederholt wird. Lehnt der Server einen Stapel ab, wird Zeile für Zeile
// gesendet; abgelehnte Zeilen werden übersprungen und halten den Rest nicht auf.
export async function push(remote: Remote, userId: string): Promise<PushResult> {
  // Alles Ungesendete in einem Zug lesen, damit Eltern und Kinder zum selben Stand gehören.
  const snapshot = await db.transaction('r', TABLES.map((n) => db.tbl(n)), async () => {
    const out = new Map<TableName, Base[]>();
    for (const name of TABLES) out.set(name, (await db.tbl(name).where('_dirty').equals(1).toArray()) as Base[]);
    return out;
  });

  const result: PushResult = { sent: 0, rejected: 0 };
  for (const name of TABLES) {
    const dirty = snapshot.get(name)!;
    for (let i = 0; i < dirty.length; i += BATCH) {
      const batch = dirty.slice(i, i + BATCH);
      try {
        await remote.upsert(name, batch.map((r) => toServer(r, userId)));
        await markSent(name, batch);
        result.sent += batch.length;
      } catch (e) {
        if (!(e instanceof RejectedError)) throw e; // Netz weg: später alles erneut
        for (const r of batch) {
          try {
            await remote.upsert(name, [toServer(r, userId)]);
            await markSent(name, [r]);
            result.sent++;
          } catch (err) {
            if (!(err instanceof RejectedError)) throw err;
            await markRejected(name, r, err.message);
            result.rejected++;
          }
        }
      }
    }
  }
  return result;
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
        if (r.updated_at && r.updated_at > max) max = r.updated_at;
        if (cur && cur._dirty !== 0 && cur._dirty !== undefined) continue;
        await t.put({ ...r, _dirty: 0, _rev: cur?._rev ?? 0 } as never);
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
  // Holen läuft auch, wenn das Senden scheitert: Ungesendetes ist beim Holen geschützt.
  let pushError: unknown = null;
  let pushed: PushResult = { sent: 0, rejected: 0 };
  try {
    pushed = await push(remote, userId);
  } catch (e) {
    pushError = e;
  }
  const received = await pull(remote);
  if (pushError) throw pushError;
  await setMeta('lastSync', new Date().toISOString());
  return { ...pushed, received };
}
