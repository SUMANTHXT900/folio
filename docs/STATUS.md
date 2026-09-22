# Folio — Status

> Current as of Phase 1 (repository rename `pdf-studio` → `folio` + project-memory foundation).
> After any verification run, update the baseline table below — never leave stale numbers here.

## Current phase

**Phase 1 — repository identity and project memory.** The unified Folio repository (engine + app, v1.7.0 on `dev`) is functionally complete and verified; this phase renames the GitHub repository, corrects product identity, and establishes the persistent documentation system (`AGENTS.md` + `docs/`). No source restructuring, no behavior changes.

## Completed work

- Complete Folio Rust engine: `ExecutionEngine`, operation model, timing, progress, structured errors, cancellation, scheduler abstraction (`src/`, 39 files).
- Ten PDF operations implemented and tested: inspect, extract, split, reorder, delete, rotate, merge, images-to-PDF, metadata read, metadata write.
- WASM bridge (`wasm/`, thin glue over the same engine core) with reproducible `wasm-pack` build.
- Production Studio UI on the engine: Merge, Split, Rearrange, Rotate, Metadata, Images → PDF tools with real progress, honest cancellation, structured errors, completion metadata (duration, page counts, output sizes).
- PDF.js retained as rendering-only layer (previews, thumbnails, page-count intake); `pdf-lib` manipulation path fully removed.
- Unified single repository on `dev` (v1.7.0): engine source, WASM bridge, Rust tests, examples, frontend, E2E — verified buildable from a fresh clone.
- Developer Testbench removed from the product (no route, no bundle, no entrypoint); legitimate automated tests preserved.
- Large-file verification: ~514 MB / 2585-page document loads fully with bounded thumbnails and zero console errors.

## Current work

- Phase 1 tasks: GitHub rename (done), local remote update (done), identity correction (done), `AGENTS.md` + `docs/` creation (this change), full verification re-run, commit + push to `dev`.

## Pending work

- **Phase 2** — filesystem restructuring (`src/` → `engine/`, `frontend/` → `app/`, etc.). Explicitly not started; see `docs/ROADMAP.md`. Do not begin it in Phase 1.
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
| Rust tests (`cargo test`) | 345 passing (228 unit + integration suites) |
| Rust format (`cargo fmt --check`) | clean |
| Rust lints (`cargo clippy --all-targets`) | clean |
| WASM build (`npm run build:wasm` in `frontend/`) | passing (`wasm-pack`, `wasm/pkg/` reproduced) |
| Frontend typecheck (`npm run typecheck`) | passing |
| Frontend lint (`npm run lint`) | passing |
| Frontend format (`npm run format:check`) | passing |
| Frontend unit tests (`npm test`) | 118 passing |
| Production build (`npm run build`, PWA SW with WASM precache) | passing, zero testbench strings in bundle |
| Production E2E (`node e2e/studio.e2e.mjs`) | 25/25 passing |
| Large file (~514 MB / 2585 pages) | full count, bounded thumbnails (24 imgs), zero console errors, cancellation verified |

These values were established during the v1.7.0 integration verification (fresh-clone runs included) and must be re-confirmed by the Phase 1 verification step in `docs/DEVELOPMENT.md`. If any number changes, update this table in the same commit.

## Repository state

- GitHub: `https://github.com/SUMANTHXT900/folio` (renamed from `pdf-studio`; old URL redirects).
- Branch: `dev`. HEAD: Phase 1 commit (this change) on top of `d9bb998`.
- `main` untouched (pre-engine release at `5d83b16`).
- Generated/ignored: `wasm/pkg/`, `target/`, `frontend/dist/`, `frontend/node_modules/`, `test pdfs/` corpus, E2E artifacts — none committed.

## Immediate next steps

1. Finish Phase 1: run full verification, commit (`chore: establish Folio project identity and documentation`), push `dev` normally, report.
2. Schedule Phase 2 (filesystem restructure) as a separate task with its own verification.
3. Decide `main`/production promotion separately — out of scope for Phase 1.
