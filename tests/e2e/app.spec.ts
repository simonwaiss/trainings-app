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
  mock.offline = true;
  await logSet(page, 'Butterfly (Maschine)', '1', '60', '8');
  await logSet(page, 'Seitheben', '1', '7,5', '15');
  await expect(page.getByText(/offline · \d+ offen/)).toBeVisible();

  // App versehentlich geschlossen und im Funkloch wieder geöffnet:
  await page.reload();
  await expect(region(page, 'Butterfly (Maschine)').getByLabel('kg Satz 1', { exact: true })).toHaveValue('60');
  await expect(region(page, 'Seitheben').getByLabel('kg Satz 1', { exact: true })).toHaveValue('7,5');
  expect(mock.rows('sets').filter((s) => s.weight_kg === 60)).toHaveLength(0);

  mock.offline = false;
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

test('ohne Netz mit abgelaufener Anmeldung: die App erscheint sofort und meldet nicht „Abgemeldet“', async ({ page, context }) => {
  const { mock, server } = await setup(page, context);
  await swReady(page);
  await page.getByRole('button', { name: 'Torso starten' }).click();
  await logSet(page, 'Butterfly (Maschine)', '1', '40', '12');
  await expect(page.getByText('✓ gespeichert')).toBeVisible();
  // Anmeldung künstlich ablaufen lassen, dann im Funkloch neu öffnen.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.endsWith('-auth-token')) continue;
      const s = JSON.parse(localStorage.getItem(key)!);
      s.expires_at = Math.floor(Date.now() / 1000) - 3600;
      localStorage.setItem(key, JSON.stringify(s));
    }
  });
  mock.offline = true;
  await context.setOffline(true);
  await page.reload();
  await expect(region(page, 'Butterfly (Maschine)').getByLabel('kg Satz 1', { exact: true })).toHaveValue('40', { timeout: 3000 });
  await logSet(page, 'Butterfly (Maschine)', '2', '40', '10');
  await expect(page.getByText(/Abgemeldet/)).toHaveCount(0);
  mock.offline = false;
  await context.setOffline(false);
  await expect(page.getByText('✓ gespeichert')).toBeVisible({ timeout: 30_000 });
  expect(mock.rows('sets').filter((s) => s.weight_kg === 40 && s.reps === 10)).toHaveLength(1);
  await server.stop();
});

// Wischt eine Satzzeile nach links, wie mit dem Finger.
async function swipeLeft(page: Page, input: ReturnType<Page['getByLabel']>) {
  const row = input.locator('xpath=ancestor::tr');
  await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 30, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 160, y, { steps: 8 });
  await page.mouse.up();
}

const finish = async (page: Page) => {
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Beenden', exact: true }).click();
};

test('Satz wegwischen, beim Beenden „Torso ändern“: das nächste Torso hat den Satz nicht mehr', async ({ page, context }) => {
  const { mock, server, url } = await setup(page, context);
  await page.getByRole('button', { name: 'Torso starten' }).click();
  const seit = region(page, 'Seitheben');
  await logSet(page, 'Seitheben', '1', '10', '15');
  await swipeLeft(page, seit.getByLabel('kg Satz 2', { exact: true }));
  // Wischen allein löscht nichts und hakt nichts ab; erst „Entfernen“ entfernt den Satz.
  await expect(seit.getByText('Satz 2 entfernen?')).toBeVisible();
  await expect(seit.getByRole('button', { name: 'Satz 2 erledigt', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await seit.getByRole('button', { name: 'Entfernen', exact: true }).click();
  await expect(seit.getByLabel('kg Satz 3', { exact: true })).toHaveCount(0);
  await logSet(page, 'Seitheben', '2', '10', '14');
  await logSet(page, 'Butterfly (Maschine)', '1', '50', '10');
  await logSet(page, 'Butterfly (Maschine)', '2', '50', '9');

  await finish(page);
  const dlg = page.getByRole('dialog', { name: 'Torso geändert' });
  await expect(dlg.getByText('Seitheben: 3 → 2 Sätze')).toBeVisible();
  await expect(dlg.getByText(/^Weggelassen: Kabel-Flys von unten nach oben · Enges Rudern/)).toBeVisible();
  await expect(dlg.getByRole('button').first()).toHaveText('Nur dieses Training');
  await dlg.getByRole('button', { name: 'Torso ändern' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.getByText('✓ gespeichert')).toBeVisible();

  const torso = mock.rows('templates').find((t) => t.name === 'Torso')!;
  const links = mock.rows('template_exercises').filter((l) => l.template_id === torso.id && !l.deleted_at);
  expect(links.map((l) => l.sets)).toEqual([2, 2]);

  await page.goto(url);
  await page.getByRole('button', { name: 'Torso starten' }).click();
  await expect(region(page, 'Seitheben').getByLabel('kg Satz 2', { exact: true })).toBeVisible();
  await expect(region(page, 'Seitheben').getByLabel('kg Satz 3', { exact: true })).toHaveCount(0);
  await expect(region(page, 'Kabel-Flys von unten nach oben')).toHaveCount(0);
  await server.stop();
});

test('„Nur dieses Training“ lässt den Trainingstag, ein freies Training wird ein neuer Trainingstag', async ({ page, context }) => {
  const { mock, server, url } = await setup(page, context);
  await page.getByRole('button', { name: 'Torso starten' }).click();
  await logSet(page, 'Butterfly (Maschine)', '1', '50', '10');
  await finish(page);
  await page.getByRole('dialog', { name: 'Torso geändert' }).getByRole('button', { name: 'Nur dieses Training' }).click();
  await expect(page.getByText('✓ gespeichert')).toBeVisible();
  const torso = mock.rows('templates').find((t) => t.name === 'Torso')!;
  expect(mock.rows('template_exercises').filter((l) => l.template_id === torso.id && !l.deleted_at)).toHaveLength(12);

  await page.goto(url);
  await page.getByRole('button', { name: 'Freies Training' }).click();
  await page.getByRole('button', { name: '+ Übung hinzufügen' }).click();
  await page.getByLabel('Übung suchen').fill('Dips');
  await page.getByRole('button', { name: '„Dips“ anlegen' }).click();
  await logSet(page, 'Dips', '1', '0', '12');
  await finish(page);
  const dlg = page.getByRole('dialog', { name: 'Als Trainingstag speichern?' });
  await dlg.getByLabel('Name des Trainingstags').fill('Pump');
  await dlg.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('heading', { name: 'Pump', exact: true })).toBeVisible();
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Pump starten' })).toBeVisible();
  await server.stop();
});

test('dauerhafte Notiz, Aufwärmsatz, Rekord, Übung tauschen und Zusammenfassung', async ({ page, context }) => {
  const { server, url } = await setup(page, context);
  await page.getByRole('button', { name: 'Torso starten' }).click();
  const bf = region(page, 'Butterfly (Maschine)');
  await bf.getByRole('button', { name: 'Übung bearbeiten' }).click();
  await bf.getByRole('button', { name: 'Notiz', exact: true }).click();
  const note = bf.getByLabel('Dauerhafte Notiz zu Butterfly (Maschine)');
  await note.fill('Sitz auf Stufe 4');
  await note.blur();
  await expect(bf.getByRole('button', { name: 'Dauerhafte Notiz: Sitz auf Stufe 4' })).toBeVisible();
  await logSet(page, 'Butterfly (Maschine)', '1', '50', '10');
  await expect(bf.getByRole('img', { name: 'neuer Rekord' })).toHaveCount(0); // erstes Mal: kein Rekord
  await finish(page);
  await page.getByRole('dialog', { name: 'Torso geändert' }).getByRole('button', { name: 'Nur dieses Training' }).click();
  const sum = page.getByRole('region', { name: 'Zusammenfassung' });
  await expect(sum).toContainText('500 kg');

  await page.goto(url);
  await page.getByRole('button', { name: 'Torso starten' }).click();
  const bf2 = region(page, 'Butterfly (Maschine)');
  await expect(bf2.getByRole('button', { name: 'Dauerhafte Notiz: Sitz auf Stufe 4' })).toBeVisible();
  // Satz 1 wird Aufwärmsatz; der erste Arbeitssatz zeigt jetzt die Vorwerte vom letzten Mal.
  await bf2.getByRole('button', { name: 'Satz 1: Typ oder entfernen' }).click();
  await bf2.getByRole('button', { name: 'Aufwärmen' }).click();
  await expect(bf2.getByLabel('kg Satz A1', { exact: true })).toBeVisible();
  await expect(bf2.getByRole('button', { name: 'Vorwert für Satz 1 übernehmen' })).toHaveText('50 × 10');
  await logSet(page, 'Butterfly (Maschine)', '1', '55', '10');
  await expect(bf2.getByRole('img', { name: 'neuer Rekord' })).toHaveCount(1);

  const sh = region(page, 'Seitheben');
  await sh.getByRole('button', { name: 'Übung bearbeiten' }).click();
  await sh.getByRole('button', { name: 'Tauschen' }).click();
  await page.getByRole('dialog', { name: 'Seitheben tauschen gegen …' }).getByRole('button', { name: 'Beinbeuger sitzend' }).click();
  await expect(region(page, 'Seitheben')).toHaveCount(0);
  await expect(region(page, 'Beinbeuger sitzend').getByLabel('kg Satz 3', { exact: true })).toBeVisible();

  await finish(page);
  await page.getByRole('dialog', { name: 'Torso geändert' }).getByRole('button', { name: 'Nur dieses Training' }).click();
  await expect(sum).toContainText('Neuer Rekord: Butterfly (Maschine), 55 × 10');
  await server.stop();
});

test('Wischen mit dem Finger öffnet „Entfernen“, senkrechtes Wischen scrollt nur', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'echte Touch-Folgen gibt es nur über Chromium');
  const { server } = await setup(page, context);
  await page.getByRole('button', { name: 'Torso starten' }).click();
  const seit = region(page, 'Seitheben');
  const row = seit.getByLabel('kg Satz 2', { exact: true }).locator('xpath=ancestor::tr');
  await row.scrollIntoViewIfNeeded();
  const cdp = await context.newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });

  let box = (await row.boundingBox())!;
  await touch('touchStart', box.x + 120, box.y + box.height / 2);
  for (let i = 1; i <= 8; i++) await touch('touchMove', box.x + 120 - i, box.y + box.height / 2 - i * 12);
  await touch('touchEnd');
  await expect(seit.getByText(/entfernen\?/)).toHaveCount(0);

  box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  await touch('touchStart', box.x + box.width - 30, y);
  for (let i = 1; i <= 8; i++) await touch('touchMove', box.x + box.width - 30 - i * 16, y);
  await touch('touchEnd');
  await expect(seit.getByText('Satz 2 entfernen?')).toBeVisible();
  await expect(seit.getByRole('button', { name: 'Satz 2 erledigt', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await server.stop();
});
