<p align="center">
  <img src="app/public/favicon.svg" alt="Folio" width="72" height="72" />
</p>

<h1 align="center">Folio</h1>

<p align="center">
  <strong>Private PDF tools that stay on your device.</strong><br />
  Merge, split, rearrange, rotate, edit metadata, scan pages, and build PDFs from images — entirely in your browser.<br />
  Your files never leave your device.
</p>

<p align="center">
  <a href="https://folio-pdf.pages.dev/" target="_blank" rel="noopener">
    <img src="https://img.shields.io/badge/Open-folio--pdf.pages.dev-d9902d?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Open Folio" />
  </a>
  <img src="https://img.shields.io/badge/version-1.9.0-d9902d?style=for-the-badge" alt="Version" />
  <img src="https://img.shields.io/badge/engine-Rust%20WASM-b7410e?style=for-the-badge" alt="Engine" />
  <img src="https://img.shields.io/badge/privacy-100%25%20local-16a34a?style=for-the-badge" alt="Privacy" />
</p>

---

## Why Folio?

Most PDF tools upload your documents to a server to process them. **Folio doesn't.** Every operation runs locally in your browser. It's a Progressive Web App, so it also works offline once loaded.

- 🔒 **Private by design** — files are processed in memory and discarded when you close the tab
- ⚡ **Fast** — no network round-trips, no waiting on a server
- 📴 **Offline-capable** — installable PWA, works without a connection (the WASM engine is precached)
- 🪶 **Lightweight** — no account, no tracking, no cookies

## Features

| Tool | What it does |
|------|--------------|
| **Merge** | Combine multiple PDFs into one document, in any order, with real progress, cancellation, and page counts |
| **Split** | Pick pages visually or carve a PDF by page ranges (one file per range), with structured validation errors |
| **Rearrange** | Drag to reorder pages, preview at full resolution, then save |
| **Rotate** | Rotate individual pages or the whole document by quarter turns |
| **Metadata** | Read and edit titles, authors, dates, and other document properties (set / clear / leave unchanged) |
| **Images → PDF** | Build one PDF from JPEG/PNG images — upload, or scan pages with the on-device camera (auto-crop + enhance) |
| **Compress** | *Coming in a future update* — the action stays disabled rather than pretending to work |

Every completed file gets a smart name derived from your inputs (or your own custom name) before it downloads. Every tool reports real engine progress, honest cancellation, completion time, and output sizes.

## How it works

```text
PDF manipulation          Studio → Folio service → WasmWorkerEngineAdapter
                          → Web Worker → Rust/WASM (lopdf)

PDF rendering             Studio → PdfRenderEngine → PDF.js → canvas
```

- **Rust/WASM** performs all PDF manipulation (inspect, extract, split, reorder, delete, rotate, merge, images-to-PDF, metadata read/write), executed locally in a Web Worker so heavy work stays off the UI thread.
- **PDF.js** is used separately for rendering, previews, thumbnails, and page-count intake. It never manipulates documents.

## Privacy / local-first

- Core PDF processing runs locally in the browser through Rust/WASM and does not require uploading documents to a remote PDF-processing server.
- PDF.js rendering uses local application assets for previews and thumbnails.
- Once loaded, the app is offline-capable (PWA precache covers the app shell, fonts, PDF.js worker, and the WASM engine). The browser still loads local app assets; there is no remote PDF-processing backend to call.

## Repository layout

```text
folio/
├── app/          Production Studio (React + TS + Vite)
├── engine/       Folio Rust PDF engine (src, tests, examples, Cargo.toml)
├── scan/         On-device document-scan core (detect, warp, enhance)
├── wasm/         Rust → WASM bridge (wasm-pack)
├── docs/         Persistent project memory
├── AGENTS.md
└── README.md
```

## Getting started

Requires Node.js 18+ and a Rust toolchain with the `wasm32-unknown-unknown` target (plus `wasm-pack`) for engine builds.

```bash
# install frontend dependencies
cd app
npm install

# build the WASM engine + scan packages (generates wasm/pkg/ and scan/pkg/, gitignored)
npm run build:wasm
npm run build:scan

# run the dev server (production Studio)
npm run dev

# build for production (outputs to app/dist/)
npm run build

# preview the production build locally
npm run preview
```

## Tests

```bash
# Rust engine + scan core (382 + 39 tests)
cd engine && cargo test && cargo fmt --check && cargo clippy --all-targets
cd ../scan && cargo test && cargo fmt --check && cargo clippy --all-targets

# Frontend (380 unit tests, typecheck, lint, format) — run inside app/
cd app
npm test
npm run typecheck
npm run lint
npm run format:check
```

Production E2E (real headless Chrome, real engine, no mocks) lives in `app/e2e/` — 57/57 passing from a fresh clone with no private corpus:

```bash
cd app
npx vite --port 5199 --strictPort &
node e2e/studio.e2e.mjs --dev http://localhost:5199
```

## Deploy

Folio is a static site. Production deploys from `main` to Cloudflare Pages:

```bash
cd app
npm run build
npx wrangler pages deploy dist --project-name folio-pdf --branch main
```

## License

[MIT](LICENSE) © SUMANTHXT900

---

<p align="center">
  Made with care by <a href="https://github.com/SUMANTHXT900" target="_blank" rel="noopener">Sumanth</a>
  · <a href="https://www.linkedin.com/in/sai-sumanth-giduthuri-0a9956329/" target="_blank" rel="noopener">LinkedIn</a>
  · <a href="https://github.com/SUMANTHXT900/folio/issues/new" target="_blank" rel="noopener">Suggest a feature</a>
</p>
