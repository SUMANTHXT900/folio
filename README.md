<p align="center">
  <img src="frontend/public/favicon.svg" alt="Folio" width="64" height="64" />
</p>

<h1 align="center">Folio</h1>

<p align="center">
  <strong>Private, fully local PDF tools.</strong><br />
  Merge, split, rearrange, rotate, edit metadata, and build PDFs from images - entirely in your browser.<br />
  Your files never leave your device.
</p>

<p align="center">
  <a href="https://dev.folio-pdf.pages.dev/" target="_blank" rel="noopener">
    <img src="https://img.shields.io/badge/Live-dev.folio--pdf.pages.dev-d9902d?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Live dev preview" />
  </a>
  <img src="https://img.shields.io/badge/version-1.7.0-d9902d?style=for-the-badge" alt="Version" />
  <img src="https://img.shields.io/badge/engine-Rust%20WASM-b7410e?style=for-the-badge" alt="Engine" />
  <img src="https://img.shields.io/badge/privacy-100%25%20local-16a34a?style=for-the-badge" alt="Privacy" />
</p>

> **This is the `dev` branch** - staging preview. Production (`main`) lives at [folio-pdf.pages.dev](https://folio-pdf.pages.dev).

---

## New architecture (v1.7.0)

PDF Studio has been rebuilt around the **Folio PDF engine** for document processing.

```text
PDF manipulation          Studio → Folio service → WasmWorkerEngineAdapter
                          → Web Worker → Rust/WASM (lopdf)

PDF rendering             Studio → PdfRenderEngine → PDF.js → canvas
```

- **Rust/WASM** performs all PDF manipulation (merge, split, extract, reorder, rotate, metadata, images-to-PDF), executed locally in a Web Worker so heavy work stays off the UI thread.
- **PDF.js** is used separately for rendering, previews, thumbnails, and page-count intake. It does not manipulate documents.
- The previous `pdf-lib` processing implementation has been fully replaced; the interactive Developer Testbench used during engine development is not part of this repository.

## Why Folio?

Most PDF tools upload your documents to a server to process them. **Folio doesn't.**
Every operation runs locally in your browser. It's a Progressive Web App, so it also works offline once loaded.

- 🔒 **Private by design** - files are processed in-memory and discarded when you close the tab
- ⚡ **Fast** - no network round-trips, no waiting on a server
- 📴 **Offline-capable** - installable PWA, works without a connection (including the WASM engine, which is precached)
- 🪶 **Lightweight** - no account, no tracking, no cookies

## Features

| Tool | What it does |
|------|--------------|
| **Merge** | Combine multiple PDFs into one document, in any order, with real progress, cancellation, and page counts |
| **Split** | Pick pages visually or carve a PDF by page ranges (one file per range), with structured validation errors |
| **Rearrange** | Drag to reorder pages, preview at full resolution, then save |
| **Rotate** | Rotate individual pages or the whole document by quarter turns |
| **Metadata** | Read and edit titles, authors, dates, and other document properties (set / clear / leave unchanged) |
| **Images → PDF** | Build one PDF from JPEG/PNG images, one page per image, fit or A4 pages |
| **Compress** | *Coming in a future update* - the action stays disabled rather than pretending to work |

Every tool reports real engine progress (stage + percentage), honest cancellation, completion time, and output sizes.

## Tech stack

- **React** + **TypeScript** + **Vite** - application UI and orchestration
- **Rust** compiled to **WebAssembly** (`wasm/`, via `wasm-pack`) - PDF manipulation and CPU-heavy document processing (`src/`, powered by `lopdf`)
- **Web Worker** - keeps heavy processing off the UI thread (`frontend/src/engine/engine.worker.ts`)
- **PDF.js** - rendering, previews, thumbnails, and page-count intake only (never document mutation)
- **Tailwind CSS** + **Framer Motion** - styling and transitions
- **Cloudflare Pages** for hosting (hash routing, no SPA rewrite needed)

## Privacy / local-first

- All PDF processing happens locally in the browser: Rust/WASM manipulation plus PDF.js rendering.
- Documents are not uploaded to a server for PDF processing; the application is designed to operate without a backend PDF-processing service.
- Once loaded, the app is offline-capable (PWA precache covers the app shell, fonts, PDF.js worker, and the WASM engine). The browser still loads local app assets; there is no remote PDF-processing backend to call.

## Repository layout

```text
pdf-studio/
├── frontend/     Production Studio (React + TS + Vite)
├── src/          Folio Rust PDF engine
├── wasm/         Rust → WASM bridge (wasm-pack)
├── tests/        Rust integration tests
├── examples/     Rust CLI examples (opt-in corpus tools)
├── ARCHITECTURE.md
└── README.md
```

## Getting started

Requires Node.js 18+ and a Rust toolchain with the `wasm32-unknown-unknown` target (plus `wasm-pack`) for engine builds.

```bash
# install frontend dependencies
cd frontend
npm install

# build the WASM engine package (generates wasm/pkg/, gitignored)
npm run build:wasm

# run the dev server (production Studio)
npm run dev

# build for production (outputs to frontend/dist/)
npm run build

# preview the production build locally
npm run preview
```

## Tests

```bash
# Rust engine (345 tests: units + integration)
cargo test
cargo fmt --check
cargo clippy --all-targets

# Frontend (unit tests, typecheck, lint, format) — run inside frontend/
npm test
npm run typecheck
npm run lint
npm run format:check
```

Production E2E (real headless Chrome, real engine, no mocks) lives in `frontend/e2e/`
and expects a local PDF corpus in a gitignored `test pdfs/` directory at the repo root:

```bash
cd frontend
node e2e/studio.e2e.mjs --dev http://localhost:5199
```

## Deploy

Folio is a static site. Build and deploy `frontend/dist/` to any static host — Cloudflare Pages, Netlify,
GitHub Pages, or your own server.

```bash
cd frontend
npm run build
npx wrangler pages deploy dist --project-name folio-pdf
```

## Project history

- **v1.7.0 (dev)** - Folio engine integration: Rust/WASM-powered PDF processing in a Web Worker, PDF.js retained for rendering, real progress/cancellation/structured errors, completion metadata (duration, page counts, output sizes), new Metadata and Images → PDF tools, Compress reserved for a future update, production UI preserved, Developer Testbench removed from the product.
- **v1.6.0** - cancellable merge jobs with stage progress, large-selection memory notice, mobile-aware blur.
- **v1.5.0** - PDF render Worker + main-thread fallback, blob-URL thumbs, Show-All resume, scaleX progress.
- **v1.4.0** - windowed rendering, right-sized scale, PWA offline fix, object-URL revocation, dead code removal, theme polish.
- **v1.0.0** - first public release: local Merge, Split, Rearrange, Rotate & Compress.

Git history is preserved; this release is a normal commit on top of it (no rewrites).

## License

[MIT](LICENSE) © SUMANTHXT900

---

<p align="center">
  Made with care by <a href="https://github.com/SUMANTHXT900" target="_blank" rel="noopener">Sumanth</a>
  · <a href="https://www.linkedin.com/in/sai-sumanth-giduthuri-0a9956329/" target="_blank" rel="noopener">LinkedIn</a>
</p>
