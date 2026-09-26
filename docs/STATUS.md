# Folio — Status

> Current as of `dev` pre-v2.0 (`fef775b`, 2026-09-26 — scanner M1–M3+M3.x, perf P0–P2+P4, D16–D21; package.json still 1.8.0, v2.0.0 release HELD pending real-device validation).
> After any verification run, update the baseline table below — never leave stale numbers here.

## Current phase

**Pre-v2.0 (`dev`).** Scanner v2.0 M1–M3 plus M3.x mobile hardening, performance passes P0–P2+P4, PWA update manager (D16), JPEG DCT passthrough (D17), PNG→JPEG import + Rearrange-parity page list (D18), naming-first downloads (D21), and preview hardenings (F-18 portaled-modal F-19) are implemented on `dev` and deployed to the `dev` Cloudflare branch. No version bump: `package.json` remains 1.8.0 and the v2.0.0 release is HELD pending real-device Android validation (see the release checklist below).

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
- Scanner v2.0 M1–M3 on `dev` (see `docs/DECISIONS.md` D15): `folio-scan` core (detect → warp → enhance, Otsu + closing + area-ordered contours + spine-split merge), dedicated scan worker + versioned protocol (v2: `detectOnly` / `detected`), CameraCapture integration with live guidance-only detection (~160px frames, 500 ms ticks, corners never reused) and fallback auto-accept (no-boundary captures commit as photos with a transient note; processed/error reviews keep explicit panels). Scan-mode selector removed (M3.x) — one color capture experience (`CORE_MODE = 'original'`). Scanner surface portaled to `document.body` (full-bleed phones, centered panel desktop) with body scroll lock and View-pages CTA.
- M3.x mobile import hardening: memory-safe sequential import normalization (pixel budget, `MAX_IMPORT_LONG_EDGE = 2500`), PNG→JPEG at import (D18), Import moved into the scanner bar, Rearrange-parity page list (framer rows, ↑/↓, click-to-preview portaled modal).
- PWA update manager (D16, F-13): silent launch check, global one-tap `UpdateBanner`, About "App updates" card; stale-chunk deploy-skew recovery + precache retention (F-12).
- JPEG DCT passthrough in `images_to_pdf` (D17, F-14): baseline orientation-1 JPEGs embed byte-identical; holders of the old behavior see ~5× smaller outputs.
- Performance passes P0–P2+P4 done 2026-09-26 (D19, D20; see `docs/PERFORMANCE.md`): owned WASM inputs, page-map cache, in-place rotate, single-pass split/delete/reorder/inspect, progress coalescing, scan borrowed-view + detect-only live path, one-`getPage` thumbnails, single-decode imports, encode-worker offload, bounded-2 thumbnail encode, preview LRU (cap 8), engine bench CLI + dev-only perf attribution.
- Naming-first downloads, all tools (D21): `downloadNaming.ts` smart defaults + `DownloadCard`/`MultiDownloadCard` (Smart prefilled / Custom blank); auto-downloads removed.
- Preview hardening (F-18: eager load, one-shot blob-URL recovery, explicit "Preview unavailable" fallback, decode-checked E2E) and portaled viewport-anchored preview modal (F-19: escapes the `backdrop-filter` containing block, `dvh` caps).

## Current work

- **Real-device Android validation is PENDING and gates the v2.0.0 release**: the 30-photo crash scenario (10/20/30/50 imports, 30 captures, mixed, cancel, remove, build) must be re-tested on the affected phone before any release claim.
- M4 docs-prep pass in progress (this change): reconcile STATUS/ROADMAP/OPERATIONS/ARCHITECTURE to the `dev` state above; no code, no version bump.
- Design-gated perf remainders (see `docs/PERFORMANCE.md` + `docs/ROADMAP.md`): P0.2 main-thread slice removal and P3 worker-level Images parallelism, both awaiting P4 measurements; threaded WASM explicitly gated behind a future decision.

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
- Planned About-page items (**Sign & annotate** as "v1.2.0", **Batch & OCR** as "v2.0.0") are listed aspirations, not committed roadmap items. Note: the About tree's "v2.0.0" label predates the scanner v2.0 release and collides with its numbering — resolving the tree at release time is an explicit gate in the checklist below (no code change in this pass).

## Validated baseline (pre-v2.0, `dev` @ `fef775b`, 2026-09-26)

| Check                                                         | Result                                                                                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust tests (`cargo test` in `engine/`)                        | 357 passing (unit + integration suites, incl. passthrough/byte-identity, page-map cache, in-place rotate)                                                             |
| Scan core tests (`cargo test` in `scan/`)                     | 35 passing (geometry, detect, warp, enhance, pipeline; borrowed-view + detect-only + prefilter)                                                                       |
| Rust format (`cargo fmt --check`)                             | clean                                                                                                                                                                 |
| Rust lints (`cargo clippy --all-targets`)                     | clean                                                                                                                                                                 |
| WASM build (`npm run build:wasm` in `app/`)                   | passing (`wasm-pack`, `wasm/pkg/` reproduced)                                                                                                                         |
| Frontend typecheck (`npm run typecheck`)                      | passing                                                                                                                                                               |
| Frontend lint (`npm run lint`)                                | passing                                                                                                                                                               |
| Frontend format (`npm run format:check`)                      | passing                                                                                                                                                               |
| Frontend unit tests (`npm test`)                              | 272 passing (imageSharding 15, downloadNaming 10, import worker-fallback, thumbnail encode-concurrency, scan detect-only, single-getPage thumbnails, PNG→JPEG import) |
| Production build (`npm run build`, PWA SW with WASM precache) | passing, zero testbench strings in bundle                                                                                                                             |
| Canonical E2E (`node e2e/studio.e2e.mjs`, no corpus)          | 53/53 passing, 4 skipped (large-file sections need optional `test pdfs/merged.pdf`)                                                                                   |
| Optional large-file E2E (historical, needs local corpus)      | ~514 MB / 2585 pages: full count, bounded thumbnails (24 imgs), zero console errors, cancellation verified (v1.7.0–Phase 2 runs; not re-run without the corpus)       |

These values were established during the v1.7.0 integration verification (fresh-clone runs included), re-confirmed by the Phase 3 verification in `docs/DEVELOPMENT.md`, re-confirmed for v1.7.1 (F-7–F-10, UI-only), extended for v1.8.0 (Images → PDF page assembly: +16 frontend tests, +4 canonical E2E checks), and advanced through v2.0 M1–M3+M3.x, the P0–P2+P4 performance passes, and D16–D21 (see `docs/WORKLOG.md` for the per-pass records; latest: frontend 257, canonical E2E 52/52 + 4 SKIP). The 25/25 full-corpus result remains the benchmark for runs _with_ the optional corpus; the 25/25 + 4 SKIP result is the expected fresh-clone result _without_ it. If any number changes, update this table in the same commit.

## v2.0.0 release checklist (HELD — all gates PENDING)

The v2.0.0 version bump and release are HELD pending the user's real-device phone validation. Gates run in this exact order; none may be skipped or reordered.

1. **Real-device Android validation — PENDING.** Affected phone runs: 10/20/30/50 imported photos, 30 camera captures, mixed scan+import build, import-while-scanning, cancel halfway, remove imported pages, build. iOS Safari run pending. No release claim until this passes.
2. **Full suite green on the release commit — PENDING.** Rust `cargo test` + `fmt --check` + `clippy` (`engine/`, `scan/`), `build:wasm` + `build:scan`, frontend typecheck/lint/format/test, production build, canonical E2E — with `docs/STATUS.md` baselines updated in the same commit.
3. **CHANGELOG v2.0.0 entry — PENDING.** New entry per the file's per-released-version convention (verified against git history; never invent). Must cover: scanner M1–M3+M3.x, D16–D21, F-11–F-19 resolutions, P0–P2+P4.
4. **`package.json` bump to 2.0.0 — HELD.** Only after gates 1–3. The About `latest` entry follows automatically via `__FOLIO_VERSION__`.
5. **About tree check — PENDING.** The About version tree's planned "v2.0.0 · Batch & OCR" entry collides with the scanner v2.0.0 numbering (verified in `app/src/studio/About.tsx`, read-only in this pass). Resolve before shipping: retitle or re-scope the planned entry so STATUS/ROADMAP/README-surface claims agree.
6. **Deploy — PENDING.** Ship `app/dist/` to Cloudflare Pages `folio-pdf` branch `dev`; phones reload once to the current shell (update-manager banner is the live path).
7. **`main`-promotion decision — SEPARATE, unscheduled.** Promoting the Folio build to `main`/production hosting is an explicit decision, never a side effect of this release.

## Repository state

- GitHub: `https://github.com/SUMANTHXT900/folio` (renamed from `pdf-studio`; old URL redirects).
- Branch: `dev`. HEAD: `fef775b` (naming-first downloads docs, 2026-09-26). `package.json` 1.8.0 — v2.0.0 bump HELD (see release checklist above).
- Layout: `engine/` (Rust engine) + `wasm/` (bridge) + `app/` (frontend) + `docs/` (project memory); no Cargo workspace.
- Canonical local workspace: `D:\hobby_projects\ideating\folio`. The old `folio-engine` workspace is retired (deleted); nothing references it.
- `main` untouched (pre-engine release at `5d83b16`).
- Generated/ignored: `wasm/pkg/`, `engine/target/`, `app/dist/`, `app/node_modules/`, optional `test pdfs/` corpus, E2E artifacts — none committed.

## Immediate next steps

1. Decide `main`/production promotion separately — out of scope for this change; do NOT promote as a side effect.
