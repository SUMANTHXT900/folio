# Folio — Status

> Current as of v1.8.0 (Images → PDF page assembly: preview grid, reorder, camera capture; engine untouched).
> After any verification run, update the baseline table below — never leave stale numbers here.

## Current phase

**v1.8.0 — Images → PDF 2.0 (this change).** Page-assembly workflow over a unified ordered page collection (uploads + camera captures): preview grid, ←/→ move reorder (HTML5 drag as desktop-only enhancement), remove, add-more, per-page rotate (app-side canvas, engine frozen), camera input with graceful failure handling. Full suite green (see `docs/WORKLOG.md`).

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
- v1.7.1 patch (F-7–F-10 mobile UI fixes, UI-only, engine untouched) verified with baselines unchanged; About version tree follows `package.json` automatically.
- v1.8.0 feature (Images → PDF page assembly, app-only, engine untouched): unified page collection, preview grid, move-button reorder, camera capture, app-side rotation; baselines updated.
- Large-file verification (historical benchmark evidence, engine development): ~514 MB / 2585-page document loads fully with bounded thumbnails and zero console errors. The file is not part of the repository; re-validation requires the optional local corpus.

## Current work

- Hardening milestone done (P0–P6, see WORKLOG): incremental Rust embed, staged-transfer ownership, single-Blob download, negotiated camera constraints. No version bump.
- M3.x mobile import + scanner harden done (see WORKLOG 2026-09-25): memory-safe sequential import normalization (pixel budget, `MAX_IMPORT_LONG_EDGE = 2500`), immersive portaled scanner surface (fixed full-bleed on phones, centered panel on desktop), Import moved into the scanner bar, scan-mode selector removed. New import/UI tests; canonical E2E **42/42 + 4 SKIP**.
- **Real-device Android validation is PENDING**: the 30-photo crash scenario must be re-tested on the affected phone before v2.0 release validation.

## Pending work

- `main` branch still carries the pre-engine production release; promoting the Folio build to `main`/production hosting is a separate, unscheduled decision.

## Blocked work

None. No blocked items.

## Known limitations

- **Compress is disabled** in the Studio UI — reserved for a future update. The button exists but the action stays disabled rather than pretending to work.
- **Scanner zoom control removed** — the track-reported zoom range is not a focal-length multiplier (devices showed "1×" while actually using the ultrawide lens), so the control was removed rather than lie; revisit with focal-accurate handling (`docs/BUGS.md` F-11, `docs/ROADMAP.md`).
- **Password-protected PDFs are unsupported** (`UNSUPPORTED_FORMAT`): the engine reports them cleanly instead of failing obscurely.
- **Metadata `set` with `""` is rejected** — use `Clear`. Read preserves `Some("")` distinctly from absent.
- **`pdf.inspect` does no text extraction, rendering, or image extraction** — structural inspection only (page count, version, encryption, metadata, optional per-page geometry).
- **`pdf.images_to_pdf` accepts JPEG/PNG only**; anything else fails as `UNSUPPORTED_FORMAT`.
- Planned About-page items (**Sign & annotate** as "v1.2.0", **Batch & OCR** as "v2.0.0") are listed aspirations, not committed roadmap items.

## Validated baseline (v1.8.0, `dev`)

| Check                                                         | Result                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust tests (`cargo test` in `engine/`)                        | 354 passing (unit + integration suites, incl. passthrough/byte-identity tests)                                                                                  |
| Scan core tests (`cargo test` in `scan/`)                     | 26 passing (geometry, detect, warp, enhance, pipeline)                                                                                                          |
| Rust format (`cargo fmt --check`)                             | clean                                                                                                                                                           |
| Rust lints (`cargo clippy --all-targets`)                     | clean                                                                                                                                                           |
| WASM build (`npm run build:wasm` in `app/`)                   | passing (`wasm-pack`, `wasm/pkg/` reproduced)                                                                                                                   |
| Frontend typecheck (`npm run typecheck`)                      | passing                                                                                                                                                         |
| Frontend lint (`npm run lint`)                                | passing                                                                                                                                                         |
| Frontend format (`npm run format:check`)                      | passing                                                                                                                                                         |
| Frontend unit tests (`npm test`)                              | 228 passing (import normalization + bulk import + scanner surface + stale-chunk recovery + PWA update manager)                                                  |
| Production build (`npm run build`, PWA SW with WASM precache) | passing, zero testbench strings in bundle                                                                                                                       |
| Canonical E2E (`node e2e/studio.e2e.mjs`, no corpus)          | 44/44 passing, 4 skipped (large-file sections need optional `test pdfs/merged.pdf`)                                                                             |
| Optional large-file E2E (historical, needs local corpus)      | ~514 MB / 2585 pages: full count, bounded thumbnails (24 imgs), zero console errors, cancellation verified (v1.7.0–Phase 2 runs; not re-run without the corpus) |

These values were established during the v1.7.0 integration verification (fresh-clone runs included), re-confirmed by the Phase 3 verification in `docs/DEVELOPMENT.md`, re-confirmed for v1.7.1 (F-7–F-10, UI-only), and updated for v1.8.0 (Images → PDF page assembly: +16 frontend tests, +4 canonical E2E checks). The 25/25 full-corpus result remains the benchmark for runs _with_ the optional corpus; the 25/25 + 4 SKIP result is the expected fresh-clone result _without_ it. If any number changes, update this table in the same commit.

## Repository state

- GitHub: `https://github.com/SUMANTHXT900/folio` (renamed from `pdf-studio`; old URL redirects).
- Branch: `dev`. HEAD: v1.8.0 (Images → PDF page assembly on top of `3dfb838`).
- Layout: `engine/` (Rust engine) + `wasm/` (bridge) + `app/` (frontend) + `docs/` (project memory); no Cargo workspace.
- Canonical local workspace: `D:\hobby_projects\ideating\folio`. The old `folio-engine` workspace is retired (deleted); nothing references it.
- `main` untouched (pre-engine release at `5d83b16`).
- Generated/ignored: `wasm/pkg/`, `engine/target/`, `app/dist/`, `app/node_modules/`, optional `test pdfs/` corpus, E2E artifacts — none committed.

## Immediate next steps

1. Decide `main`/production promotion separately — out of scope for this change; do NOT promote as a side effect.
