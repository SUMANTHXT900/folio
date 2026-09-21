import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite';
import { version } from './package.json';

// Studio dev server. No backend, no proxy: the engine boundary is a
// Web-Worker adapter (see src/engine/EngineAdapter.ts) with a mock for
// unit tests. `server.fs.allow` below exists so the worker can load the
// wasm-pack output (`../wasm/pkg`, built by `npm run build:wasm`) during
// development; production builds inline the asset into `dist/` instead.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Folio - PDF tools that stay on your device',
        short_name: 'Folio',
        description:
          'Merge, split, rearrange, rotate PDFs and edit metadata - 100% in your browser, fully offline. Your files never leave your device.',
        theme_color: '#faf7f2',
        background_color: '#faf7f2',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // The Folio WASM engine (~1.6 MB) must be precached for offline use,
        // so `wasm` is included alongside the default asset types.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,wasm,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  define: {
    __FOLIO_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 5173,
    fs: {
      allow: ['..'],
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
  },
});
