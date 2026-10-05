import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig, type Plugin } from 'vite';
import { version } from './package.json';

/**
 * Dev-only: serve scanic's vendored ORT loader as a plain static file.
 * The ML runtime loads `ort-wasm-simd-threaded.mjs` through a runtime
 * dynamic `import()` built from `wasmPaths` — Vite's dev middleware refuses
 * to transform-import anything under `public/` (500 + fullscreen error
 * overlay, which also eats trusted-mouse hit-testing for E2E drags), while
 * production serves the same file statically with no issue. This middleware
 * runs before the transform stack (`serve` only — never in `build`) and
 * answers that one URL with the file bytes + JS MIME, so dev exercises the
 * real ML path exactly like production. The `.ort`/`.wasm` siblings are
 * plain runtime `fetch()`es and already serve fine from `public/`.
 */
function scanicMlDevLoader(): Plugin {
  return {
    name: 'folio-scanic-ml-dev-loader',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const path = (req.url ?? '').split('?')[0];
          if (path !== '/assets/scanic-ml/ort-wasm-simd-threaded.mjs') {
            next();
            return;
          }
          const { readFile } = await import('node:fs/promises');
          const { join } = await import('node:path');
          const bytes = await readFile(
            join(server.config.publicDir, 'assets', 'scanic-ml', 'ort-wasm-simd-threaded.mjs'),
          );
          res.setHeader('Content-Type', 'text/javascript');
          res.setHeader('Cache-Control', 'no-store');
          res.end(bytes);
        } catch {
          next();
        }
      });
    },
  };
}

// Studio dev server. No backend, no proxy: the engine boundary is a
// Web-Worker adapter (see src/engine/EngineAdapter.ts) with a mock for
// unit tests. `server.fs.allow` below exists so the worker can load the
// wasm-pack output (`../wasm/pkg`, built by `npm run build:wasm`) during
// development; production builds inline the asset into `dist/` instead.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    scanicMlDevLoader(),
    VitePWA({
      // Prompt semantics (not autoUpdate): the new worker downloads in the
      // background and waits; the app surfaces it (banner + About card) and
      // activates only on explicit user tap. autoUpdate bypasses
      // onNeedRefresh entirely (background activate + forced reload, and
      // updateSW(true) becomes a no-op) — that single mismatch froze the
      // About update UI. See pwa/updateManager.ts.
      registerType: 'prompt',
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
        // The Folio WASM engine (~1.6 MB) and the vendored scanic-ml assets
        // (doccornernet_lean.ort ~1.9 MB, custom ORT wasm ~1.5 MB + loader)
        // must be precached for offline use, so `ort` joins `wasm` alongside
        // the default asset types.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,wasm,ort,woff2}'],
        // Raised 8MB -> 10MB for the self-hosted ML detector (D33 vendor plan;
        // D34 integration): measured worst-case dist/ ~8.4-8.5 MB. Alarm rule:
        // if measured dist/ crosses 9MB during integration, revisit instead of
        // bumping blindly.
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        // Keep outdated precaches: when a new service worker activates it
        // must NOT delete the previous deployment's hashed chunks, or an
        // already-open page from that deployment fails its next lazy
        // import with "Failed to fetch dynamically imported module"
        // (BUGS F-12). Browser quota eviction is the backstop; the
        // ErrorBlock stale-chunk recovery covers any remaining skew.
        cleanupOutdatedCaches: false,
      },
    }),
  ],
  define: {
    __FOLIO_VERSION__: JSON.stringify(version),
    // Stamped when the dev server / build config loads (D36 dev-channel card).
    __FOLIO_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
    fs: {
      // Explicit allow list overrides Vite's default app-root allowance,
      // so `.` (the app root) must stay listed alongside the engine bridge
      // output. Narrowed from the repo root at the D33 scanner strip
      // (the old list implicitly allowed the deleted `scan/pkg`).
      allow: ['.', '../wasm'],
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
  },
});
