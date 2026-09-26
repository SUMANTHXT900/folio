# Folio — Changelog

Versions and dates below are verified against git history (`git log --format='%h %ad %s'`) and the About-page version tree. Where the About page and git disagree, both are noted honestly. The v1.2.x–v1.6.0 commits share one squash date (2026-08-23); that is how the history is recorded, not an error.

## v1.9.0 — Correctness, memory, and UX hardening (`dev`, 2026-09-27)

Waves 1–7 (`ad592f9`..`97dc8c2`): engine + app hardening on the pre-v2.0 `dev` line. Scanner v2.0 scope (M1–M3+M3.x, D16–D21, P0–P2+P4, F-11–F-19) stays reserved for the v2.0.0 entry; the v2.0.0 release itself remains HELD pending real-device validation (see `docs/STATUS.md` checklist). App-only version marker — the About-page version tree follows automatically via `__FOLIO_VERSION__`, no About edit needed.

- Correctness: rotate resolves effective rotation per planned page only (sparse selections skip untouched pages; ancestor-inherited `/Rotate` reads the nearest holder); extract is cancellable; loader caps inputs (100 MiB / 10 000 pages, empty input reclassified `InvalidInput`); MediaBox clamp, images-to-PDF DPI minimum, split context validation, folio-service fixes (wave 1). WASM glue sanitization cap, worker init-fatal path, condensed event trail, scan/encode IPC hardening, render fail-path canvas release (wave 2).
- Performance / memory: single-encode scan path with prescale + pixel gates; service-owned preview URLs (single-owner rule — cancelled jobs revoke already-minted URLs, encode lanes observe cancellation); staging progress surfaced in the folio service (wave 3).
- UI / UX / motion / copy: honest progress staging across tools, portaled modals, handle-drag page lists, memoized rows, update-banner guard, 44px touch gaps, DropZone single-tab-stop CTA (wave 4); motion hygiene — scoped transitions, stagger caps, modal enter/exit, drag lift, scanner fades (wave 5); mobile camera behavior — stream pause, HTTPS branch, landscape-compact layout, low-tier capture, constraint hardening (wave 6); copy truth-pass — About tool count corrected (seven → six), Compress levels say "Not available yet", Home taglines rewritten (wave 7). Compress stays reserved/disabled, consistent with the About Coming-soon wording.
- Tests / bench: engine audit benchmark-matrix example (`audit_bench_matrix`) plus audit coverage tests (cancel-midrun, images edge, metadata edge, parse caps); frontend coverage for folio-service ownership/cancel, page thumbs, image prepare/sharding/import, DownloadCard, scan processor, camera constraints/lifecycle (waves 1–3, 6–7).
- Verification: this entry records the wave 1–7 lead commits above (subjects + stats verified against git history); suite-wide re-verification numbers live in `docs/STATUS.md` and are unchanged by this metadata pass.

## v1.8.0 — Images → PDF page assembly (`dev`, 2026-09-23)

- Unified ordered page collection (`ImagePage[]`) for uploads + camera captures: preview grid, ←/→ move-button reorder (HTML5 drag as desktop-only enhancement), per-page remove, add-more after initial selection, per-page rotate (app-side canvas re-encode; unrotated pages byte-identical), camera input (`getUserMedia` → video → JPEG capture, per-error failure copy, stream stopped on Done/close/unmount).
- App-only: no changes to `folio.ts`, adapters, worker protocol, WASM glue, or the Rust engine (`pdf.images_to_pdf` contract unchanged — see `docs/DECISIONS.md` D14). About-page version tree needs no edit (dynamic via `__FOLIO_VERSION__`).
- Tests: 16 new frontend unit tests (`imagePages`, `imagePrepare`); E2E images section extended (preview order, move reorder, rotate badge, remove + add-more, build) with committed `red-wide.png`/`blue-tall.jpg` fixtures; camera covered by error-mapper review + manual checklist (no webcam in CI).
- Verification: full suite green — Rust 345, `fmt`/`clippy` clean, WASM build passing, typecheck/lint/format clean, 134 frontend tests, production build (PWA SW, 34 precache entries, zero testbench strings), canonical E2E 25/25 + 4 SKIP without the optional corpus.

## v1.7.1 — Mobile UI fixes F-7–F-10 (`dev`, 2026-09-23)

Commit `3057b95` (patch bump to `1.7.1` after the laptop-side full-suite re-verification).

- UI-only batch, engine untouched: mobile bottom nav is a single-row snap-scrolling strip with page bottom padding applied only where the nav renders (F-7, F-10); hero proof-line wraps below `sm` (F-8); Rearrange drag starts from a grip handle, rows keep `pan-y` scroll, arrow buttons enlarged (F-9).
- About-page version tree needs no edit: the `latest` entry reflects `package.json` via the Vite `__FOLIO_VERSION__` define.
- Verification: full suite green on the Rust-capable side — Rust 345 tests, `fmt`/`clippy` clean, WASM build passing, typecheck/lint/format clean, 118 frontend tests, production build (PWA SW, 34 precache entries, zero testbench strings), canonical E2E 21/21 + 4 SKIP without the optional corpus, optional suites exit 0 with explicit SKIP.

## v1.7.0 — Unified Folio repository (`dev`, 2026-09-22)

Commit `d76a22e` (+ `.gitattributes` `74943c4`, lock normalization `d9bb998`).

- The complete Folio Rust engine source (`src/`), WASM bridge (`wasm/`), Rust tests (`tests/`), and CLI examples (`examples/`) now live in this repository alongside the production Studio (`frontend/`). No separate engine directory required; fresh-clone build verified.
- PDF manipulation runs on Rust/WASM in a Web Worker (`lopdf` core); PDF.js retained for rendering, previews, thumbnails, and page-count intake. The `pdf-lib` processing path was fully removed.
- Real engine progress (stage + percentage), honest cancellation, structured errors with codes, and completion metadata (duration, page counts, output sizes) on every tool. Merge progress scale fixed; `imageCount` plumbing fixed; Rotate structured/cancellation errors preserved.
- New tools: Metadata properties (set / clear / leave-unchanged) and Images → PDF (JPEG/PNG, fit or A4).
- Compress reserved as disabled for a future update. Production UI preserved; Developer Testbench removed from the product (automated tests kept).
- Git history preserved as normal commits on top of v1.6.0 (an incorrect production-only integration `866761f` was reverted exactly via `390194a`, then replaced correctly — see `docs/DETOURS.md` T-5).

## v1.6.0 (2026-08-23)

Commit `ffa87c8` — known-good pre-integration baseline. Cancellable merge jobs with stage progress, large-selection memory notice, mobile-aware blur.

## v1.5.0 (2026-08-23)

Commit `45ebcb5`. PDF render Worker + main-thread fallback, blob-URL thumbnails, Show-All resume, scaleX progress.

## v1.4.0 (2026-08-23)

Commit `b9fb57d`. Windowed rendering, right-sized scale, PWA offline fix, object-URL revocation, dead code removal, theme polish (View Transitions easing, fallback wave, re-entrancy guard, theme-color sync), MotionConfig accessibility, route error boundary.

## v1.3.0 (2026-08-23)

Commit `a35b5f7`. Verified overhaul: load resolves after wave 1, detached background fill, Show-All resumes holes via shared session, Rearrange/Split blob ownership, symmetric theme wave with guard to animation end.

## v1.2.2 (2026-08-23)

Commit `456f43b`. 25x faster thumbnails (single document load), visible theme wave, decluttered READMEs.

## v1.2.1 (2026-08-23)

Commit `0dcbc55`. Mobile save-flow fix: no auto share-sheet, always-visible Save to device.

## v1.2.0 (2026-08-23)

Commit `a2554a6`. View Transitions theme wave, mobile downloads, progress UI, sharp previews.

## v1.1.0 (2026-08-17)

Commit `f4d8f17` ("Folio v1.1.0 — client-side PDF tools (merge/split/rearrange/rotate/compress)"). About page labels it `2026 · 08`. Bento home redesign, editorial proof line, privacy-proof About, CTA dropzones (commit `0e52866`); theme wave, mouse-follow shine, lazy tools, cached thumbnails, fast grids (`887927e`); mobile bottom nav, 2-column mobile grid, glass header (`b5a8132`, `aff1f2e`).

## v1.0.0 (2026-01 per About page; earliest git history 2026-08-16)

First public release — five local PDF tools (Merge, Split, Rearrange, Rotate, Compress), 100% in-browser, offline-ready PWA scaffold, editorial design system (paper / ink / brass / forest, Fraunces + Inter). Note: the About page dates this `2026 · 01`, but the repository's earliest commit is 2026-08-16; early history predates the git import and cannot be verified here beyond the About record.

## Planned (not released)

- **Sign & annotate** (About page "v1.2.0") and **Batch & OCR** (About page "v2.0.0"): listed aspirations, not committed releases. See `docs/ROADMAP.md`.
