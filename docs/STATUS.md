# Folio — Status

> Current as of Phase 3 (testing policy: canonical validation without the external corpus; large files reclassified as optional benchmark inputs).
> After any verification run, update the baseline table below — never leave stale numbers here.

## Current phase

**Phase 3 — corpus-independent canonical validation (this change).** Large external PDFs are classified as optional developer-owned benchmark/stress-test inputs, not canonical repository fixtures (see `docs/DECISIONS.md` D13). The canonical E2E suite (`app/e2e/studio.e2e.mjs`) passes from a fresh clone with no private corpus (deterministic synthetic small fixtures when needed; large-file sections SKIP explicitly). The retired `folio-engine` workspace is gone; `D:\hobby_projects\ideating\folio` is the canonical local workspace.

## Completed work

- Complete Folio Rust engine: `ExecutionEngine`, operation model, timing, progress, structured errors, cancellation, scheduler abstraction (`engine/src/`, 39 files).
- Ten PDF operations implemented and tested: inspect, extract, split, reorder, delete, rotate, merge, images-to-PDF, metadata read, metadata write.
- WASM bridge (`wasm/`, thin glue over the same engine core) with reproducible `wasm-pack` build.
- Production Studio UI on the engine: Merge, Split, Rearrange, Rotate, Metadata, Images → PDF tools with real progress, honest cancellation, structured errors, completion metadata (duration, page counts, output sizes).
- PDF.js retained as rendering-only layer (previews, thumbnails, page-count intake); `pdf-lib` manipulation path fully removed.
- Unified single repository on `dev` (v1.7.0): engine source, WASM bridge, Rust tests, examples, frontend, E2E — verified buildable from a fresh clone.
- Repository identity established (Phase 1): renamed to `folio`, product identity corrected, persistent documentation system (`AGENTS.md` + `docs/`) in place.
- Project-oriented filesystem layout (Phase 2, this change): `engine/` + `wasm/` + `app/` + `docs/` ownership boundaries; no behavior changes.
- Developer Testbench removed from the product (no route, no bundle, no entrypoint); legitimate automated tests preserved.
- Large-file verification (historical benchmark evidence, engine development): ~514 MB / 2585-page document loads fully with bounded thumbnails and zero console errors. The file is not part of the repository; re-validation requires the optional local corpus.

## Current work

- Phase 3 tasks: E2E corpus-optional rework (done), docs reclassification (done), full verification re-run, commit + push to `dev`.
- Mobile UI fixes F-7–F-10 (bottom nav strip, proof-line wrap, rearrange handle): implemented + pushed to `dev` with frontend-only verification (VPS has no Rust/Chrome); full suite re-run pending on the Rust-capable side — see the 2026-09-23 `docs/WORKLOG.md` handoff entry.

## Pending work

- `main` branch still carries the pre-engine production release; promoting the Folio build to `main`/production hosting is a separate, unscheduled decision.

## Blocked work

None. No blocked items.

## Known limitations

- **Compress is disabled** in the Studio UI — reserved for a future update. The button exists but the action stays disabled rather than pretending to work.
- **Password-protected PDFs are unsupported** (`UNSUPPORTED_FORMAT`): the engine reports them cleanly instead of failing obscurely.
- **Metadata `set` with `""` is rejected** — use `Clear`. Read preserves `Some("")` distinctly from absent.
- **`pdf.inspect` does no text extraction, rendering, or image extraction** — structural inspection only (page count, version, encryption, metadata, optional per-page geometry).
- **`pdf.images_to_pdf` accepts JPEG/PNG only**; anything else fails as `UNSUPPORTED_FORMAT`.
- Planned About-page items (**Sign & annotate** as "v1.2.0", **Batch & OCR** as "v2.0.0") are listed aspirations, not committed roadmap items.

## Validated baseline (v1.7.0, `dev`)

| Check | Result |
|---|---|
| Rust tests (`cargo test` in `engine/`) | 345 passing (228 unit + integration suites) |
| Rust format (`cargo fmt --check`) | clean |
| Rust lints (`cargo clippy --all-targets`) | clean |
| WASM build (`npm run build:wasm` in `app/`) | passing (`wasm-pack`, `wasm/pkg/` reproduced) |
| Frontend typecheck (`npm run typecheck`) | passing |
| Frontend lint (`npm run lint`) | passing |
| Frontend format (`npm run format:check`) | passing |
| Frontend unit tests (`npm test`) | 118 passing |
| Production build (`npm run build`, PWA SW with WASM precache) | passing, zero testbench strings in bundle |
| Canonical E2E (`node e2e/studio.e2e.mjs`, no corpus) | 21/21 passing, 4 skipped (large-file sections need optional `test pdfs/merged.pdf`) |
| Optional large-file E2E (historical, needs local corpus) | ~514 MB / 2585 pages: full count, bounded thumbnails (24 imgs), zero console errors, cancellation verified (v1.7.0–Phase 2 runs; not re-run without the corpus) |

These values were established during the v1.7.0 integration verification (fresh-clone runs included) and re-confirmed by the Phase 3 verification in `docs/DEVELOPMENT.md`. The 25/25 full-corpus result remains the benchmark for runs *with* the optional corpus; the 21/21 + 4 SKIP result is the expected fresh-clone result *without* it. If any number changes, update this table in the same commit.

## Repository state

- GitHub: `https://github.com/SUMANTHXT900/folio` (renamed from `pdf-studio`; old URL redirects).
- Branch: `dev`. HEAD: Phase 3 commit (this change) on top of `51c3c08`.
- Layout: `engine/` (Rust engine) + `wasm/` (bridge) + `app/` (frontend) + `docs/` (project memory); no Cargo workspace.
- Canonical local workspace: `D:\hobby_projects\ideating\folio`. The old `folio-engine` workspace is retired (deleted); nothing references it.
- `main` untouched (pre-engine release at `5d83b16`).
- Generated/ignored: `wasm/pkg/`, `engine/target/`, `app/dist/`, `app/node_modules/`, optional `test pdfs/` corpus, E2E artifacts — none committed.

## Immediate next steps

1. Finish Phase 3: run full verification from this structure (canonical suite must pass with no corpus), commit, push `dev` normally, report.
2. Decide `main`/production promotion separately — out of scope for Phase 3.
