import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Läuft unter https://simonwaiss.github.io/trainings-app/ (GitHub Pages).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.BASE_PATH ?? '/trainings-app/') : '/',
  plugins: [
    react(),
    VitePWA({
      // Neue Version wird im Hintergrund geladen; die App fragt, bevor sie neu lädt.
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Training',
        short_name: 'Training',
        description: 'Simons Trainings-Log',
        lang: 'de',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0e0f11',
        theme_color: '#0e0f11',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: 'index.html',
        // Anfragen an Supabase nie zwischenspeichern: Daten kommen immer frisch oder aus der lokalen Kopie.
        navigateFallbackDenylist: [/^\/(rest|auth|functions)\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: { chunkSizeWarningLimit: 900 },
  server: { port: 5199 },
  preview: { port: 5198 },
}));
