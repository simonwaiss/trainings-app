import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockSupabase } from './mock-supabase';
import { StaticServer } from './server';

const ROOT = join(import.meta.dirname, '../..');

async function setup(page: Page, context: BrowserContext) {
  const mock = new MockSupabase();
  await mock.install(context);
  const server = new StaticServer(join(ROOT, 'dist-e2e-v1'));
  const url = await server.start();
  await page.goto(url);
  await page.getByLabel('E-Mail').fill('simon@example.org');
  await page.getByLabel('Passwort').fill('ein-langes-passwort');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('button', { name: 'Torso starten' })).toBeVisible();
  await expect(page.getByText('✓ gespeichert')).toBeVisible();
  return { mock, server, url };
}

const swReady = (page: Page) => page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

async function logSet(page: Page, exercise: string, label: string, kg: string, reps: string) {
  const r = region(page, exercise);
  await r.getByLabel(`kg Satz ${label}`, { exact: true }).fill(kg);
  await r.getByLabel(`Wiederholungen Satz ${label}`, { exact: true }).fill(reps);
  await r.getByRole('button', { name: `Satz ${label} erledigt`, exact: true }).click();
}

test('Torso loggen, beim nächsten Mal die Vorwerte sehen, Sätze liegen beim Server', async ({ page, context }) => {
  const { mock, server, url } = await setup(page, context);
  // Der Plan ist vorbelegt und beim Server angekommen.
  expect(mock.rows('templates').map((t) => t.name).sort()).toEqual(['Limbs', 'Torso']);

  await page.getByRole('button', { name: 'Torso starten' }).click();
  await logSet(page, 'Butterfly (Maschine)', '1', '50', '10');
  await expect(page.getByRole('timer')).toBeVisible();
  await logSet(page, 'Butterfly (Maschine)', '2', '52,5', '8');
  await logSet(page, 'Enges Rudern, Maschine mit Brustpolster', '1 L', '30', '12');
  await logSet(page, 'Enges Rudern, Maschine mit Brustpolster', '1 R', '30', '11');

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Beenden', exact: true }).click();
  await expect(page.getByText('beendet')).toBeVisible();
  await expect(page.getByText('✓ gespeichert')).toBeVisible();

  const done = mock.rows('sets').filter((s) => !s.deleted_at && s.done_at);
  expect(done.map((s) => `${s.side ?? '-'} ${s.weight_kg}×${s.reps}`).sort()).toEqual(['- 50×10', '- 52.5×8', 'L 30×12', 'R 30×11']);
  expect(done.every((s) => s.user_id === '11111111-1111-4111-8111-111111111111')).toBe(true);

  // Nächstes Training: Vorwerte stehen da, ✓ ohne Eingabe übernimmt sie.
  await page.goto(url);
  await page.getByRole('button', { name: 'Torso starten' }).click();
  const butterfly = region(page, 'Butterfly (Maschine)');
  await expect(butterfly.getByRole('button', { name: 'Vorwert für Satz 1 übernehmen' })).toHaveText('50 × 10');
  await expect(butterfly.getByRole('button', { name: 'Vorwert für Satz 2 übernehmen' })).toHaveText('52,5 × 8');
  await expect(
    region(page, 'Enges Rudern, Maschine mit Brustpolster').getByRole('button', { name: 'Vorwert für Satz 1 R übernehmen' }),
  ).toHaveText('30 × 11');
  await butterfly.getByRole('button', { name: 'Satz 1 erledigt', exact: true }).click();
  await expect(butterfly.getByLabel('kg Satz 1', { exact: true })).toHaveValue('50');
  await expect(butterfly.getByLabel('Wiederholungen Satz 1', { exact: true })).toHaveValue('10');
  await server.stop();
});

test('ohne Netz: Sätze überstehen Neuladen und gehen danach genau einmal an den Server', async ({ page, context }) => {
  const { mock, server } = await setup(page, context);
  await swReady(page);
  await page.getByRole('button', { name: 'Torso starten' }).click();
  await expect(page.getByText('✓ gespeichert')).toBeVisible();

  await context.setOffline(true);
  await logSet(page, 'Butterfly (Maschine)', '1', '60', '8');
  await logSet(page, 'Seitheben', '1', '7,5', '15');
  await expect(page.getByText(/offline · \d+ offen/)).toBeVisible();

  // App versehentlich geschlossen und im Funkloch wieder geöffnet:
  await page.reload();
  await expect(region(page, 'Butterfly (Maschine)').getByLabel('kg Satz 1', { exact: true })).toHaveValue('60');
  await expect(region(page, 'Seitheben').getByLabel('kg Satz 1', { exact: true })).toHaveValue('7,5');
  expect(mock.rows('sets').filter((s) => s.weight_kg === 60)).toHaveLength(0);

  await context.setOffline(false);
  await expect(page.getByText('✓ gespeichert')).toBeVisible({ timeout: 20_000 });
  expect(mock.rows('sets').filter((s) => s.weight_kg === 60 && s.reps === 8)).toHaveLength(1);
  expect(mock.rows('sets').filter((s) => s.weight_kg === 7.5 && s.reps === 15)).toHaveLength(1);
  const localCount = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('trainings-app');
        req.onsuccess = () => {
          const c = req.result.transaction('sets').objectStore('sets').count();
          c.onsuccess = () => resolve(c.result);
        };
      }),
  );
  expect(mock.rows('sets')).toHaveLength(localCount);
  await server.stop();
});

test('Update auf eine neue Version behält alle Daten', async ({ page, context }) => {
  const { server } = await setup(page, context);
  await swReady(page);
  await page.getByRole('button', { name: 'Torso starten' }).click();
  await logSet(page, 'Butterfly (Maschine)', '1', '70', '5');
  await expect(page.getByText('✓ gespeichert')).toBeVisible();
  const trainingUrl = page.url();

  server.root = join(ROOT, 'dist-e2e-v2');
  await page.reload();
  await expect(page.getByText('Neue Version da.')).toBeVisible({ timeout: 20_000 });
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Aktualisieren' }).click()]);
  await page.getByRole('link', { name: 'Mehr' }).click();
  await expect(page.getByText('Version e2e-2')).toBeVisible();
  await expect(page.getByText('Neue Version da.')).toHaveCount(0);
  await page.goto(trainingUrl);
  await expect(region(page, 'Butterfly (Maschine)').getByLabel('kg Satz 1', { exact: true })).toHaveValue('70');
  await server.stop();
});

test('Strong-Import: alte Trainings erscheinen im Verlauf und als Vorwerte', async ({ page, context }) => {
  const { mock, server, url } = await setup(page, context);
  await page.goto(`${url}#/import`);
  await page.getByLabel('CSV-Datei aus Strong').setInputFiles({
    name: 'strong.csv',
    mimeType: 'text/csv',
    buffer: readFileSync(join(import.meta.dirname, 'fixtures/strong-beispiel.csv.txt')),
  });
  await expect(page.getByText('2 Trainings')).toBeVisible();
  await page.getByRole('button', { name: 'Importieren' }).click();
  await expect(page.getByText('Importiert: 2 Trainings, 5 Sätze, 1 neue Übungen.')).toBeVisible();
  await expect(page.getByText('✓ gespeichert')).toBeVisible();
  expect(mock.rows('workouts').filter((w) => w.source === 'strong')).toHaveLength(2);
  expect(mock.rows('exercises').map((e) => e.name)).toContain('Leg Press');

  await page.goto(`${url}#/verlauf`);
  await expect(page.getByText('2 Trainings')).toBeVisible();
  await page.goto(url);
  await page.getByRole('button', { name: 'Torso starten' }).click();
  await expect(
    region(page, 'Butterfly (Maschine)').getByRole('button', { name: 'Vorwert für Satz 1 übernehmen' }),
  ).toHaveText('55 × 11');
  await server.stop();
});
