import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Prüft die Zeilenrechte (RLS) der echten Migration in einem Postgres im Speicher.
const SIMON = '11111111-1111-4111-8111-111111111111';
const FREMD = '22222222-2222-4222-8222-222222222222';
const dir = join(import.meta.dirname, '../../supabase/migrations');

let pg: PGlite;

async function as<T>(role: 'anon' | 'authenticated' | 'postgres', sub: string | null, sql: string): Promise<T[]> {
  return pg.transaction(async (tx) => {
    if (role !== 'postgres') {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [sub ? JSON.stringify({ sub }) : '']);
      await tx.exec(`set local role ${role}`);
    }
    const r = await tx.query<T>(sql);
    return r.rows;
  });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(join(import.meta.dirname, 'supabase-stub.sql'), 'utf8'));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(dir, f), 'utf8'));
  }
  await pg.exec(`insert into intern.erlaubte_adressen values ('simon@example.org')`);
  await pg.exec(`insert into auth.users values ('${SIMON}', 'simon@example.org')`);
  // Ein fremdes Konto direkt anlegen (am Auslöser vorbei), um die Zeilenrechte zu prüfen.
  await pg.exec(`alter table auth.users disable trigger nur_erlaubte_konten;
                 insert into auth.users values ('${FREMD}', 'fremd@example.org');
                 alter table auth.users enable trigger nur_erlaubte_konten;`);
  await as('authenticated', SIMON, `insert into public.exercises (id, name) values ('aaaaaaaa-0000-4000-8000-000000000001', 'Butterfly')`);
});

describe('Zeilenrechte', () => {
  it('Simon sieht seine Übung, user_id wird automatisch gesetzt', async () => {
    const rows = await as<{ name: string; user_id: string }>('authenticated', SIMON, 'select name, user_id from public.exercises');
    expect(rows).toEqual([{ name: 'Butterfly', user_id: SIMON }]);
  });

  it('ein fremdes Konto sieht nichts und kann nichts ändern', async () => {
    expect(await as('authenticated', FREMD, 'select * from public.exercises')).toEqual([]);
    expect(await as('authenticated', FREMD, 'select * from public.v_saetze')).toEqual([]);
    const changed = await as('authenticated', FREMD, `update public.exercises set name = 'x' returning id`);
    expect(changed).toEqual([]);
  });

  it('ein fremdes Konto kann keine Zeile unter Simons Namen anlegen', async () => {
    await expect(
      as('authenticated', FREMD, `insert into public.exercises (id, user_id, name) values (gen_random_uuid(), '${SIMON}', 'x')`),
    ).rejects.toThrow(/row-level security/);
  });

  it('ohne Login liefert die Datenbank nichts', async () => {
    await expect(as('anon', null, 'select * from public.exercises')).rejects.toThrow(/permission denied/);
    await expect(as('anon', null, 'select * from public.sets')).rejects.toThrow(/permission denied/);
    await expect(as('anon', null, 'select * from public.v_saetze')).rejects.toThrow(/permission denied/);
    await expect(as('anon', null, 'select * from intern.erlaubte_adressen')).rejects.toThrow(/permission denied/);
  });

  it('auch Simon kann über die App nichts endgültig löschen', async () => {
    await expect(as('authenticated', SIMON, 'delete from public.exercises')).rejects.toThrow(/permission denied/);
  });

  it('der Server setzt updated_at bei jeder Änderung neu', async () => {
    const [before] = await as<{ updated_at: Date }>('postgres', null, 'select updated_at from public.exercises');
    await new Promise((r) => setTimeout(r, 10));
    await as('authenticated', SIMON, `update public.exercises set name = 'Butterfly (Maschine)'`);
    const [after] = await as<{ updated_at: Date }>('postgres', null, 'select updated_at from public.exercises');
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('upsert mit gleicher id legt keine zweite Zeile an', async () => {
    const sql = `insert into public.exercises (id, name) values ('aaaaaaaa-0000-4000-8000-000000000002', 'Seitheben')
                 on conflict (id) do update set name = excluded.name`;
    await as('authenticated', SIMON, sql);
    await as('authenticated', SIMON, sql);
    const rows = await as('authenticated', SIMON, `select id from public.exercises where name = 'Seitheben'`);
    expect(rows).toHaveLength(1);
  });

  it('ein Konto mit Daten lässt sich nicht löschen', async () => {
    await expect(as('postgres', null, `delete from auth.users where id = '${SIMON}'`)).rejects.toThrow(/foreign key/);
  });
});

describe('Nur Simon kommt rein', () => {
  it('lehnt jedes weitere Konto ab, auch mit erlaubter Adresse', async () => {
    await expect(
      as('postgres', null, `insert into auth.users values (gen_random_uuid(), 'jemand@example.org')`),
    ).rejects.toThrow(/Registrierung gesperrt/);
    await expect(
      as('postgres', null, `insert into auth.users values (gen_random_uuid(), 'simon@example.org')`),
    ).rejects.toThrow(/Registrierung gesperrt/);
  });
});
