import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockSupabase } from './mock-supabase';
import { StaticServer } from './server';

// Stresstest mit einem echten Strong-Export (liegt nie im Repo): STRONG_CSV=/pfad/zur/datei.csv npx playwright test stress
// Prüft Import, Abgleich und Tempo mit Jahren an Daten, dazu ein zweites Gerät, das alles neu holt.
const CSV = process.env.STRONG_CSV;
const ROOT = join(import.meta.dirname, '../..');
test.skip(!CSV, 'nur mit STRONG_CSV');
test.setTimeout(300_000);

async function device(browser: Browser, mock: MockSupabase, url: string) {
  const { defaultBrowserType: _, ...iphone } = devices['iPhone 13'];
  const context = await browser.newContext({ ...iphone, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  await mock.install(context);
  const page = await context.newPage();
  // Langsameres Handy nachstellen (nur Chromium kann das).
  if (browser.browserType().name() === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  await page.goto(url);
  await page.getByLabel('E-Mail').fill('simon@example.org');
  await page.getByLabel('Passwort').fill('ein-langes-passwort');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  return page;
}

async function timed(label: string, fn: () => Promise<unknown>) {
  const t = Date.now();
  await fn();
  const ms = Date.now() - t;
  console.log(`${label}: ${(ms / 1000).toFixed(1)} s`);
  return ms;
}

const localCount = (page: Page, table: string) =>
  page.evaluate(
    (t) =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('trainings-app');
        req.onsuccess = () => {
          const c = req.result.transaction(t).objectStore(t).count();
          c.onsuccess = () => resolve(c.result);
        };
      }),
    table,
  );

test('echter Strong-Export: Import, Abgleich, zweites Gerät, Tempo', async ({ browser }) => {
  const mock = new MockSupabase();
  const server = new StaticServer(join(ROOT, 'dist-e2e-v1'));
  const url = await server.start();

  // Gerät 1 (iPhone): importieren
  const a = await device(browser, mock, url);
  await expect(a.getByRole('button', { name: 'Torso starten' })).toBeVisible({ timeout: 30_000 });
  await expect(a.getByText('✓ gespeichert')).toBeVisible({ timeout: 30_000 });
  await a.goto(`${url}#/import`);
  await timed('CSV lesen', async () => {
    await a.getByLabel('CSV-Datei aus Strong').setInputFiles({ name: 'strong.csv', mimeType: 'text/csv', buffer: readFileSync(CSV!) });
    await expect(a.getByText(/^\d+ Trainings$/)).toBeVisible({ timeout: 60_000 });
  });
  const summary = await a.locator('.card').first().innerText();
  console.log('Vorschau:', summary.replace(/\s+/g, ' '));
  const importMs = await timed('Importieren', async () => {
    await a.getByRole('button', { name: 'Importieren' }).click();
    await expect(a.getByText(/^Importiert:/)).toBeVisible({ timeout: 120_000 });
  });
  console.log(await a.getByText(/^Importiert:/).innerText());
  const syncMs = await timed('Alles an den Server', async () => {
    await expect(a.getByText('✓ gespeichert')).toBeVisible({ timeout: 180_000 });
  });

  const serverSets = mock.rows('sets').length;
  const serverWorkouts = mock.rows('workouts').length;
  console.log(`Server: ${serverWorkouts} Trainings, ${serverSets} Sätze, ${mock.upserts} Pakete`);
  expect(await localCount(a, 'sets')).toBe(serverSets);
  expect(await localCount(a, 'workouts')).toBe(serverWorkouts);

  // Ein zweiter Import derselben Datei legt nichts doppelt an.
  await a.goto(`${url}#/import`);
  await a.getByLabel('CSV-Datei aus Strong').setInputFiles({ name: 'strong.csv', mimeType: 'text/csv', buffer: readFileSync(CSV!) });
  await a.getByRole('button', { name: 'Importieren' }).click();
  await expect(a.getByText(/^Importiert:/)).toBeVisible({ timeout: 120_000 });
  await expect(a.getByText('✓ gespeichert')).toBeVisible({ timeout: 60_000 });
  expect(mock.rows('sets').length).toBe(serverSets);

  // Bedienung mit vollem Verlauf
  await timed('Start-Seite', async () => {
    await a.goto(url);
    await expect(a.getByRole('button', { name: 'Torso starten' })).toBeVisible({ timeout: 30_000 });
  });
  const torsoMs = await timed('Torso starten bis Vorwerte', async () => {
    await a.getByRole('button', { name: 'Torso starten' }).click();
    // Die Vorwerte laden kurz nach; bis dahin steht „–“ da.
    await expect(a.getByRole('button', { name: /^Vorwert für Satz 1/ }).first()).not.toHaveText('–', { timeout: 30_000 });
  });
  await expect(a.getByText('✓ gespeichert')).toBeVisible({ timeout: 60_000 });
  const prevA = await a.getByRole('button', { name: /^Vorwert für Satz/ }).allInnerTexts();
  console.log(`Vorwerte Gerät 1: ${prevA.length} Stück, z. B. ${prevA.slice(0, 4).join(' | ')}`);
  await timed('Verlauf', async () => {
    await a.goto(`${url}#/verlauf`);
    await expect(a.getByText(/\d+ Trainings/)).toBeVisible({ timeout: 30_000 });
  });
  await timed('Übungen und Kraftverlauf', async () => {
    await a.goto(`${url}#/uebungen`);
    await a.getByRole('link').filter({ hasText: 'Butterfly' }).first().click();
    await expect(a.locator('svg').first()).toBeVisible({ timeout: 30_000 });
  });

  // Gerät 2 (Mac): holt alles neu, in Seiten zu 1000
  const b = await device(browser, mock, url);
  const pullMs = await timed('Gerät 2 holt alles', async () => {
    await expect(b.getByRole('button', { name: 'Torso starten' })).toBeVisible({ timeout: 60_000 });
    await expect(b.getByText('✓ gespeichert')).toBeVisible({ timeout: 180_000 });
    await expect.poll(async () => (await localCount(b, 'sets')) - mock.rows('sets').length, { timeout: 120_000 }).toBe(0);
  });
  expect(await localCount(b, 'workouts')).toBe(mock.rows('workouts').length);
  expect(mock.rows('templates').filter((t) => !t.deleted_at).map((t) => t.name).sort()).toEqual(['Limbs', 'Torso']);

  // Gerät 2 sieht dasselbe Training von Gerät 1 und dieselben Vorwerte.
  await b.goto(url);
  await b.getByRole('button', { name: /^Läuft: Torso/ }).click();
  await expect(b.getByRole('button', { name: /^Vorwert für Satz 1/ }).first()).not.toHaveText('–', { timeout: 30_000 });
  expect(await b.getByRole('button', { name: /^Vorwert für Satz/ }).allInnerTexts()).toEqual(prevA);

  console.log(`Summe: Import ${importMs} ms, Senden ${syncMs} ms, Torso ${torsoMs} ms, Gerät 2 ${pullMs} ms`);
  await server.stop();
});
