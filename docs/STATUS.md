# Folio — Status

> Current as of the D35 scanner-UX-redo wave (2026-10-04 — scanic + self-hosted ML-default; package.json stays 1.9.0, v2.0.0 release HELD).
> After any verification run, update the baseline table below — never leave stale numbers here.

## Current phase

**Pre-v2.0 (`dev`).** Scanner UX redo wave (D35, 2026-10-04, user-verified field feedback on D34): document scanning is rebuilt on `scanic@1.6.0` (classical detection + full-res bilinear warp + corner editor; MIT © marquaye, attribution kept) with `scanic-ml@0.2.0` self-hosted (dist vendored same-origin under `/assets/scanic-ml/`, precached at install, ORT 1.27.x ABI); ML detector DEFAULT (classical silent fallback) — `[data-ml-detector]` opt-in toggle DELETED, `DEFAULT_DETECTOR='ml'` + model preload at scanner open; full-screen portaled scanner takeover with body scroll-lock; viewfinder quality (high-res constraints, object-cover full-bleed) + mirror toggle (front preview mirrored by default, captures always unmirrored); review hero is the detection overlay (photo + ML-found quad, reactive to Apply/Re-detect) + Re-detect button; previews reactive (warped img keyed by warpedUrl); research basis Scanbot SDK custom-UI patterns + Dropbox detection pipeline notes (TinyFish fetch 2026-10-04); precache cap 8MB → 10MB with the 9MB alarm rule; zero-re-encode quality (original File bytes never resized/recompressed, detection on in-memory copies, warp output full-res PNG, originals commit as original bytes; D17 DCT passthrough retained); ML 1-thread default (no COOP/COEP); the upload-only interim ends with this wave; fresh E2E per L-11/L-12. The D33 strip deleted the custom scanner (v2.0 M1–M3 plus M3.x hardening, D29–D32 recall rounds) — history preserved in `docs/DECISIONS.md` D33 and `docs/BUGS.md` F-21. Retained on `dev`: performance passes P0–P2+P4 (P0.2 measured-and-shelved), PWA update manager (D16), JPEG DCT passthrough (D17), PNG→JPEG import + Rearrange-parity page list (D18), naming-first downloads (D21), P3 image-build sharding (D22), usage-based Home ordering (D23), preview hardenings (F-18, portaled-modal F-19, Split opener F-20), and audit-hardening waves 1–7 (rotation nearest-wins, loader caps, glue sanitize, init-fatal, preview single-ownership, cancel-during-encode, benchmark matrix). Wave-A app finish (`e74e71b`: studioThumb removal, merge-readiness honesty, local-phase copy, About 44px targets, disabled-card focus, nav affordance, K4 from_bytes alignment) and the portal-AnimatePresence regression fix (`3ccabeb`, E2E-caught pre-ship) are implemented on `dev`. No v2.0.0 version bump: `package.json` is 1.9.0 (waves 1–7 metadata marker per `docs/CHANGELOG.md`) and the v2.0.0 release is HELD (see the release checklist below). F-21 is superseded by D33 for the deleted pipeline; the field gate re-arms on scanic in D34 (see `docs/BUGS.md` F-21).

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
- Scanner v2.0 M1–M3 on `dev` (see `docs/DECISIONS.md` D15): SUPERSEDED by D33 (deleted 2026-10-04; history preserved) — was: `folio-scan` core (detect → warp → enhance, Otsu + closing + area-ordered contours + spine-split merge), dedicated scan worker + versioned protocol (v2: `detectOnly` / `detected`), CameraCapture integration with live guidance-only detection (~160px frames, 500 ms ticks, corners never reused) and fallback auto-accept (no-boundary captures commit as photos with a transient note; processed/error reviews keep explicit panels). Scan-mode selector removed (M3.x) — one color capture experience (`CORE_MODE = 'original'`). Scanner surface portaled to `document.body` (full-bleed phones, centered panel desktop) with body scroll lock and View-pages CTA.
- M3.x mobile import hardening: SUPERSEDED by D33 in its scanner parts (deleted; history preserved) — was: memory-safe sequential import normalization (pixel budget, `MAX_IMPORT_LONG_EDGE = 2500`), PNG→JPEG at import (D18), Import moved into the scanner bar, Rearrange-parity page list (framer rows, ↑/↓, click-to-preview portaled modal). The Images gallery/build/naming flow itself is untouched by the strip.
- Scanner pivot strip (D33, 2026-10-04): custom `folio-scan` crate, scan worker/protocol/WASM glue, `CameraCapture`, `app/src/studio/tools/scan/*`, `cameraCapabilities`, their tests, and scanner E2E sections deleted; Images tool is upload-only in the intermediate state; scanic integration (classical first, self-hosted ML opt-in precached, quality policy) planned as the next wave.
- PWA update manager (D16, F-13): silent launch check, global one-tap `UpdateBanner`, About "App updates" card; stale-chunk deploy-skew recovery + precache retention (F-12).
- JPEG DCT passthrough in `images_to_pdf` (D17, F-14): baseline orientation-1 JPEGs embed byte-identical; holders of the old behavior see ~5× smaller outputs.
- Performance passes P0–P2+P4 done 2026-09-26 (D19, D20; see `docs/PERFORMANCE.md`): owned WASM inputs, page-map cache, in-place rotate, single-pass split/delete/reorder/inspect, progress coalescing, scan borrowed-view + detect-only live path, one-`getPage` thumbnails, single-decode imports, encode-worker offload, bounded-2 thumbnail encode, preview LRU (cap 8), engine bench CLI + dev-only perf attribution.
- Naming-first downloads, all tools (D21): `downloadNaming.ts` smart defaults + `DownloadCard`/`MultiDownloadCard` (Smart prefilled / Custom blank); auto-downloads removed.
- P3 worker-level Images parallelism (D22): ≥8-page batches shard across K device-aware engine jobs with ordered merge; below 8 pages the historical single call runs byte-for-byte; sharded duration reports max-shard + merge wall.
- Usage-based Home ordering + copy truth-pass + update honesty (D23): hero follows local usage counts; About versioned entries replaced by one unversioned Coming-soon card; banner navigates to About with literal log copy.
- Preview hardening (F-18: eager load, one-shot blob-URL recovery, explicit "Preview unavailable" fallback, decode-checked E2E), portaled viewport-anchored preview modal (F-19: escapes the `backdrop-filter` containing block, `dvh` caps), and Split preview opener + portaled overlay (F-20: thumbnail click previews, label pill keeps the toggle).
- P0.2 measured-and-shelved (2026-09-27 real-device evidence, see `docs/WORKLOG.md` + `docs/PERFORMANCE.md`): phone 55 MB merge staging 79 ms cold / 28 ms warm vs ~40 ms engine — no implementation.
- Audit-hardening waves 1–7 (2026-09-27, commits `ad592f9`–`97dc8c2`): rotation nearest-wins (K1), extract pre-final cancel (K2), page-dimension clamp + DPI min (K7b), permissive PDF pre-gate (K10), last-mile filename sanitize (K13), glue sanitize cap, engine-worker init-fatal, preview single-ownership, cancel-during-encode, benchmark matrix + cancel-midrun/edge audit tests (see `docs/BUGS.md` K-series).
- Wave-A app finish (2026-09-27, commit `e74e71b`): dead `studioThumb` single-thumb helper removed from `folio.ts` (windows use bounded `encodeThumbCanvases`, pinned by a dead-path test); Merge readiness copy honest for single files ("1 file selected — add one more PDF to merge"); update-manager local phase copy ("Preview build — update checks run on the deployed site."); About update buttons meet 44px touch targets; disabled Compress card focusable with `aria-describedby`; mobile nav gains edge-fade scroll affordance; `Document::from_bytes` empty input aligned to `InvalidInput` (K4, see `docs/DECISIONS.md` D28).
- Portal-AnimatePresence regression fix (2026-09-27, commit `3ccabeb`, pre-ship): wave 5 had wrapped the three portaled preview viewers (PageGrid, RearrangeTool, SplitTool) in `AnimatePresence`, which swallows direct `createPortal()` children so no dialog mounted (6 E2E FAILs, zero console errors); root cause verified by live unwrap, `AnimatePresence` removed from portaled viewers (plain `motion` enter kept, instant close).
- Scanner crop-verify + capture-first queue + background processing (D29–D31, commits `88747bd`/`5d4f213`/`c3e4da2`, Cloudflare `dev` deploys recorded in `docs/WORKLOG.md`): SUPERSEDED by D33 (deleted; history preserved) — was: per-capture inline verify → shoot-first review queue (every capture croppable incl. fallback) → result-first review with one-tap Build PDF; 95/95 JPEG policy; `DETECT_LONG_EDGE` 800 → 1200; E2E predicate-total rule (LESSONS L-11).
- Miss-proof wave (D32, commit `52b8fa2`, 2026-10-04): SUPERSEDED by D33 (deleted; history preserved) — was: motion-gated auto-capture default ON (SAD ≤ 2 × 3 ticks, 1.5 s cooldown, SAD-0 counts as stable), 3600px capture/output caps (preview 1600px/q0.9), 8-handle crop editor (corners + whole-edge midpoints), detect recall round 3 (auto Canny + tiered denoised-gray rung; composite previous-MISS `real-world-stack` FOUND conf 0.942 err 2.2px); E2E drag-measure rewritten async-aware (LESSONS L-12).

## Current work

- **D35 scanner-UX-redo wave is implemented + verified**: ML-default scanner takeover + viewfinder + review-hero redo (see D35 in `docs/DECISIONS.md`); canonical suite 56/56 + 4 SKIP on the integration commit — see WORKLOG.
- **Real-device validation is next (not started)**: hit-rate + ML annoyance + handle feel on the user's phone; gates any camera-capture claim.
- Performance program closed: P0–P4 implemented, P0.2 measured-and-shelved with real-device evidence (see `docs/PERFORMANCE.md`); threaded WASM explicitly gated behind a future decision.

## Pending work

- `main` now carries the Folio v1.9.0 build (fast-forwarded from `dev` 2026-09-27) and serves production at `https://folio-pdf.pages.dev`; `dev` continues as the staging line.

## Blocked work

None. No blocked items.

## Known limitations

- **Compress is disabled** in the Studio UI — reserved for a future update. The button exists but the action stays disabled rather than pretending to work.
- **Scanner zoom control removed** — the track-reported zoom range is not a focal-length multiplier (devices showed "1×" while actually using the ultrawide lens), so the control was removed rather than lie; revisit with focal-accurate handling (`docs/BUGS.md` F-11, `docs/ROADMAP.md`).
- **Password-protected PDFs are unsupported** (`UNSUPPORTED_FORMAT`): the engine reports them cleanly instead of failing obscurely.
- **Metadata `set` with `""` is rejected** — use `Clear`. Read preserves `Some("")` distinctly from absent.
- **`pdf.inspect` does no text extraction, rendering, or image extraction** — structural inspection only (page count, version, encryption, metadata, optional per-page geometry).
- **`pdf.images_to_pdf` accepts JPEG/PNG only**; anything else fails as `UNSUPPORTED_FORMAT`.
- About-page future items live in one unversioned **Coming soon** card (Compress, sharing/annotation ideas — aspirations, never promises; verified in `app/src/studio/About.tsx`). The versioned _planned_ entries ("v1.2.0 · Sign & annotate", "v2.0.0 · Batch & OCR") were removed 2026-09-27; the tree itself retains real history, closing the numbering collision with scanner v2.0 (checklist gate 5).

## Validated baseline (D35 UX-redo wave, `dev` @ integration commit, 2026-10-04 — lead-verified; checklist gate 2 still runs on the release commit)

| Check                                                         | Result                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Rust tests (`cargo test` in `engine/`)                        | 382 passing (unchanged; engine untouched by the pivot)                          |
| Scan core tests (`cargo test` in `scan/`)                     | REMOVED (D33 strip; scanic core is TS + vitest, not cargo)                      |
| Rust format (`cargo fmt --check`)                             | clean                                                                           |
| Rust lints (`cargo clippy --all-targets`)                     | clean                                                                           |
| WASM build (`npm run build:wasm` in `app/`)                   | passing (`wasm-pack`, `wasm/pkg/` reproduced)                                   |
| Frontend typecheck (`npm run typecheck`)                      | passing                                                                         |
| Frontend lint (`npm run lint`)                                | passing                                                                         |
| Frontend format (`npm run format:check`)                      | passing (vendored scanic-ml excluded via `.prettierignore`)                     |
| Frontend unit tests (`npm test`)                              | 373 passing across 35 test files                                                |
| Production build (`npm run build`, PWA SW with WASM precache) | passing; precache 43 entries / 7732.53 KiB (7.55MB, under 9MB alarm + 10MB cap) |
| Canonical E2E (`node e2e/studio.e2e.mjs`, no corpus)          | 56/56 passing, 4 skipped (slowest check 1.4s; L-16/L-18)                        |
| Optional large-file E2E (historical, needs local corpus)      | ~514 MB / 2585 pages historical (not re-run without corpus)                     |

These values were established during the v1.7.0 integration verification (fresh-clone runs included), re-confirmed by the Phase 3 verification in `docs/DEVELOPMENT.md`, re-confirmed for v1.7.1 (F-7–F-10, UI-only), extended for v1.8.0 (Images → PDF page assembly: +16 frontend tests, +4 canonical E2E checks), and advanced through v2.0 M1–M3+M3.x, the P0–P2+P4 performance passes, D16–D23, F-11–F-20, audit waves 1–7, wave-A, the portal-AnimatePresence regression fix, crop-verify D29, the capture-first review-queue wave, background processing D31, E2E trimming (69→59), the D32 miss-proof wave, the D33 strip (engine 382, frontend 302/27, E2E 32/32 + 4 SKIP, precache 38/4174 KiB), and the D34 scanic integration (see `docs/WORKLOG.md` for the per-pass records; D34 verified: engine 382, frontend 341 across 32 files, canonical E2E 48/48 + 4 SKIP, precache 43 entries / 7744.62 KiB). The 25/25 full-corpus result remains the benchmark for runs _with_ the optional corpus; the 25/25 + 4 SKIP result is the expected fresh-clone result _without_ it. If any number changes, update this table in the same commit.

## v2.0.0 release checklist (HELD — gate 5 DONE, all others PENDING)

The v2.0.0 version bump and release are HELD pending the user's real-device phone validation. Gates run in this exact order; none may be skipped or reordered.

1. **Real-device Android validation — SUPERSEDED by D33 for the scanner half, re-scoped by D34.** The 30-photo crash scenario's camera-capture steps no longer apply to the deleted custom pipeline; any remaining import/build validation is re-scoped by the D34 scanic integration (landed; field validation pending real-device evidence). No release claim until that validation passes.
2. **Full suite green on the release commit — PENDING.** Rust `cargo test` + `fmt --check` + `clippy` (`engine/`), `build:wasm`, frontend typecheck/lint/format/test, production build, canonical E2E — with `docs/STATUS.md` baselines updated in the same commit.
3. **CHANGELOG v2.0.0 entry — PENDING.** New entry per the file's per-released-version convention (verified against git history; never invent). Must cover: scanner M1–M3+M3.x, D16–D23, F-11–F-20 resolutions, P0–P2+P4 (P0.2 shelved), audit waves 1–7.
4. **`package.json` bump to 2.0.0 — HELD.** Only after gates 1–3. The About `latest` entry follows automatically via `__FOLIO_VERSION__`.
5. **About tree check — DONE 2026-09-27.** The versioned _planned_ entries are gone: About keeps its real-history tree plus one unversioned Coming-soon card ("Ideas under consideration" + Suggest-a-feature link, verified in `app/src/studio/About.tsx`), so the scanner-v2.0 numbering collision no longer exists.
6. **Deploy — PENDING.** Ship `app/dist/` to Cloudflare Pages `folio-pdf` branch `dev`; phones reload once to the current shell (update-manager banner is the live path).
7. **`main` promotion — DONE 2026-09-27** (fast-forward `dev` → `main`, pushed; production deploy verified serving the new build).

## Repository state

- GitHub: `https://github.com/SUMANTHXT900/folio` (renamed from `pdf-studio`; old URL redirects).
- Branch: `dev`. HEAD: `3075179` (D35 scanner UX redo + ML-default, 2026-10-04). `package.json` 1.9.0 — v2.0.0 bump HELD (see release checklist above).
- Layout: `engine/` (Rust engine) + `wasm/` (bridge) + `app/` (frontend) + `docs/` (project memory); no Cargo workspace. The `scan/` crate is deleted (D33).
- Canonical local workspace: `D:\hobby_projects\ideating\folio`. The old `folio-engine` workspace is retired (deleted); nothing references it.
- `main` at v1.9.0 (promoted 2026-09-27, fast-forward from `dev`).
- Generated/ignored: `wasm/pkg/`, `engine/target/`, `app/dist/`, `app/node_modules/`, optional `test pdfs/` corpus, E2E artifacts — none committed.

## Immediate next steps

1. Real-device validation of the D35 scanner redo (hit-rate + ML annoyance + handle feel; user's phone required) — not started, gates any camera-capture claim.
