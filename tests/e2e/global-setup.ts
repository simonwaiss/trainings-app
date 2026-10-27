import { execSync } from 'node:child_process';
import { MOCK_URL } from './mock-supabase';

// Baut die App zweimal (Version 1 und 2) gegen den Supabase-Nachbau.
export default function globalSetup() {
  for (const v of ['1', '2']) {
    execSync(`npx vite build --outDir dist-e2e-v${v} --emptyOutDir`, {
      stdio: 'inherit',
      env: {
        ...process.env,
        VITE_APP_VERSION: `e2e-${v}`,
        VITE_SUPABASE_URL: MOCK_URL,
        VITE_SUPABASE_KEY: 'sb_publishable_test',
        BASE_PATH: '/trainings-app/',
      },
    });
  }
}
