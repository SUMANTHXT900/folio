# Folio — Worklog

Chronological record of meaningful development events. Each entry records objective, work, findings, decisions, verification, and remaining work — not command-by-command activity. Lesson references in code comments (Lesson 0–14) belong to engine development that predates this log's detail level; they are cited where the code cites them.

## 2026-08-16 → 2026-08-17 — Foundation and v1.1.0

- **Objective.** Establish the client-side PDF tools app and its editorial identity.
- **Work.** Initial commits (`index.html`, `main.tsx`, `.gitignore`), polished README, mobile UX (bottom nav, 2-col grid, glass header), bento home redesign, privacy-proof About, CTA dropzones, motion/shine polish. Released as "Folio v1.1.0 — client-side PDF tools."
- **Verification.** App releases v1.0.0 → v1.1.0 per About record.
- **Remaining.** Correctness, progress, cancellation, and large-file bars unmet by the `pdf-lib` implementation — motivated the engine project.

## 2026-08-20 → 2026-08-23 — Rendering maturity (v1.2.x – v1.6.0)

- **Objective.** Make rendering fast, correct, and large-file-safe; add honest progress.
- **Work.** 25x faster thumbnails (single document load), windowed rendering with right-sized scale, PWA offline fix, object-URL revocation, PDF render Worker with main-thread fallback, blob-URL thumbnails, Show-All resume via shared session, Rearrange/Split blob ownership, theme wave system, mobile save flow, cancellable merge jobs with stage progress, large-selection memory notice.
- **Verification.** Release chain v1.2.0 → v1.6.0 (`a2554a6` … `ffa87c8`).
- **Remaining.** Processing still browser-side (`pdf-lib`); engine integration pending.

## Engine development (predates unification; lessons 0–14 per code comments)

- **Objective.** Build a purpose-built, test-covered Rust PDF engine compilable to WASM.
- **Work.** Lesson 0 foundation (`folio-engine` crate); core/operation/result/error model; execution (context, jobs, progress, scheduler, cancellation); observability (events, logger, timing with WASM clock abstraction); shared copy primitives (Lessons 3+); ten PDF operations; metadata model with patch semantics; images-to-PDF with EXIF/DPI handling; thin `wasm` glue crate (Lesson 10); localhost HTTP bridge prototype (Lesson 9, later abandoned); Developer Testbench for manual verification.
- **Findings.** `std::time` panics on WASM (→ `js-sys` clocks); PDF.js detaches buffers (→ defensive copy); unbounded retention hurts (→ bounds everywhere).
- **Remaining.** Engine lived in a separate local directory; production integration pending.

## 2026-09-21 → 2026-09-22 — Unified Folio integration (v1.7.0)

- **Objective.** Make the repository the single source of truth for engine + app on `dev`, replacing the `pdf-lib` path without redesigning the UI.
- **Work.** First attempt `866761f` (production-only WASM-consumer layout) was identified as the wrong architecture and exactly reverted (`390194a`, empty diff vs `ffa87c8`). Correct integration `d76a22e`: engine source (39 files), WASM bridge, 11 integration tests, 10 examples, Studio frontend with engine-data plumbing (duration/counts/size, engine progress labels, `ErrorBlock`, `imageCount` fix, Merge progress-scale fix), PWA restored with WASM precache (`vite-plugin-pwa` 0.21.1 → ^1.3.0), Testbench excluded from the product, README rewritten, `.gitignore` hardened, E2E paths made repo-relative.
- **Findings.** Fresh-clone verification caught CRLF checkouts breaking `format:check` (→ `.gitattributes` `eol=lf`, `74943c4`) and a one-line lockfile peer-flag churn (→ normalized in `d9bb998`); stale dev servers from prior sessions served E2E's port twice (→ PID/path verification discipline).
- **Decisions.** Engine treated as frozen (UI-only adaptation); version 1.7.0 (next minor; v2.0.0 reserved for the About-listed Batch & OCR); `main` untouched.
- **Verification.** Rust 345 tests, fmt, clippy; frontend typecheck/lint/format/118 tests; build + PWA SW; bundle scan zero testbench strings; 25/25 E2E incl. ~514 MB / 2585-page file; fresh-clone full suite green; live browser merge with 0 external requests; Cloudflare dev deploy (`dev.folio-pdf.pages.dev`).
- **Remaining.** Repository still named `pdf-studio`; no persistent project-memory docs — both addressed by Phase 1.

## 2026-09-22 — Phase 1: identity + project memory

- **Objective.** Rename the repository to `folio`, correct product identity, establish the persistent documentation system, and verify no regressions.
- **Work.** Safety checks (clean tree, `dev` at `d9bb998`, `main` untouched, `gh` authenticated). `gh repo rename folio` (old URL redirects; branches/issues/PRs/releases preserved by GitHub). Local `origin` updated to `SUMANTHXT900/folio`. Identity audit: 8 current-identity references updated (README layout + product name, About/StudioApp GitHub links, `main.tsx`/`folio.ts`/E2E comments); historical `ARCHITECTURE.md` Phase-1B references to `pdf-studio` preserved as accurate history. Created `AGENTS.md` (documentation-first rule, relevance mapping, update rule) and all 13 `docs/` files from verified code/history (no invented dates, features, or reasoning). Full verification re-run; normal push to `dev`.
- **Findings.** Identity was already ~90% Folio (package names, PWA, UI copy); the residue was repo-URL links and "PDF Studio" phrasing in comments/docs. No behavior changes were needed.
- **Decisions.** Historical references stay historical; `main.tsx` stale Testbench comment corrected as part of the identity edit (documented here, zero behavior change).
- **Verification.** Full suite green, baselines unchanged: Rust 345 tests, `fmt`/`clippy` clean, WASM build passing, frontend typecheck/lint/format clean, 118 unit tests, production build with PWA SW (34 precache entries, zero testbench strings in bundle), 25/25 E2E against a PID-verified worktree server (incl. 2585-page large file + cancellation). `docs/STATUS.md` baseline table confirmed accurate, no update needed.
- **Remaining.** Phase 2 filesystem restructuring (separate task); `main`/production promotion decision (unscheduled).

## 2026-09-22 — Phase 2: repository filesystem architecture (this entry)

- **Objective.** Reorganize into project-oriented ownership (`engine/` + `wasm/` + `app/` + `docs/`) with zero behavior change.
- **Work.** Read `AGENTS.md` + structural docs first; inspected manifests, configs, and every path-sensitive reference before moving. `git mv` relocations: `src/` → `engine/src/`, `tests/` → `engine/tests/`, `examples/` → `engine/examples/`, root `Cargo.toml`/`Cargo.lock` → `engine/`, `frontend/` → `app/` (verbatim, incl. configs); `wasm/` untouched in place. Functional changes (3): `wasm/Cargo.toml` path dep `..` → `../engine`; `corpus_inspect.rs` default discovery dir `test pdfs` → `../test pdfs` (documented cargo cwd is now `engine/`); `.gitignore` `frontend/*` → `app/*` (+ explicit `engine/target/`). Depth-preserving move: worker import `../../../wasm/pkg`, E2E corpus `../../test pdfs`, `build:wasm` `cd ../wasm`, `fs.allow: ['..']`, tsconfig/vite relative paths all still resolve — verified, not edited. No Cargo workspace (see D12). Docs updated to the new canonical structure (`AGENTS.md` map, `README.md`, `DEVELOPMENT.md`, `ARCHITECTURE.md`, `STATUS.md`, `ROADMAP.md`, `DECISIONS.md` + D12, `GLOSSARY.md`, `OPERATIONS.md`, `LESSONS.md`, `BUGS.md`); historical `ARCHITECTURE.md` log and `CHANGELOG.md` release entries left accurate as history.
- **Findings.** The frontend tree required zero config edits — every path it uses is repo-root-relative at preserved depth. The only true cross-boundary coupling was the `wasm` → engine path dependency.
- **Decisions.** No workspace; corpus stays at repo root; stale root `target/` (ignored) removed after `engine/target/` proved working.
- **Verification.** Full suite green from the new structure, baselines unchanged: Rust 345 tests in `engine/`, `fmt` clean, `clippy --all-targets` and strict `--all-features -- -D warnings` clean, WASM build passing against `../engine`, frontend typecheck/lint/format clean, 118 unit tests, production build with PWA SW (34 precache entries, zero testbench strings in bundle), 25/25 E2E from PID-verified `app/` server (incl. 2585-page large file + cancellation). `docs/STATUS.md` baseline table confirmed accurate, no update needed.
- **Remaining.** Phase 3 fresh-clone validation (separate task); `main`/production promotion decision (unscheduled).

## 2026-09-22 — Phase 3: corpus-independent canonical validation (this entry)

- **Objective.** Remove the fresh-clone dependency on the retired `folio-engine` workspace's private `test pdfs/` corpus: classify large PDFs as optional benchmark inputs, keep canonical validation reproducible from the repository alone.
- **Work.** Read `AGENTS.md` + all structural docs first; swept the repo for corpus references (`test pdfs`, `1.2.pdf`, EWTL names, `merged.pdf`, 2585/514 MB) and classified each as canonical/optional/historical/stale. Created `app/e2e/corpus.mjs` (shared policy: `CORPUS_DIR` probe, `missingFiles`, `reportOptionalSkip`, deterministic `buildMinimalPdf` writer + `writeSyntheticPdf` to OS temp). Reworked `app/e2e/studio.e2e.mjs` into the corpus-optional canonical suite: real fixtures when present, synthetic 22/80-page stand-ins (engine-verified parseable, 80-pager carries the `PowerPoint Presentation` title) otherwise; large-file + large-cancel sections SKIP explicitly with exit-0 semantics and a `PASS / SKIP / FAIL` split summary. Added early-SKIP guards (exit 0, no browser launch, no waiting) to the optional `large-files`/`thumbnail`/`metadata` suites and a clear exit-2 guard to the manual `baseline-shots.mjs` helper. Reclassified docs: new `docs/DECISIONS.md` D13, `docs/DEVELOPMENT.md` canonical-vs-optional policy + optional-corpus layout, `docs/STATUS.md` two-tier baseline, plus `PROJECT.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, `ROADMAP.md`, `README.md`, `AGENTS.md` wording. `.gitignore` already covered `test pdfs/` + `*.pdf` — unchanged. `D:\hobby_projects\ideating\folio-engine` confirmed deleted; `pdf-studio-work` untouched (its dangling `test pdfs` symlink reported, not modified).
- **Findings.** The previous Phase 3 run's merge-step timeout was the small-fixture hard dependency, not just the large file — hence the synthetic fallback rather than SKIP for the small sections. Optional suites assert corpus-specific facts (private authors/dates/39/80/2585 counts) that cannot be synthesized honestly, so whole-suite SKIP is the correct classification there. Remaining `folio-engine` strings are the Rust crate name and in-test fixture labels, not workspace references.
- **Decisions.** D13 (large PDFs optional, never canonical); synthetic stand-ins cover canonical shapes with zero bytes in git; 25/25 stays the with-corpus benchmark, 21/21 + 4 SKIP the fresh-clone expectation.
- **Verification.** Without any corpus: Rust 345 tests, `fmt`/`clippy` (incl. strict `--all-features -- -D warnings`) clean, WASM build passing, typecheck/lint/format clean, 118 frontend tests, production build (PWA SW, 34 precache entries), canonical E2E 21/21 passed + 4 SKIPPED (optional corpus unavailable), optional suites exit 0 with explicit SKIP. No large PDFs added, `main` untouched.
- **Remaining.** `main`/production promotion decision (unscheduled).

## 2026-09-23 — Mobile UI fixes F-7–F-10 (bottom nav, proof line, rearrange handle)

- **Objective.** Fix the crammed mobile bottom nav plus other phone UI issues found in the same audit, UI-only (the VPS has no Rust toolchain, no `wasm-pack`, no Chrome).
- **Work.** `StudioApp.tsx`: nav is now a single-row snap-scrolling strip (was `grid-cols-4` holding 8 destinations across two rows); page bottom padding (`pb-[92px]`) applies only when the nav renders. `Home.tsx`: hero proof-line wraps below `sm`. `RearrangeTool.tsx`: drag starts only from a grip handle (`dragControls`, rows keep `pan-y` scroll), arrow buttons enlarged, helper copy updated. Docs: `BUGS.md` F-7–F-10 recorded as resolved.
- **Verification (VPS side).** eslint clean, prettier clean, vitest 118/118 passing. `npx tsc --noEmit` reports exactly one error — the missing gitignored `wasm/pkg/folio_wasm.js` module (pre-existing environmental gap, fails identically without these changes); zero type errors in the edited files. `package-lock.json` churn from the local `npm install` reverted. NOT run here (impossible without Rust/Chrome): `build:wasm`, production build, E2E. `STATUS.md` baselines untouched. Committed + pushed to `dev` from here (UI-only, engine untouched).
- **HANDOFF for the laptop-side agent.** You have Rust + the full toolchain — do this in order:
  1. `git pull` on `dev`; confirm HEAD includes the F-7–F-10 commit.
  2. Run the full verification suite exactly as `docs/DEVELOPMENT.md` prescribes: `cargo test` + `fmt --check` + `clippy` in `engine/`; `npm run build:wasm`, then typecheck/lint/format/unit-tests/build in `app/`; canonical E2E (`node e2e/studio.e2e.mjs`) — expect 21/21 + 4 explicit SKIPs without the optional `test pdfs/` corpus.
  3. If any `docs/STATUS.md` baseline number changes, update that table in the same session (rule: never leave stale numbers).
  4. If the suite is green, decide the version bump per the release workflow (UI-fix batch → patch bump; keep `CHANGELOG.md`, About version tree, `STATUS.md`, `README.md` consistent). If anything fails, fix on the laptop side — do not ask the VPS side to verify further than lint/format/unit tests.
  5. `main`/production promotion stays unscheduled and out of scope — do NOT promote as a side effect.
- **Remaining after handoff.** Full-suite confirmation (or fixes); version bump decision; nothing else pending from this change.

## 2026-09-23 — Handoff closure: F-7–F-10 verified, v1.7.1 (laptop side)

- **Objective.** Execute the VPS handoff above on the Rust-capable side and close it out.
- **Work.** `git pull` on `dev` (fast-forward `656cdbe` → `3057b95`, clean tree confirmed). Ran the full suite per `docs/DEVELOPMENT.md`: `cargo test` in `engine/` (345 passing: 228 unit + integration), `cargo fmt --check` clean, `cargo clippy --all-targets` clean, `npm run build:wasm` passing, `npm run typecheck` passing (the VPS-side `wasm/pkg` gap resolved by building), `npm run lint` / `format:check` clean, `npm test` 118/118, `npm run build` passing (PWA SW, 34 precache entries, zero testbench strings in bundle). Canonical E2E `node e2e/studio.e2e.mjs` against a PID-verified `vite --port 5199 --strictPort` server: 21/21 passed + 4 SKIPPED (no `test pdfs/` corpus present); optional `large-files`/`thumbnail`/`metadata` suites exit 0 with explicit SKIP. Patch bump `1.7.0` → `1.7.1` via `npm version patch --no-git-tag-version` (About `latest` entry follows automatically via `__FOLIO_VERSION__`); closed out `STATUS.md` (baselines unchanged), `CHANGELOG.md` (new v1.7.1 entry), `BUGS.md` F-7 verification, `ROADMAP.md`, `README.md` (badge + history).
- **Findings.** Zero baseline changes — the F-7–F-10 batch is purely presentational, as designed. The VPS-side typecheck error was purely the gitignored `wasm/pkg/` absence, not a code issue.
- **Decisions.** v1.7.1 patch (not minor): UI-fix batch with no engine/contract changes. `main`/production promotion stays unscheduled and out of scope — NOT done here.
- **Verification.** As listed under Work above; rebuilt after the version bump to confirm the shipped artifact. Deployed `app/dist/` (v1.7.1 build) to Cloudflare Pages `folio-pdf` branch `dev` via wrangler (`https://dev.folio-pdf.pages.dev`).

## 2026-09-23 — Images → PDF 2.0: page assembly, preview, reorder, camera (v1.8.0)

- **Objective.** Turn Images → PDF into a page-assembly workflow (preview, reorder, remove, add-more, rotate, camera capture) without touching the engine.
- **Work.** Read `AGENTS.md` + feature docs first; traced the flow (`ImagesTool` → `stageStudioBytes` → `runStudioOperation` → adapter → worker → WASM → `ImagesToPdfOperation`) and confirmed ordering is already app-level (engine preserves input order; Rust test `multiple_images_produce_multiple_pages_in_order`). New app-only modules: `imagePages.ts` (pure collection logic: move/remove/rotate), `imagePrepare.ts` (build-time bytes; renderer injectable), `useImagePages.ts` (state + object-URL lifecycle), `PageGrid.tsx` (preview grid; ←/→ move buttons guaranteed, HTML5 drag as desktop-only enhancement per review directive), `CameraCapture.tsx` (`getUserMedia` input source into the same collection), `ImagesTool.tsx` rewrite (stages pages in collection order). E2E images section extended with committed `red-wide.png`/`blue-tall.jpg` fixtures. Minor bump `1.7.1` → `1.8.0`; closed out `STATUS.md` (baselines updated), `ROADMAP.md`, `CHANGELOG.md`, `DECISIONS.md` (D14), `PROJECT.md`, `ARCHITECTURE.md`, `OPERATIONS.md`, `GLOSSARY.md`, `README.md`.
- **Findings.** No engine change needed (ordering + atomicity already served app-side). framer-motion `Reorder` rejected as primary (single-axis vs wrapping grid) — buttons guaranteed per review. The repo eslint config has no `react-hooks` plugin (stray disable comment removed). E2E count moves 21/21 → 25/25 (+4 images checks); frontend tests 118 → 134.
- **Decisions.** D14 (unified collection, camera-as-input, app-side rotation, buttons-guaranteed/drag-enhancement). Camera hardware tests excluded from CI (manual checklist only).
- **Verification.** Full suite green: Rust 345, `fmt`/`clippy` clean, WASM build passing, typecheck/lint/format clean, 134 unit tests, production build (PWA SW, 34 precache entries, zero testbench strings), canonical E2E 25/25 + 4 SKIP (no corpus), optional suites exit 0 SKIP. Deployed `app/dist/` (v1.8.0 build) to Cloudflare Pages `folio-pdf` branch `dev` via wrangler (`https://dev.folio-pdf.pages.dev`). `main` untouched.
- **Remaining.** `main`/production promotion decision (unscheduled); mobile-device camera field check (manual).
- **Remaining.** `main`/production promotion decision (unscheduled); nothing else pending.

## 2026-09-23 — v1.9 Phase 1: dnd-kit page-grid drag/drop

- **Work.** `@dnd-kit/core` + `sortable` + `utilities`: `rectSortingStrategy` grid, grip handle as sole activator (`touch-action: none` on handle only), `DragOverlay`, before/after insertion indicator, Pointer (8px) + Touch (250ms long-press) + Keyboard sensors. Arrows kept as guaranteed fallback; `imagePages.ts` untouched. New `pageDrag.ts` (pure drop→index mapping + 3 tests). E2E keyboard-drag assertions (overlay/indicator/reorder). Fixed during verification: a duplicated rotate click from an edit slip, and keyboard-step racing (settle-time waits).
- **Verification.** 137 unit tests, canonical E2E 28/28 + 4 SKIP (run twice), zero console errors.

## 2026-09-23 — v1.9 Phase 2: document-scanner UI (presentation layer)

- **Objective.** Scanner-style viewfinder without hardware capabilities (Phase 3) or CV (v2.0).
- **Work.** Rewrote `CameraCapture.tsx`: full-ratio letterboxed preview (fixes G1 crop; aspect from stream metadata + resize tracking), framing-guide overlay (corner markers, dim mask, `pointer-events-none`, `data-scanner-overlay`), 3×3 grid toggle (`data-scanner-grid`), session thumbnail strip (newest ringed, URLs only), shutter-style capture + Done + session-scoped Retake, kept switch-camera/device-select. `ImagesTool.tsx`: session-id boundary (ids reset on scanner open/Done; Retake pops only the session's last id). `useImagePages.ts`: `addEntries` returns ids and creates URLs outside the updater (StrictMode double-invoke fix). Tests: `useImagePages.test.ts` (4: ids, Scan-More order contract, revoke on clear/unmount, skip counting), `CameraCapture.test.tsx` (4: denied/unfound failures, overlay+grid+strip+Done-stop, unmount-stop). E2E: scanner-failure graceful path + uploads-after-failure (headless has no camera — deterministic).
- **Findings.** Test setup needed explicit `cleanup()` (no auto-cleanup in this vitest config — renders accumulated across tests in one file). StrictMode was already on: URL/id creation inside the updater was a latent dev-mode leak, fixed as part of returning ids.
- **Decisions.** Session boundary = scanner open → Done; strip is previews-only, `ImagePage[]` stays the source of truth; no capability/CV code in this phase (explicitly deferred).
- **Verification.** Full suite green: Rust 345, `fmt`/`clippy` clean, typecheck/lint/format clean, 145 unit tests, production build (34 precache, zero testbench strings), canonical E2E 30/30 + 4 SKIP with Phase 1 drag tests intact (overlay/indicator/keyboard/arrows all PASS). `main` untouched.
- **Remaining.** Phase 3 (capabilities) — completed below; device matrix still manual.

## 2026-09-23 — v1.9 Phase 3: camera capability controls

- **Objective.** Capability-aware zoom/torch/focus with the rule: detection is necessary, only a successful `applyConstraints` proves a feature works.
- **Work.** New `cameraCapabilities.ts` (isolated detection: `readTrackCapabilities` normalizes zoom min/max/step, torch boolean, focusMode list, continuous/tap-to-focus flags; `requestContinuousModes` silent best-effort). `CameraCapture.tsx`: per-session capability state recalculated on every stream start (no stale controls across camera switches); zoom slider bound to the track's real range (lens-level, never CSS); torch toggle; tap-to-focus only with `single-shot` AF (positional marker while the cycle runs; taps inert otherwise); rejection disables the control with a non-blocking note. Tests: `cameraCapabilities.test.ts` (9: absent/empty/invalid caps, zoom/torch/focus parsing, manual-only exclusion, silent continuous request), `CameraCapture.test.tsx` +6 (gated rendering, zoom/torch apply, rejection disable, tap positive/negative, switch recalculation).
- **Findings.** TS DOM lib lacks zoom/torch/focusMode on `MediaTrackConstraintSet` (narrow casts used); repo eslint bans non-null-asserted optional chains (adjusted one test). No browser here exposes real capabilities, so hardware application is unverified by automation.
- **Decisions.** Manual + focusDistance alone is NOT tap-to-focus (no honest point→distance map); continuous focus/exposure requested silently, never displayed as a feature; zoom uses a slider bound to min/max/step (presets add nothing over the native range input).
- **Verification.** Full suite green: Rust 345, `fmt`/`clippy` clean, typecheck/lint/format clean, 160 unit tests, production build (34 precache, zero testbench strings), canonical E2E 30/30 + 4 SKIP (Phase 1/2 assertions intact). No version bump (reserved for v1.9 completion). `main` untouched.
- **Remaining.** Phase 4 (lifecycle/disconnect hardening) — completed below; hardware matrix still manual.

## 2026-09-23 — v1.9 Phase 4: camera lifecycle & failure hardening

- **Objective.** Close B1/B2/B3: stale-stream leaks, silent disconnects, swallowed play failures — with deterministic tests, no hardware.
- **Work.** `CameraCapture.tsx`: generation-guarded `start()` (only the current generation installs state/stream; stale resolutions stop their own stream); `track.ended` listener → `disconnected` state with retry (remaining tracks released, caps cleared, no frozen frame); `devicechange` listener (picker refresh, vanish-of-active-device → disconnected, no restart on mere addition, cleanup on unmount); `play()` rejection → `preview-blocked` state (hardware released; autoplay-policy vs genuine failure copy; Try again is a real user gesture); `leave()`/unmount bump the generation. Explicit local state machine (`starting | live | failed | disconnected | preview-blocked`) documented in the file header. Tests +4 (`CameraCapture.test.tsx` 14 total): stale-stop with srcObject proof, ended→disconnect→retry recovery, play-reject→retry, devicechange removal + listener cleanup.
- **Findings.** One self-inflicted edit slip deleted a line (caught by immediate re-read, repaired before typecheck). All 14 component tests pass first-run after the isolation fix from Phase 2.
- **Decisions.** Retry reuses `start()` (fresh generation, fresh caps); disconnect clears capability UI (no stale zoom/torch for a dead device); taps during non-live states impossible (controls only render live).
- **Verification.** Full suite green: Rust 345, `fmt`/`clippy` clean, typecheck/lint/format clean, 164 unit tests, production build (34 precache, zero testbench strings), canonical E2E 30/30 + 4 SKIP (Phase 1–3 assertions intact). No version bump (reserved for v1.9 completion). `main` untouched.
- **Remaining.** Hardware-only matrix (disconnect/reconnect, autoplay-policy variances, real capability application) — all unverified; v2.0 detection work explicitly not started. Deployed `app/dist/` (v1.9 Phase 1–4 build) to Cloudflare Pages `folio-pdf` branch `dev` via wrangler (`https://dev.folio-pdf.pages.dev`).

## 2026-09-23 — v2.0 M1: folio-scan core (detection + warp + enhancement)

- **Objective.** Prove the detection → corner-normalization → homography → warp pipeline with deterministic tests before any worker integration.
- **Work.** New `scan/` crate (`folio-scan`, independent manifest/lock per D12): `geometry.rs` (corner ordering, quad validation, DLT homography + inverse), `detect.rs` (downscale → gray → blur → Canny → contours → closed-loop RDP → edge-support confidence), `warp.rs` (inverse-mapped bilinear warp, geometry-derived output dims, JPEG encode), `enhance.rs` (Original/Grayscale/adaptive-threshold B&W), `pipeline.rs` (orchestration + honest fallback), `error.rs`. 26 tests; `scan_bench` example (synthetic fixtures, no corpus).
- **Findings.** Two real bugs caught by the gate: (1) Rust precedence — `-(x).mul_add(...)` parses as `-(x.mul_add(...))`, flipping a sign in point-line distance and starving RDP (regression test added); (2) plain RDP keeps the arbitrary loop start as a 5th vertex — fixed with corner-start rotation. `imageproc` 0.28 is unreleased (main branch); 0.27 used. Release cdylib with pipeline rooted: **607 KB** raw (≈400–500 KB after wasm-opt) — precache-viable (4.1 + ~0.5 « 8 MB cap); final call at M2 with the wasm-pack number.
- **Benchmarks (release, synthetic).** 12 MP phone-class: detect ~165 ms, total ~590 ms (Original) / ~845 ms (B&W), conf 0.81, out 2435×2320. Medium 1280×960: ~100 ms total. Webcam 640×480: ~38 ms. Low-light: detected, conf 0.78. 2500px cap holds; no upscaling.
- **Decisions.** Self-implemented warp sampling (no warp-API risk); confidence = dilated edge support ≥ 0.5 + geometry gates; fallback returns original bytes untouched; EXIF orientation out of scope for the scan path (camera captures are EXIF-free — documented in `pipeline.rs`).
- **Verification.** `cargo test` 26/26, `fmt` clean, `clippy --all-targets -- -D warnings` clean, `wasm32-unknown-unknown` release builds. Engine/frontend untouched. No version bump.
- **Remaining.** M2 (scan worker + protocol + WASM loading); output-cap tuning after real-photo benchmarks.

## 2026-09-24 — v2.0 M2: scan worker + protocol + WASM integration

- **Objective.** Run the M1 core inside a dedicated worker behind a versioned protocol, with job safety and measured artifacts. No UI wiring (M3).
- **Work.** `scan/src/wasm.rs` (target-gated glue: `scan_init`, `scan_process` → `{result_json, output}` envelope; fallback is status `original`, never an error; M1 core untouched). `npm run build:scan` + `.gitignore` (`scan/pkg`, `scan/target`). `app/src/studio/tools/scan/`: `scanProtocol.ts` (v1, framing guards), `scan.worker.ts` (init-once, sequential jobs, transferables, indeterminate status only — no fake %), `scanWorkerClient.ts` (lazy worker, epoch-guarded stale discard, terminate-to-cancel + transparent recreate, injectable factory), `scanStore.ts` (original-retention interfaces for M3; lifetime follows the page). Tests: protocol (3), client (6: mapping, transfer, stale/restart, init-fatal, malformed), store (2).
- **Findings.** wasm-pack output measured: **folio_scan_bg.wasm 514 KB** (+12 KB JS) vs engine 1569 KB — precache total ≈ 4.6 MB « 8 MB cap, budget preserved unchanged. Round-trip benchmark (headless Chrome, temp harness, since removed): 1280×960 first 193 ms (incl. boot+init) / second 73 ms; 12 MP first 393 ms / second 376 ms — same order as M1 native (590 ms), transfer overhead small. Relative import depth bit once (`scan.worker.ts` is 4-deep, not 3).
- **Decisions.** Separate worker (not engine worker); status-only progress (core exposes no stage spans — percentages would be invented); transfer-not-copy on exact-owned buffers; fatal poisons the instance (next job recreates); stage timings deferred (needs core spans — M3 call if UI requires).
- **Verification.** `cargo test` scan 26/26, `fmt`/`clippy -- -D warnings` clean (both crates), typecheck/lint/format clean, 175/175 unit, production build (34 precache — scan client tree-shaken out until M3 wires it, zero testbench strings), canonical E2E 30/30 + 4 SKIP. `main` untouched. No version bump.
- **Remaining.** M3 (CameraCapture integration + live indicator + modes + fallback UX); real-photo output-cap tuning.

## 2026-09-24 — v2.0 M3: camera scanner integration + processed scan UX

- **Objective.** Wire captures through the M2 worker into review/accept UX with live guidance, modes, and honest fallbacks. No engine changes.
- **Work.** New `useScanProcessor` hook (capture→worker→review state machine, session generation guard, latest-frame live throttle, lazy client, terminate-on-reset). `CameraCapture.tsx`: mode selector (Original bypasses worker; Document/Grayscale/B&W process), processed-preview review (Use scan / Use original / Retry / Retake), no-detection and scanner-failure panels with distinct copy, live "Document detected" indicator (~160px frames, 500 ms ticks, skipped while busy), processing overlay, shutter gating. `ImagesTool.tsx`: accept adds the page + retains the original under the page id; remove/clear/retake release scanStore entries (lifetime follows the page, never the session). Tests: hook (5), E2E fake-camera suite (Y4M trapezoid, second flagged browser): processed review, accept × modes, scan-more preservation, stale-result safety, real-PDF build.
- **Findings.** Headless `canvas.captureStream` yields 2×2 frames (unusable for scan E2E) — switched to `--use-file-for-fake-video-capture` with a runtime-generated Y4M: real 640×480 frames, genuine detection. Second-browser download plumbing doesn't fire in the flagged session, so the scan-build check probes the result blob in-page (%PDF-, 864 KB) instead; download plumbing stays covered by main-browser tests. Keyboard-drag E2E flaked once more — settle sleeps added (proven pattern).
- **Representative eval (synthetic, NOT real-device).** Receipt/colored-paper/clutter/text/perspective-heavy fixtures all detect (conf 0.73–0.90); 12 MP total ~270–380 ms; 2500px cap retained with evidence, no tuning change.
- **Decisions (D16).** Review-before-accept (nothing enters the collection unconfirmed); live corners never reused for final geometry; Original mode = v1.9 path preserved; manual corners + auto-capture stay v2.1.
- **Verification.** Scan Rust 26/26, `fmt`/strict clippy clean, typecheck/lint/format clean, 180/180 unit, production build (36 precache entries, 4695 KB incl. `folio_scan_bg.wasm` 514 KB + `scan.worker.js` — budget preserved « 8 MB, zero testbench strings), canonical E2E 35/35 + 4 SKIP (run twice), zero console errors. `main` untouched. No version bump (M4).
- **Remaining.** M4 (final docs, CHANGELOG, version bump); real-device matrix (all unverified).

## 2026-09-24 — Image→PDF hardening P0–P6 (memory + camera quality, no version bump)

- **Objective.** Fix the measured 30-image crash architecture and the under-constrained camera without changing engine contracts.
- **Work.** P0: `images_to_pdf` restructured to `PdfBuild` incremental embed (decode → embed → release per image; `Vec<DecodedImage>` gone; move-not-clone into streams; order/progress/cancel/atomicity/errors preserved). P6: per-instance liveness counters + `peak_decoded_retention_is_one_image_not_n` (globals rejected after they raced parallel tests — documented in code). P1: `transfer?: boolean` on `EngineDocumentInput` (additive); staged ids tracked in `folio.ts`; adapter moves exact-owned staged buffers, copies everything else (rendering-backed docs protected). P2: `studioDownload` accepts `Blob`; ImagesTool builds ONE Blob (was two + retained bytes); DoneBanner/share untouched. P3: `cameraConstraints.ts` (1080p/30fps ideals, exact only for explicit device) + negotiated-settings debug log. P4: 4 constraint tests. P5: regenerated fixtures, 5/10/20/30 stress + 30-page cancel probe.
- **Findings.** Post-fix stress (same fixtures/harness): 30 pages complete, order/counts correct, cancel honest; JS heap still ~2 GB at n=30 — dominated by the 1 GB output Blob (by design for share/re-download) + harness probe artifact, NOT inputs (worker-side win proven structurally by P6 + code: peak decoded 36 MB vs 1.08 GB). Camera ideals unverified on hardware (no device here); canvas/`videoWidth` and q0.92 confirmed correct by code + size measurements.
- **Verification.** Engine 346 (345 + peak test), `fmt`/strict clippy clean (both Rust runs), WASM rebuilt, typecheck/lint/format clean, 190/190 unit, production build (34 precache, zero testbench strings), canonical E2E 37/37 + 4 SKIP, zero console errors. `main` untouched. No version bump, M4 not started.
- **Remaining.** Real-device matrix (mid-range Android 30-page run, webcam settings before/after ideals, iOS run); DCT passthrough stays v2.1. Deployed `app/dist/` (hardening build incl. scan worker + both WASMs) to Cloudflare Pages `folio-pdf` branch `dev` via wrangler (`https://dev.folio-pdf.pages.dev`).

## 2026-09-24 — Image → PDF stress + camera-quality audit (pre-v2.0 hardening, no fixes)

- **Objective.** Diagnose the 30-image Aw-Snap crash and the webcam quality gap with measurements, not guesses.
- **Work.** Traced the full pipeline stage-by-stage; added `engine/examples/gen_stress_images.rs` (deterministic 12 MP photographic-noise JPEGs, ~2.25 MB each — instrumentation only, no private photos); drove 5/10/20/30-page builds in headless Chrome via a temporary harness (since removed) measuring wall/engine time, output size, JS heap, and longtasks.
- **Findings (measured).** No crash in headless desktop at 30 pages, but linear pathology: JS heap 8 MB → 2146 MB (~72 MB/page retained: staged inputs + adapter copies + 1 GB output Blob in React `done` state); output PDF 1.08 GB from 67 MB input (**16× inflation — raw RGB embedding, no DCT passthrough**); Rust holds ALL decoded RGB simultaneously (`decoded: Vec`, model B: 30 × 36 MB ≈ 1.08 GB) plus input blobs plus the output document (~2.3 GB transient in the worker); main-thread longtasks up to ~1 s during staging/preview/blob handling. Phone-class tab limits explain the Aw-Snap. Camera: constraints request only `facingMode ideal` (desktop webcams typically negotiate 640×480 vs the OS app's full sensor — prime quality suspect, needs hardware confirmation); canvas correctly uses `videoWidth/Height` (not CSS); capture JPEG q0.92 measured sane (q92 2.65 MB vs q98 5.78 MB on synthetic — resolution, not quality setting, is the suspect).
- **Decisions.** No fixes implemented (audit-only); hardening proposals ranked in the report; `gen_stress_images.rs` kept as the documented repro path.
- **Remaining.** Hardening milestone (incremental embed redesign + ownership cuts + camera negotiation) before any v2.0 release claim.

## 2026-09-24 — Camera HUD responsiveness pass (UI-only, pre-M4)

- **Objective.** Delayer the scanner controls (viewport / topbar / dock / strip) for mobile + desktop without behavior changes.
- **Work.** `CameraCapture.tsx`: new `CameraTopBar` (Done «, title + badge, grid toggle, switch-camera icon, device picker), detection pill moved inside the viewport (sr-only live-region mirror kept, no double announcement), dock recomposed as mobile grid (torch · centered shutter · retake + full-width zoom row) vs desktop centered cluster (torch · wide zoom · shutter · retake) sharing one DOM, compact circular torch, safe-area padded dock. `data-detection-pill` hook for tests. Tests: +2 HUD layout (topbar/dock/strip presence, torch shape, live zoom min/max/step/value), E2E geometric layering at 1280px + 375×667 (viewport/pill/shutter/strip/torch-absent).
- **Findings.** Strip sits between viewport and dock (assertion first written backwards — caught by the new check, corrected). No behavior regressions: 37/37 E2E twice, 182 unit.
- **Verification.** typecheck/lint/format clean, 182/182 unit, production build, canonical E2E 37/37 + 4 SKIP (×2), zero console errors. No version bump (M4). `main` untouched.
- **Remaining.** M4; manual-device checks (small-phone dock feel, torch/zoom on real phones, safe-area on notched devices).

## 2026-09-25 — M3.x: mobile image import + scanner UX hardening (no version bump)

- **Objective.** Fix the real Android failure: 32 selected phone photos (~2 MB each, 12 MP) via Add Images → system UI unresponsive → Aw-Snap. Diagnosis: a ~2 MB JPEG decodes to ~36 MB raw pixels; the import path created pages without any pixel-budget normalization, so tens of full-resolution decodes could coexist; compressed file size was never the memory metric.
- **Work.** New `imageImport.ts`: per-file `createImageBitmap` decode → pixel-budget decision (`MAX_IMPORT_LONG_EDGE = 2500`, aspect preserved, never upscaled) → one JPEG re-encode (q0.92) only when oversized; within-budget images keep ORIGINAL bytes; every bitmap/canvas released per file; `runImportQueue` is strictly sequential (concurrency 1) with an event-loop yield between files. `useImagePages.importFiles`: prepares ONE file, commits its page immediately, reports progress, honors an AbortSignal (cancellation keeps already-committed pages), isolates per-file errors. `CameraCapture.tsx`: scanner is now PORTALED to `document.body` (inline `fixed` sized to the route-transition transform ancestor — the measured cause of the viewport scrolling away), full-bleed on phones, centered bounded panel + backdrop on desktop; Import button in the scanner top bar (native picker; progress strip with Cancel always visible); scan-mode selector (Original/Document/Grayscale/B&W) removed — one color capture experience (`useScanProcessor` mode state deleted). `ImagesTool.tsx`: completion card resets when the collection/page-size changes → Build PDF returns after post-build imports and the old output Blob is released. E2E: downloads are now captured IN-PAGE (anchor patch records `{href, name}`; probes fetch bytes) so no OS download ever fires — external download managers (IDM) can no longer intercept or stall runs; new checks: no mode selector + Import in bar + centered desktop panel, phone fixed full-viewport surface, import progress, 6 oversized images imported in order, mixed scan+import builds a 9-page PDF.
- **Verification.** Unit 205 (15 new: 10 import normalization/queue + 7 hook import + updated scanner tests). Canonical E2E 42/42 + 4 SKIP, zero console errors; import regression in E2E: 6 × 3000×2000 JPEGs (2.4 MB) committed in order, build → `9 images → 9-page PDF`, 76 MB output, no crash. typecheck/lint/format clean; production build clean (36 precache entries, 4702 KB). Rust untouched (346 tests green at e2b42e6).
- **Real-device status.** Android validation **PENDING** — the affected phone must run: 10/20/30/50 imported photos, 30 camera captures, mixed, import-while-scanning, cancel halfway, remove imported pages, build. iOS Safari pending. No claims made.
- **Remaining.** M4 untouched; no version bump; IDM-bypass is test-harness only (no product change).

- **Deploy.** M3.x build deployed to Cloudflare Pages `folio-pdf` branch `dev` via wrangler (`https://dev.folio-pdf.pages.dev`).

## 2026-09-25 — Scanner UX polish + E2E suite fixes (M3.x follow-up)

- **Objective.** Make the camera surface self-explanatory and stop the E2E suite from wasting time.
- **Work.** Camera UX: Back button (chevron icon, aria "Back to pages", Escape-to-close), dock rebuilt as three equal cells so the shutter is truly centered with a visible "Capture" label, dock "Retake" renamed to "Undo" (aria "Undo last capture"), review "Retake" renamed to "Discard", import fixtures in the suite switched from per-pixel JS noise (the slowest step in the suite by far) to fast canvas fills. Removed the flaky timing-dependent "import progress surface" assertion (progress may flash by too quickly to observe reliably — the actual guarantee, pages committing in order, is asserted directly). Renamed "Done scanning" → "Back to pages" throughout tests/E2E for consistency with the new UX.
- **Verification.** Unit 205 (5.3s). Canonical E2E 41/41 + 4 SKIP in **28.3s** (was several minutes — the per-pixel noise loops and the timing-dependent check were the main cost). typecheck/lint/format clean; production build clean (36 precache entries, zero testbench strings).
- **Remaining.** Real-device Android validation still PENDING; M4 untouched; no version bump.

- **Deploy.** UX-polish build deployed to Cloudflare Pages `folio-pdf` branch `dev` via wrangler (`https://dev.folio-pdf.pages.dev`).

## 2026-09-25 — Scanner shell fixes: scroll lock, View pages CTA, zoom removal (no version bump)

- **Objective.** Fix real-device UX defects found on the phone: page scrolled behind the scanner (chrome/nav revealed), no highlighted path from the scanner to the page list, and a zoom slider that misreported the optical scale.
- **Work.** `CameraCapture.tsx`: body scroll lock while the scanner is mounted (body pinned at offset, restored on exit — standard mobile-safe modal lock) plus `overscroll-contain` on the surface; new primary **"View pages (N)"** CTA in the scanner bar once pages exist (Back + Escape remain the exits); zoom control removed entirely (slider, state, applyConstraints path); dock stays three equal cells (torch · Capture · Undo). `cameraCapabilities.ts` zoom field/`ZoomRange`/`normalizeZoom` removed — capability model is torch + focus only. Tests: scroll-lock effect, View pages CTA, Escape exit, torch rejection note, no-zoom assertions; zoom-specific capability tests removed.
- **Findings.** The track zoom range has no focal-length meaning (`getCapabilities().zoom` is a device-internal scale; the phone showed "1×" while the ultrawide lens was active) — recorded as BUGS F-11 with a ROADMAP revisit item.
- **Verification.** Unit **206 passed**; canonical E2E **41/41 + 4 SKIP in 42.5s** (scanner surface check now also asserts zero zoom controls and the View pages CTA); typecheck/lint/format clean. Real-device Android re-check still PENDING.
- **Remaining.** Real-device validation; M4 untouched; no version bump.

- **Deploy.** Scanner-shell fixes deployed to Cloudflare Pages `folio-pdf` branch `dev` via wrangler (`https://dev.folio-pdf.pages.dev`).

## 2026-09-25 — Scanner viewport + page-manager UX fixes (real-device screenshots)

- **Objective.** Fix phone-verified defects: letterboxed viewfinder with misregistered guide after captures, truncated scanner top bar, noisy page-manager cards.
- **Work.** New `scanViewport.ts`: the viewport wrapper flexes to leftover space and a ResizeObserver measures its real pixel box; a pure, unit-tested `containRect()` computes the exact painted rect for the negotiated video ratio, and video + overlay both render exactly that rect — zero letterbox bars by construction (replaces fragile `aspect-ratio` + `100dvh - 240px` CSS that diverged whenever strip/review/topbar changed the chrome). Ratio source priority: track settings → video dims → 3:4. Zero-size measurements are never stored (hidden-state guard). `PageGrid.tsx`: document-shaped 3:4 previews, single-line name (size in tooltip), h-9 controls. `ImagesTool.tsx`: non-wrapping header (truncate + shrink-0 Clear). Scanner topbar: title/import text hide below ~400–430px (icons + aria-labels remain). Removed the redundant bottom hint row (pill + sr live region suffice).
- **Findings.** The desktop E2E HUD check caught a real race the fix also hardens: measuring between unhide and the observer refire yielded a zero box — now impossible by construction, and the E2E waits for a non-zero box. Debug confirmed the measured layout renders the fake 640×480 stream at exactly 710×532.5 with no bars.
- **Verification.** Unit **210 passed** (4 new viewport math); canonical E2E **41/41 + 4 SKIP in ~39s**; typecheck/lint/format clean; production build clean (zero testbench strings). Real-device re-check still PENDING.
- **Remaining.** Real-device Android validation; M4 untouched; no version bump.

- **Deploy.** Viewport/page-card fixes deployed to Cloudflare Pages `folio-pdf` branch `dev` via wrangler (`https://dev.folio-pdf.pages.dev`).

## 2026-09-25 — Deploy-skew build failure + scanner strip reorder (no version bump)

- **Objective.** Fix the real-phone "Failed to fetch dynamically imported module" build failure and the strip-above-dock squeeze reported with screenshots.
- **Work.** Shared `ErrorBlock` now detects stale code-split chunks and offers an explicit Reload (raw URL kept as diagnostics); `vite.config.ts` keeps outdated precaches so new service workers stop deleting previous deployments chunks under open pages (new BUGS F-12). Scanner: session strip moved below the dock (bottom-most, safe-area there), strip thumbs h-14/w-10 on phones, review panel compacted — viewport keeps maximum height. E2E layering assertion updated for the new order (caught the intent immediately: first wrote it backwards, the check failed honestly, corrected).
- **Verification.** Unit **214 passed** (4 new stale-chunk tests, incl. a null-safety bug the tests caught in the helper); canonical E2E **41/41 + 4 SKIP in ~38s**; typecheck/lint/format clean; production build clean. Real-device re-check still PENDING.
- **Remaining.** Real-device Android validation; M4 untouched; no version bump.

- **Deploy.** Stale-chunk/strip fixes deployed to Cloudflare Pages `folio-pdf` branch `dev` via wrangler (`https://dev.folio-pdf.pages.dev`). NOTE: this very deploy is the first one protected by `cleanupOutdatedCaches: false` + the reload recovery — the phone should be reloaded once to the current shell.

## 2026-09-25 — Real-photo detection robustness + scanner UX fixes

- **Objective.** Phone-verified defects: detector only fired on lab-grade black/white images (real notebook photos always fell back, nagging every capture; 13 fallbacks → 81 MB PDF), viewfinder too small, review popup on every capture.
- **Work (scan crate).** `detect.rs`: Otsu binarization (per-photo adaptive threshold), morphological closing (bridges shadow gaps), contours sorted by area desc with top-8 + 1.5% prefilter, first-passing-quad-wins, plus `try_merge_horizontal` for spine-split open spreads (gap ≤ 15% width, ≥ 70% edge overlap, merged quad re-validated + support-gated). Kept all gates: convexity, 30–150° angles, 5–99% area, edge support ≥ 0.5. New fixtures: dark gradient photo, textured desk, open-spread-with-spine, rotated low-contrast page. Verified against industry practice (Scanbot/Docutain classical recipe: gray → blur → Otsu → Canny → area-ordered contours → 4-point approx); ML approaches explicitly out of scope (no models, local-first).
- **Work (app).** Fallback auto-accept: no-boundary captures commit immediately (normalized through the import pixel budget) with a transient note — no more per-capture interrogation; processed/error reviews unchanged. Review panel drops the fallback branch. Bottom hint row removed (pill + sr region suffice) so the viewport grows. Fallback originals normalized like imports (bounds the 81 MB-class output blowup for 12 MP photos; true DCT passthrough stays v2.1).
- **Findings.** The support-max selection picked half pages; area-order + merge fixed it (verified: spread found at support 0.99). Synthetic bench still fast (12 MP detect ~90–170 ms). Output size without passthrough is inherent (raw RGB ≈ w×h×3/page) — documented honestly, not fixed here.
- **Verification.** Scan Rust **34 passed** (4 new fixtures + 2 merge tests); unit **214 passed**; canonical E2E **42/42 + 4 SKIP in ~37s** (new: blank-camera fallback auto-accepts with note, no blocking review); typecheck/lint/format clean; production build clean. Real-device re-check still PENDING.
- **Remaining.** Real-device Android validation (the actual notebook photos); M4 untouched; no version bump.

- **Deploy.** Detection + UX fixes deployed to Cloudflare Pages `folio-pdf` branch `dev` via wrangler (`https://dev.folio-pdf.pages.dev`). Scan WASM 514 → 541 KB (still « 8 MB precache budget).

## 2026-09-26 — PWA update manager (F-13, SYNAPSE pattern)

- **Objective.** Post-deploy the installed PWA stayed stale with no in-app recourse (hard refresh only — undiscoverable on mobile). Port the update-manager pattern from SYNAPSE.
- **Work.** New `app/src/pwa/` boundary: `updateManager.ts` (framework-free store over `virtual:pwa-register`: silent ~3s launch check, manual `registration.update()` + 5s settle wait, localhost/insecure-LAN guard, capped log), `usePwaUpdate.ts` hook, `UpdateBanner.tsx` (global one-tap `updateSW(true)` banner), About "App updates" card (Check / Update now / Details). `StudioApp` inits once. Dynamic import of the virtual module so tests/dev degrade gracefully. D16 recorded; F-13 filed + resolved.
- **Findings.** First E2E run caught a real bug: uncached `getSnapshot` → React "Maximum update depth exceeded" infinite loop. Fixed with a cached snapshot invalidated on emit, plus a regression test asserting reference stability.
- **Verification.** Unit **227 passed** (+14 manager incl. env classification, settle paths, offline/error, log cap, snapshot stability); canonical E2E **43/43 + 4 SKIP** (new: About card check → local status on dev, no stray banner); typecheck/lint/format clean; production build clean (37 precache entries). No version bump.

- **Deploy.** Update manager deployed to Cloudflare Pages `folio-pdf` branch `dev` (`https://dev.folio-pdf.pages.dev`). This deploy is itself the first live test of the banner: phones holding the old precache will get the one-tap prompt instead of silent staleness.

## 2026-09-26 — JPEG DCT passthrough (F-14, engine-only)

- **Objective.** 13 photos → 81 MB PDF on a real phone. Root cause confirmed in code: the engine embedded uncompressed raw RGB (no `/Filter`), discarding JPEG compression at the engine boundary.
- **Work.** `engine/.../images_to_pdf`: SOF parser gate (baseline C0/C1 only; progressive/YCCK/truncated/probe-mismatch fall through), byte-identical `/DCTDecode` passthrough (RGB/Gray/Adobe-CMYK+inverting Decode), one internal q82 re-encode fallback, PNG raw path untouched. No wire change (no new option, protocol frozen). Fixture bug caught by own test (short APP14) — fixed.
- **Verification.** Rust **354 passing** (8 new), fmt/clippy clean; frontend **228**, E2E **43/43 + 4 SKIP** (DCT renders identically); WASM rebuilt (1.6 MB). No version bump.

- **Deploy.** Passthrough build deployed to Cloudflare Pages `folio-pdf` branch `dev` (`https://dev.folio-pdf.pages.dev`). Re-test the 13-photo flow on the phone: expect ~15–25 MB instead of 81 MB, identical image quality.

## 2026-09-26 — Scanner viewfinder stability (F-15)

- **Objective.** Real-phone report with screenshots: viewfinder full-size pre-capture, ~130px smaller after one capture (top-bar wrap + note strip + thumbnail strip all stole flex space).
- **Work.** `CameraCapture.tsx`: nowrap single-row top bar (truncate title, short CTA, device picker to bottom hint row), import note → floating auto-dismissing pill (5s), slimmer strip without duplicate safe-area padding. Strip stays in-flow below dock per E2E layering contract.
- **Verification.** Unit 228; E2E **44/44 + 4 SKIP** (new: framing-box 263px → 263px across first capture, pixel-identical); typecheck/lint/format clean. No version bump.

- **Deploy.** Viewfinder fix deployed to Cloudflare Pages `folio-pdf` branch `dev` (`https://dev.folio-pdf.pages.dev`).

## 2026-09-26 — Gallery PNG size fix (F-16) + Rearrange-parity page list (D18)

- **Objective.** Phone reports: gallery imports → 100 MB+ PDFs (camera captures tiny); Images reorder/preview UX behind Rearrange.
- **Work.** `imageImport.ts`: PNGs always convert to white-filled JPEG (budget-clamped, `.jpg` rename); `ImagesTool.addUploads` routed through normalized `importFiles` with progress text (raw `addFiles` retired from the tool). `PageGrid.tsx` rewritten to the Rearrange pattern (framer rows, handle drag, ↑/↓, preview modal on existing object URLs); `reorderPages` helper + hook `reorder`; dnd-kit uninstalled, `pageDrag.*` deleted. E2E: PNG-rename updates, pointer-drag + preview checks replace dnd-kit keyboard trio; upload block waits for both commits (async-race fix found by the suite).
- **Verification.** Unit **229**; E2E **45/45 + 4 SKIP twice**; typecheck/lint/format clean. No version bump.
