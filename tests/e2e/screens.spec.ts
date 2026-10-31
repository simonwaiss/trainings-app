import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { MockSupabase } from './mock-supabase';
import { StaticServer } from './server';

// Nur für Bildschirmfotos zur Sichtprüfung, läuft mit SCREENS=1.
test.skip(!process.env.SCREENS, 'nur auf Wunsch');
const OUT = process.env.SCREENS ?? '';
for (const scheme of ['light', 'dark'] as const) {
  test(`Bildschirme ${scheme}`, async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const mock = new MockSupabase();
    await mock.install(context);
    const server = new StaticServer(join(import.meta.dirname, '../../dist-e2e-v1'));
    const url = await server.start();
    await page.goto(url);
    await page.screenshot({ path: `${OUT}/${scheme}-0-login.png` });
    await page.getByLabel('E-Mail').fill('simon@example.org');
    await page.getByLabel('Passwort').fill('ein-langes-passwort');
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await expect(page.getByRole('button', { name: 'Torso starten' })).toBeVisible();
    await page.goto(`${url}#/import`);
    await page.getByLabel('CSV-Datei aus Strong').setInputFiles({ name: 's.csv', mimeType: 'text/csv', buffer: Buffer.from(
      ['Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps',
       ...Array.from({ length: 12 }, (_, i) => [`2026-0${Math.floor(i / 4) + 7}-${String((i % 4) * 7 + 1).padStart(2, '0')} 18:00:00,Torso,1h,Butterfly (Machine),1,${50 + i * 1.5},${10 - (i % 3)}`,
         `2026-0${Math.floor(i / 4) + 7}-${String((i % 4) * 7 + 1).padStart(2, '0')} 18:00:00,Torso,1h,Butterfly (Machine),2,${50 + i * 1.5},${9 - (i % 3)}`]).flat()].join('\n')) });
    await page.getByRole('button', { name: 'Importieren' }).click();
    await expect(page.getByText(/Importiert:/)).toBeVisible();
    await page.goto(url);
    await page.screenshot({ path: `${OUT}/${scheme}-1-home.png` });
    await page.getByRole('button', { name: 'Torso starten' }).click();
    const r = page.getByRole('region', { name: 'Butterfly (Maschine)', exact: true });
    await r.getByLabel('kg Satz 1', { exact: true }).fill('67,5');
    await r.getByLabel('Wiederholungen Satz 1', { exact: true }).fill('9');
    await r.getByRole('button', { name: 'Satz 1 erledigt', exact: true }).click();
    await page.screenshot({ path: `${OUT}/${scheme}-2-training.png`, fullPage: true });
    await r.getByRole('link', { name: 'Butterfly (Maschine)' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${scheme}-3-uebung.png`, fullPage: true });
    const card = page.locator('.card').first();
    await card.locator('svg').click({ position: { x: 200, y: 80 } });
    await card.screenshot({ path: `${OUT}/${scheme}-4-chart.png` });

    // Gewicht: drei Wochen Werte, heute frisch eingetragen.
    const days = await page.evaluate(() =>
      Array.from({ length: 21 }, (_, n) => {
        const d = new Date();
        d.setDate(d.getDate() - n - 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }),
    );
    const now = new Date().toISOString();
    mock.tables.set(
      'body_weights',
      new Map(
        days
          .filter((_, n) => n % 5 !== 3)
          .map((day, n) => [
            `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`,
            { id: `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`, user_id: '11111111-1111-4111-8111-111111111111',
              day, weight_kg: Math.round((78.4 + n * 0.04 + Math.sin(n * 1.7) * 0.5) * 10) / 10, source: n > 15 ? 'vault' : 'app',
              note: null, created_at: now, updated_at: now, deleted_at: null },
          ]),
      ),
    );
    await page.goto(`${url}#/gewicht`);
    await page.reload();
    await expect(page.getByText('Vorwoche')).toBeVisible();
    await page.getByLabel('Gewicht in kg').fill('78,6');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${scheme}-5-gewicht.png`, fullPage: true });
    await server.stop();
  });
}
