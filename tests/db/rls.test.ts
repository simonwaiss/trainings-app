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

describe('Jede Tabelle und Ansicht ist abgesichert', () => {
  it('RLS ist überall an, ohne Login kommt nichts', async () => {
    const tables = await as<{ name: string; rls: boolean }>(
      'postgres',
      null,
      `select c.relname as name, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(6);
    for (const t of tables) {
      expect(t.rls, t.name).toBe(true);
      await expect(as('anon', null, `select * from public.${t.name}`), t.name).rejects.toThrow(/permission denied/);
    }
    const views = await as<{ name: string }>(
      'postgres',
      null,
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v'`,
    );
    for (const v of views) {
      await expect(as('anon', null, `select * from public.${v.name}`), v.name).rejects.toThrow(/permission denied/);
    }
  });

  it('die App-Rolle hat keinen Zugang zum Schema intern', async () => {
    const [r] = await as<{ ok: boolean }>('postgres', null, `select has_schema_privilege('authenticated', 'intern', 'USAGE') as ok`);
    expect(r.ok).toBe(false);
  });

  it('die Grenzen der App passen zu den Regeln der Datenbank', async () => {
    const { sanitize } = await import('../../src/db/limits');
    const ex = sanitize('exercises', {
      id: 'aaaaaaaa-0000-4000-8000-0000000000e1',
      name: 'x'.repeat(500),
      unilateral: false,
      rest_seconds: 99999,
      note: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    });
    const extremes = [
      { weight_kg: 1e9, reps: 3e9, rpe: 50 },
      { weight_kg: -20, reps: 7.5, rpe: -1 },
      { weight_kg: 52.555, reps: 0, rpe: null },
    ];
    await as('authenticated', SIMON, `insert into public.exercises (id, name, rest_seconds) values ('${ex.id}', '${ex.name}', ${ex.rest_seconds})`);
    await as('authenticated', SIMON, `insert into public.templates (id, name) values ('aaaaaaaa-0000-4000-8000-0000000000e2', 'T')`);
    const link = sanitize('template_exercises', {
      id: 'aaaaaaaa-0000-4000-8000-0000000000e3',
      template_id: 'aaaaaaaa-0000-4000-8000-0000000000e2',
      exercise_id: ex.id,
      position: 0,
      sets: 21,
      note: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    });
    await as('authenticated', SIMON, `insert into public.template_exercises (id, template_id, exercise_id, position, sets)
      values ('${link.id}', '${link.template_id}', '${link.exercise_id}', 0, ${link.sets})`);
    await as('authenticated', SIMON, `insert into public.workouts (id, name, started_at) values ('aaaaaaaa-0000-4000-8000-0000000000e4', 'W', now())`);
    await as('authenticated', SIMON, `insert into public.workout_exercises (id, workout_id, exercise_id, position) values ('aaaaaaaa-0000-4000-8000-0000000000e5', 'aaaaaaaa-0000-4000-8000-0000000000e4', '${ex.id}', 0)`);
    for (const [i, v] of extremes.entries()) {
      const s = sanitize('sets', {
        id: `aaaaaaaa-0000-4000-8000-00000000010${i}`,
        workout_id: 'aaaaaaaa-0000-4000-8000-0000000000e4',
        workout_exercise_id: 'aaaaaaaa-0000-4000-8000-0000000000e5',
        exercise_id: ex.id,
        position: 1,
        side: null,
        kind: 'normal',
        done_at: null,
        note: null,
        created_at: new Date().toISOString(),
        deleted_at: null,
        ...v,
      });
      await as('authenticated', SIMON, `insert into public.sets (id, workout_id, workout_exercise_id, exercise_id, position, weight_kg, reps, rpe)
        values ('${s.id}', '${s.workout_id}', '${s.workout_exercise_id}', '${s.exercise_id}', ${s.position},
                ${s.weight_kg ?? 'null'}, ${s.reps ?? 'null'}, ${s.rpe ?? 'null'})`);
    }
  });
});

describe('Körpergewicht', () => {
  const ins = (id: string, day: string, kg: number) =>
    `insert into public.body_weights (id, day, weight_kg) values ('${id}', '${day}', ${kg})
     on conflict (id) do update set weight_kg = excluded.weight_kg`;

  it('die Ansicht v_gewicht rechnet je Tag den 7-Tage-Schnitt und die Vorwoche, nur für Simon', async () => {
    const rows: [string, string, number][] = [
      ['bbbbbbbb-0000-4000-8000-000000000001', '2026-10-18', 80],
      ['bbbbbbbb-0000-4000-8000-000000000002', '2026-10-24', 79.4],
      ['bbbbbbbb-0000-4000-8000-000000000003', '2026-10-25', 79],
      ['bbbbbbbb-0000-4000-8000-000000000004', '2026-10-30', 78.5],
      ['bbbbbbbb-0000-4000-8000-000000000005', '2026-10-31', 79],
    ];
    for (const [id, day, kg] of rows) await as('authenticated', SIMON, ins(id, day, kg));
    await as('authenticated', SIMON, `update public.body_weights set deleted_at = now() where day = '2026-10-18'`);
    await as('authenticated', SIMON, ins('bbbbbbbb-0000-4000-8000-000000000006', '2026-10-19', 80.2));

    const view = await as<Record<string, unknown>>(
      'authenticated',
      SIMON,
      `select datum::text, kg::float, schnitt_7::float, werte_7::int, schnitt_vorwoche::float, werte_vorwoche::int, differenz::float
       from public.v_gewicht order by datum`,
    );
    expect(view.map((r) => r.datum)).toEqual(['2026-10-19', '2026-10-24', '2026-10-25', '2026-10-30', '2026-10-31']);
    const last = view[view.length - 1];
    // 25.10. bis 31.10.: 79, 78,5, 79; Vorwoche 18.10. bis 24.10.: 80,2 und 79,4 (der 18. ist entfernt)
    expect(last).toMatchObject({ kg: 79, schnitt_7: 78.83, werte_7: 3, schnitt_vorwoche: 79.8, werte_vorwoche: 2, differenz: -0.97 });
    expect(view[0]).toMatchObject({ schnitt_7: 80.2, werte_7: 1, schnitt_vorwoche: null, werte_vorwoche: 0 });

    expect(await as('authenticated', FREMD, 'select * from public.v_gewicht')).toEqual([]);
    expect(await as('authenticated', FREMD, 'select * from public.body_weights')).toEqual([]);
    await expect(as('anon', null, 'select * from public.v_gewicht')).rejects.toThrow(/permission denied/);
  });

  it('je Tag nur eine Zeile, und unmögliche Werte lehnt die Datenbank ab', async () => {
    await expect(as('authenticated', SIMON, ins('bbbbbbbb-0000-4000-8000-0000000000f1', '2026-10-31', 70))).rejects.toThrow(/unique/);
    await expect(as('authenticated', SIMON, ins('bbbbbbbb-0000-4000-8000-0000000000f2', '2026-09-01', 786))).rejects.toThrow(/check/);
    await expect(
      as('authenticated', SIMON, `insert into public.body_weights (id, day, weight_kg, source) values ('bbbbbbbb-0000-4000-8000-0000000000f3', '2026-09-02', 79, 'x')`),
    ).rejects.toThrow(/check/);
  });

  it('die Grenzen der App passen zur Datenbank', async () => {
    const { sanitize } = await import('../../src/db/limits');
    for (const [i, kg] of [5, 1000, 78.555].entries()) {
      const r = sanitize('body_weights', {
        id: `bbbbbbbb-0000-4000-8000-00000000010${i}`,
        day: `2026-08-0${i + 1}`,
        weight_kg: kg,
        source: 'irgendwas' as 'app',
        note: null,
        created_at: new Date().toISOString(),
        deleted_at: null,
      });
      await as('authenticated', SIMON, `insert into public.body_weights (id, day, weight_kg, source)
        values ('${r.id}', '${r.day}', ${r.weight_kg}, '${r.source}')`);
    }
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
