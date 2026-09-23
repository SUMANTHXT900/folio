# Folio — Changelog

Versions and dates below are verified against git history (`git log --format='%h %ad %s'`) and the About-page version tree. Where the About page and git disagree, both are noted honestly. The v1.2.x–v1.6.0 commits share one squash date (2026-08-23); that is how the history is recorded, not an error.

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
