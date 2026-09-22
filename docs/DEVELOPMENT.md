# Folio — Development Workflow

Actual commands for this repository. Run Rust commands at the repo root; frontend commands inside `frontend/`. Do not invent commands — these are the ones wired in `Cargo.toml`, `frontend/package.json`, and the E2E scripts.

## Prerequisites

- **Node.js 18+** (frontend, E2E, tooling).
- **Rust toolchain** with the `wasm32-unknown-unknown` target (engine builds, tests).
- **`wasm-pack`** (WASM bridge builds).
- **Headless Chrome** for E2E (the suite uses `puppeteer-core` with a local Chrome install; see `frontend/e2e/*.mjs` headers for the expected binary path).
- **Local PDF corpus** (gitignored): a `test pdfs/` directory at the repo root containing the E2E fixtures (`1.2.pdf` and the large ~514 MB / 2585-page file). Provided via a gitignored symlink for local runs only; never committed. Small synthetic fixtures can be generated with `frontend/e2e/make-fixtures.mjs`.

## Setup (fresh clone)

```bash
git clone -b dev https://github.com/SUMANTHXT900/folio.git folio
cd folio

# Rust: no extra step — cargo handles dependencies.
cargo test

# Frontend + WASM:
cd frontend
npm install
npm run build:wasm   # generates ../wasm/pkg/ (gitignored) via wasm-pack
npm run dev          # → http://localhost:5173
```

Line endings are normalized to LF on checkout (`.gitattributes`, `text=auto eol=lf`); without this, Prettier's `format:check` fails on Windows CRLF checkouts.

## Daily development

```bash
cd frontend
npm run dev          # Vite dev server (production Studio, mock-free, worker engine)
```

No backend, no proxy, no localhost bridge. The dev server serves the app; the engine runs in the Web Worker from the `wasm/pkg/` build. `vite.config.ts` `server.fs.allow: ['..']` exists so the worker can load the `wasm/pkg` output during development; production builds inline the asset into `dist/`.

## Verification suite (run all, in this order)

```bash
# 1. Rust engine — repo root
cargo test                 # 345 tests: units + integration (one file per op + lifecycle)
cargo fmt --check          # must be clean
cargo clippy --all-targets # must be clean (warnings fail the bar)

# 2. WASM bridge — inside frontend/
npm run build:wasm         # wasm-pack build --target web --out-dir pkg (takes ~1 min)

# 3. Frontend checks — inside frontend/
npm run typecheck          # tsc --noEmit (requires wasm/pkg/ present)
npm run lint               # eslint src
npm run format:check       # prettier --check .
npm test                   # vitest run — 118 tests

# 4. Production build — inside frontend/
npm run build              # tsc + vite build + PWA service worker (precaches WASM)
```

## E2E (production Studio, real Chrome, real engine, no mocks)

```bash
cd frontend
# terminal 1: serve the app (use a fixed, verified port)
npx vite --port 5199 --strictPort
# terminal 2:
node e2e/studio.e2e.mjs --dev http://localhost:5199   # 25/25: home, tools, errors, large file, cancellation
```

Additional suites: `e2e/thumbnail.e2e.mjs`, `e2e/metadata.e2e.mjs`, `e2e/large-files.e2e.mjs`. Helpers: `e2e/make-fixtures.mjs` (synthetic fixtures), `e2e/baseline-shots.mjs` (UI screenshots).

**Port discipline (hard-won — see `docs/LESSONS.md` L-8):** before trusting an E2E run, confirm exactly one server process serves the port and that its path is the worktree you intend (stale servers from prior sessions silently serve old code). Kill strays by PID, start fresh with `--strictPort` (fails loudly instead of shifting ports), verify, then run.

## Large-file testing

The large corpus file (~514 MB / 2585 pages) lives only in the local `test pdfs/` directory. E2E asserts: full page count loads, thumbnail DOM stays bounded (24 images), zero console errors, cancellation works. Do not commit the file or any `test pdfs/` content (`*.pdf` is gitignored).

## Benchmark workflow

Benchmark records from engine development live with the engine code where legitimate (`src/observability/`, examples). There is no separate benchmark harness command in this repo; performance claims are verified through E2E completion metadata (`engineDurationMs`, output sizes) and the large-file suite. Do not present ad-hoc timings as benchmarks.

## Debugging

- Engine logic: reproduce natively first (`cargo test` with a focused filter, CLI examples in `examples/` against a local corpus copy) — native iteration is faster than the WASM loop.
- Browser behavior: dev server + browser console; the WASM glue installs `console_error_panic_hook`, so Rust panics surface as readable console messages instead of bare `unreachable`.
- Rendering/thumbnails: `frontend/src/rendering/devHook.ts` and `memory.ts` support inspection; unit tests in `rendering/*.test.ts` cover geometry, windows, and error mapping.

## Release workflow

1. Run the full verification suite above, **then** the fresh-clone verification: commit, push `dev`, clone `-b dev` to a temp directory, re-run the suite there (see `docs/LESSONS.md` L-8).
2. Update `docs/STATUS.md` baseline table, `docs/CHANGELOG.md`, `docs/WORKLOG.md`, and the About-page version entry if the release changes user-visible behavior.
3. Normal push to `dev` only. Never `--force`, never `main` from this workflow. `main` promotion is a separate explicit decision.
