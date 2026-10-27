import type { Base, TableName } from '../../src/db/types';
import type { Remote } from '../../src/sync/sync';

// Nachbau des Servers im Speicher: setzt updated_at wie der Datenbank-Auslöser
// und kann Ausfälle (kein Netz) vortäuschen.
export class FakeRemote implements Remote {
  tables = new Map<TableName, Map<string, Base>>();
  offline = false;
  failAfterUpsert = false; // Server speichert, Antwort geht aber verloren
  upsertCalls = 0;
  private clock = Date.parse('2026-10-27T10:00:00Z');

  private tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  rows(table: TableName): Base[] {
    return [...(this.tables.get(table)?.values() ?? [])];
  }

  async upsert(table: TableName, rows: Record<string, unknown>[]) {
    if (this.offline) throw new TypeError('Failed to fetch');
    this.upsertCalls++;
    const t = this.tables.get(table) ?? new Map();
    this.tables.set(table, t);
    for (const r of rows) {
      const prev = t.get(r.id as string);
      t.set(r.id as string, { ...prev, ...(r as unknown as Base), updated_at: this.tick() });
    }
    if (this.failAfterUpsert) {
      this.failAfterUpsert = false;
      throw new TypeError('Failed to fetch');
    }
  }

  async pullSince(table: TableName, since: string | null) {
    if (this.offline) throw new TypeError('Failed to fetch');
    return this.rows(table)
      .filter((r) => !since || (r.updated_at ?? '') >= since)
      .sort((a, b) => (a.updated_at ?? '').localeCompare(b.updated_at ?? ''))
      .map((r) => ({ ...r }));
  }
}
