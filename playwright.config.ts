import { defineConfig, devices } from '@playwright/test';

// In WebKit läuft der Supabase-Nachbau als echter Server auf festem Port, darum dort ein Test nach dem anderen.
if (process.env.PW_BROWSER === 'webkit') process.env.MOCK_HTTP = '1';

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  fullyParallel: !process.env.MOCK_HTTP,
  workers: process.env.MOCK_HTTP ? 1 : undefined,
  reporter: [['list']],
  use: {
    ...devices['iPhone 13'],
    // PW_BROWSER=webkit prüft mit der Safari-Engine (wie auf dem iPhone).
    browserName: process.env.PW_BROWSER === 'webkit' ? 'webkit' : 'chromium',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    trace: 'retain-on-failure',
  },
});
