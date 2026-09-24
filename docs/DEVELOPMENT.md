# Folio — Development Workflow

Actual commands for this repository. Run Rust commands in `engine/`; frontend commands in `app/`. Do not invent commands — these are the ones wired in `engine/Cargo.toml`, `app/package.json`, and the E2E scripts.

## Prerequisites

- **Node.js 18+** (frontend, E2E, tooling).
- **Rust toolchain** with the `wasm32-unknown-unknown` target (engine builds, tests).
- **`wasm-pack`** (WASM bridge builds).
- **Headless Chrome** for E2E (the suite uses `puppeteer-core` with a local Chrome install; see `app/e2e/*.mjs` headers for the expected binary path).
- **No private PDF corpus required.** A fresh clone runs the full canonical suite with only the dependencies above. Large external PDFs are optional developer-owned benchmark inputs (see "Optional large-file testing" below), never committed.

## Testing policy: canonical vs optional

**Canonical tests** must be reproducible from the repository alone: Rust unit + integration tests, deterministic fixtures, frontend unit tests, the canonical E2E suite (`app/e2e/studio.e2e.mjs`), and build/typecheck/lint/format validation. A fresh clone runs all of these with no private corpus.

**Optional large-file / performance validation** uses developer-supplied PDFs (hundred-megabyte / thousand-page real-world files) for stress testing, memory testing, benchmark runs, and large-document QA. It is never required for `npm test`, canonical E2E, fresh-clone validation, CI, production builds, or normal development. Previously verified results (e.g. the ~514 MB / 2585-page runs from engine development) remain historical benchmark evidence, not repository fixtures.

## Setup (fresh clone)

```bash
git clone -b dev https://github.com/SUMANTHXT900/folio.git folio
cd folio

# Rust engine (its own manifest + lockfile in engine/, no workspace):
cd engine
cargo test

# Document-scan core (same independent-manifest pattern in scan/):
cd ../scan
cargo test

# Frontend + WASM:
cd ../app
npm install
npm run build:wasm   # generates ../wasm/pkg/ (gitignored) via wasm-pack
npm run build:scan   # generates ../scan/pkg/ (gitignored) via wasm-pack
npm run dev          # → http://localhost:5173
```

Line endings are normalized to LF on checkout (`.gitattributes`, `text=auto eol=lf`); without this, Prettier's `format:check` fails on Windows CRLF checkouts.

## Daily development

```bash
cd app
npm run dev          # Vite dev server (production Studio, mock-free, worker engine)
```

No backend, no proxy, no localhost bridge. The dev server serves the app; the engine runs in the Web Worker from the `wasm/pkg/` build. `vite.config.ts` `server.fs.allow: ['..']` exists so the worker can load the `wasm/pkg` output during development (from `app/`, `..` is still the repo root, and the worker import `../../../wasm/pkg/` is unchanged in depth); production builds inline the asset into `dist/`.

## Verification suite (run all, in this order)

```bash
# 1. Rust engine — inside engine/
cargo test                 # 345 tests: units + integration (one file per op + lifecycle)
cargo fmt --check          # must be clean
cargo clippy --all-targets # must be clean (warnings fail the bar)

# 1b. Document-scan core — inside scan/ (v2.0 M1+)
cargo test                 # scan pipeline tests (geometry, detect, warp, enhance)
cargo fmt --check          # must be clean
cargo clippy --all-targets # must be clean (warnings fail the bar)

# 2. WASM bridge — inside app/
npm run build:wasm         # wasm-pack build --target web --out-dir pkg (takes ~1 min)

# 3. Frontend checks — inside app/
npm run typecheck          # tsc --noEmit (requires wasm/pkg/ present)
npm run lint               # eslint src
npm run format:check       # prettier --check .
npm test                   # vitest run — 118 tests

# 4. Production build — inside app/
npm run build              # tsc + vite build + PWA service worker (precaches WASM)
```

## E2E (production Studio, real Chrome, real engine, no mocks)

```bash
cd app
# terminal 1: serve the app (use a fixed, verified port)
npx vite --port 5199 --strictPort
# terminal 2: canonical suite — passes from a fresh clone, no corpus needed
node e2e/studio.e2e.mjs --dev http://localhost:5199
```

`studio.e2e.mjs` is the canonical suite (home, tools, errors, cancellation where
reproducible). When the optional local corpus exists it uses the real fixtures;
otherwise it generates deterministic synthetic PDFs (same page shapes, ASCII
metadata — see `e2e/corpus.mjs`) to an OS temp dir and runs the same flows.
Only the large-file sections need the real corpus: when `test pdfs/merged.pdf`
is absent they print `SKIP` with the reason and the suite still passes.

Optional suites (require the local corpus; SKIP cleanly with exit 0 when it is
absent — never wait on, never fail for, a missing optional file):

- `e2e/large-files.e2e.mjs` — rendering/thumbnail stress matrix over the corpus
- `e2e/thumbnail.e2e.mjs` — thumbnail engine matrix incl. large-doc stress
- `e2e/metadata.e2e.mjs` — engine metadata matrix incl. large-file read/write

Helpers: `e2e/make-fixtures.mjs` (committed `pixel.png`/`pixel.jpg` used by the
Images → PDF flow), `e2e/baseline-shots.mjs` (manual screenshots; needs the
corpus `1.2.pdf`, exits 2 with a clear message when absent), `e2e/corpus.mjs`
(shared corpus policy + synthetic-PDF writer).

**Port discipline (hard-won — see `docs/LESSONS.md` L-8):** before trusting an E2E run, confirm exactly one server process serves the port and that its path is the worktree you intend (stale servers from prior sessions silently serve old code). Kill strays by PID, start fresh with `--strictPort` (fails loudly instead of shifting ports), verify, then run.

## Optional large-file testing

Large PDFs are developer-owned benchmark/stress-test inputs, never repository
fixtures. To run the optional suites, place your own files in a local-only
`test pdfs/` directory at the repo root (explicitly OPTIONAL / GITIGNORED / NOT
REQUIRED FOR NORMAL TESTING — see `.gitignore`; never commit the PDFs):

```text
folio/
└── test pdfs/            # gitignored; create locally only for stress runs
    ├── 1.2.pdf
    ├── 2. EWTL-Uniform Plane Wave.pdf
    ├── generated.pdf
    └── merged.pdf        # large file for the bounded-thumbnail + cancel runs
```

With the corpus present, `studio.e2e.mjs` runs its large-file sections for real
(full page count, bounded 24-image DOM, zero console errors, honest merge
cancellation) and the three optional suites run their full matrices. Without
it, canonical validation still passes and the optional parts SKIP with an
explicit message.

Historical note: during engine development Folio was validated against a
~514 MB / 2585-page file (bounded thumbnails, cancellation, large-document
processing). That result is preserved as benchmark evidence in `docs/WORKLOG.md`
and the root `ARCHITECTURE.md` log — it does not imply the file ships with the
repository.

## Benchmark workflow

Benchmark records from engine development live with the engine code where legitimate (`engine/src/observability/`, `engine/examples`). There is no separate benchmark harness command in this repo; performance claims are verified through E2E completion metadata (`engineDurationMs`, output sizes) and the large-file suite. Do not present ad-hoc timings as benchmarks.

## Debugging

- Engine logic: reproduce natively first (from `engine/`: `cargo test` with a focused filter, CLI examples in `engine/examples/` against the local corpus via `--dir ../test pdfs` when you have one) — native iteration is faster than the WASM loop.
- Browser behavior: dev server + browser console; the WASM glue installs `console_error_panic_hook`, so Rust panics surface as readable console messages instead of bare `unreachable`.
- Rendering/thumbnails: `app/src/rendering/devHook.ts` and `memory.ts` support inspection; unit tests in `rendering/*.test.ts` cover geometry, windows, and error mapping.

## Release workflow

1. Run the full verification suite above, **then** the fresh-clone verification: commit, push `dev`, clone `-b dev` to a temp directory, re-run the suite there (see `docs/LESSONS.md` L-8).
2. Update `docs/STATUS.md` baseline table, `docs/CHANGELOG.md`, `docs/WORKLOG.md`, and the About-page version entry if the release changes user-visible behavior.
3. Normal push to `dev` only. Never `--force`, never `main` from this workflow. `main` promotion is a separate explicit decision.
