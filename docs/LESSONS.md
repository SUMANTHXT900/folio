# Folio — Lessons (Reusable Engineering Knowledge)

Each lesson states the observation, why it matters, and the resulting rule. All lessons are grounded in this repository's code or verified behavior.

## L-1 — `std::time` panics on WASM; clocks must be platform-abstracted

- **Observation.** `std::time::{SystemTime, Instant}` panic on `wasm32-unknown-unknown` (verified against the toolchain's `sys/pal/wasm`); the engine needs wall-clock timestamps and monotonic durations on both targets.
- **Why it matters.** Authoritative engine timing (`engineDurationMs`) is a core contract — without a WASM clock it cannot exist in the browser build.
- **Rule.** Clock access goes through `engine/src/core/clock.rs`; WASM builds use JS-backed clocks via the `js-sys` dependency gated behind `target.'cfg(target_arch = "wasm32")'`. Never call `std::time` directly in engine code paths that run on WASM. Evidence: `engine/Cargo.toml` comments.

## L-2 — PDF.js neuters input buffers; copy at the rendering boundary

- **Observation.** PDF.js detaches (neuters) the `ArrayBuffer` handed to `loadDocument`. Sharing the studio store's buffer with the renderer destroys the document bytes.
- **Why it matters.** Silent data destruction one API call away from every document open.
- **Rule.** The rendering engine always loads from a defensive copy; the byte store keeps the original. Evidence: `app/src/rendering/PdfJsRenderEngine.ts` (~line 128).

## L-3 — Thumbnails are in-memory liabilities; bound everything

- **Observation.** Canvases, object URLs, and DOM nodes scale with page count unless explicitly bounded. A 2585-page document will happily create 2585 of each.
- **Why it matters.** Tab crashes and runaway memory on exactly the large files Folio promises to handle.
- **Rule.** Windows (24 pages), concurrency 2, LRU URL cache (6 documents), canvas release on encode, MIME fallback chain (WebP → JPEG → PNG). Never materialize a whole huge document's thumbnails. Evidence: `folio.ts` thumbnail section; large-file E2E asserts 24 images for 2585 pages.

## L-4 — Unbounded retention is a bug, even in dev tools

- **Observation.** The former Testbench's unbounded `pastExecutions` map retained full event histories until the DOM and memory suffered.
- **Why it matters.** Retention defaults compound: what starts as "useful history" becomes a leak at scale.
- **Rule.** Every retention structure needs an explicit bound or lifetime (per-job event lists, LRU caches, close/release paths). Production paths retain nothing unbounded. Evidence: `docs/BUGS.md` F-4.

## L-5 — Progress must be engine data, never UI computation

- **Observation.** The v1.7.0 integration had to fix the Merge progress scale and per-tool completion UX: UI-computed progress misreported what the engine was actually doing.
- **Why it matters.** Dishonest progress destroys trust faster than no progress.
- **Rule.** Render `percentage`/`message` from engine events directly (`message ?? phase` as label). If the engine reports no percentage, show an indeterminate label — never synthesize a fraction. Evidence: `folio.ts` event subscription; E2E asserts real progress labels.

## L-6 — Cancellation must be designed, not appended

- **Observation.** Cancel-before-handle races and surviving thumbnail jobs made cancellation untrustworthy until the lifecycle was designed explicitly (flag + handle race, per-document thumbnail tracking, terminal `CANCELLED` status).
- **Why it matters.** A cancel button that does not cancel is worse than none — the user believes work stopped while it continues.
- **Rule.** Every cancellable job exposes `cancel()`; cancellation is a terminal status with its own code and message, asserted in E2E. Evidence: `docs/BUGS.md` F-5; E2E "merge cancellation surfaces honestly in UI".

## L-7 — Generated WASM is an artifact, never the source of truth

- **Observation.** The `866761f` production-only integration shipped compiled output without engine source and had to be reverted: the repository could not build or test the Rust layer from a fresh clone.
- **Why it matters.** Artifacts rot; source builds. A repo that cannot reproduce its own engine is not a source of truth.
- **Rule.** `wasm/pkg/` stays gitignored and reproducible via `npm run build:wasm`; `engine/src/`, `wasm/src/`, `engine/tests/`, `engine/examples/` are the tracked source. Fresh-clone verification is mandatory after integration work. Evidence: `.gitignore`; `docs/DETOURS.md` T-5.

## L-8 — Fresh-clone verification catches what worktree verification misses

- **Observation.** The v1.7.0 integration verification caught two worktree-only illusions: a stale dev server from a prior session serving E2E's port, and CRLF checkouts breaking `format:check` on fresh clones (fixed with `.gitattributes` `eol=lf`).
- **Why it matters.** "Works on my machine" includes "works in my worktree." Only a fresh clone proves reproducibility.
- **Rule.** After integration work: commit, push, clone to a temp directory, and run the full suite there. Verify server process identity (path/PID) before trusting E2E results. Evidence: `docs/WORKLOG.md` v1.7.0 entries.

## L-9 — History must not be rewritten to hide mistakes

- **Observation.** The incorrect `866761f` integration was fixed by exact revert (`390194a`, empty diff vs `ffa87c8`) plus a correct commit on top — no reset, no force-push. The mistake and its correction are both visible.
- **Why it matters.** Future agents need to see what was tried and why it failed (see `docs/DETOURS.md` T-5); rewritten history destroys that evidence and risks force-push damage to shared branches.
- **Rule.** Prefer revert-on-top for pushed mistakes. Never `--force` push, never touch `main` from feature work.

## L-10 — Cancel observation lags the token by one decode checkpoint

- **Observation.** The audit benchmark flips the cancel token 50 ms into a heavy `images_to_pdf` run, but the engine observes it ~190–270 ms later (benchmark report): cancellation checkpoints sit between per-image decodes, so one in-flight single-image decode bounds the latency.
- **Why it matters.** UI cancel budgets must absorb the worst case, not the token-flip time — a 50 ms UI promise is broken by design on photo-scale images.
- **Rule.** Place cancellation checkpoints at every lane boundary, document the residual bound (one decode), and never promise sub-decode cancel latency. Evidence: `engine/examples/audit_bench_matrix.rs` (`bench_cancel_at_50ms`) + `engine/tests/audit_cancel_midrun.rs`.

## L-11 — A throwing `waitForFunction` predicate kills the poller silently

- **Observation.** Puppeteer runs `waitForFunction` predicates inside an in-page poller loop; when the predicate throws, the loop dies and the wait idles to its full timeout with a `TimeoutError` and no hint of the real cause. The 2026-10-03 scanner E2E hung 120 s on `b !== null && !b.disabled` where `find()` had returned `undefined` (the button legitimately read "Building…" at that moment) — `undefined !== null` passed and the property access threw.
- **Why it matters.** A silently-dying poller looks exactly like an app hang; the default debugging instinct (blame the app) cost a multi-run bisection before a temporary state-dumping poll revealed the app had built the PDF in ~2 s.
- **Rule.** `waitForFunction` predicates must be total functions: never dereference a possibly-undefined `find()`/`querySelector` result without an explicit guard (`if (b === undefined || …) return null;`). When a wait times out, first re-run the predicate via `page.evaluate` to surface its exception. Evidence: `app/e2e/studio.e2e.mjs` (build-entry wait).

## L-12 — A single-evaluate E2E drag-measure always reads pre-React-flush DOM

- **Observation.** The 8-handle crop-editor E2E (`exerciseCropHandles`) dispatched pointerdown/move/up and read the handle center in ONE `page.evaluate` — synchronously, before React flushed `setQuad` — so `cornerDrag` was always false while the app was actually fine (plain-DOM probes passed; handles rendered; keyboard focus passed). The pre-wave helper never caught this because it asserted only `document.activeElement === tr` (focus), never movement.
- **Why it matters.** A sync dispatch-then-measure conflates "React hasn't re-rendered yet" with "drag is broken" — the test fails forever with a plausible-looking `moved:false` payload, inviting app-side "fixes" (immediate-move emission, `isPrimary` guards) that change production behavior to satisfy a test artifact.
- **Rule.** Dispatch and measure must round-trip through Node: dispatch in one evaluate, `waitForFunction` on the post-condition (total predicate per L-11), measure in a later evaluate. Assert movement (position/aria-valuenow delta), never just focus. Evidence: `app/e2e/studio.e2e.mjs` `exerciseCropHandles` (2026-10-04 rewrite; 64/66 → 66/66 with zero app-code change).

## L-13 — A custom device-dependent pipeline can lose to a focused external library

- **Observation.** Three detection-recall rounds (D29, D30, D32) plus the D31 effort reallocation (1200px detection, background processing) kept the canonical E2E suite green (59/59 → 61/61 → 69/69 → 66/66) while F-21's field hit-rate gate never closed — automation could not see the device-dependent reality, and the pivot to scanic (D33) replaced the pipeline instead of funding a fourth round.
- **Why it matters.** Green suites measure what they can stage; perception-heavy, device-dependent problems (AF/AE timing, shadows, glare, patterned backgrounds) live outside that staging. Sunk effort in a custom pipeline is not evidence the next round will move the field number.
- **Rule.** Prefer proven external libraries for perception-heavy problems; keep the fine-grained E2E discipline for what automation can honestly assert, and let real-device hit-rate gates — not suite greenness — decide when a custom pipeline continues. Evidence: `docs/BUGS.md` F-21; `docs/DECISIONS.md` D29–D33.

## L-17 — Ship the detector that works as the default

- **Observation.** D34 shipped classical detection as the default with the ML pipeline behind an explicit opt-in toggle; user-verified field feedback on D34 showed the ML pipeline superior, so D35 made ML the default with classical as silent fallback and deleted the toggle.
- **Why it matters.** An opt-in toggle for the better pipeline is a dark pattern that guarantees field failure — most users never find the toggle, so the field runs the worse pipeline by default.
- **Rule.** Ship the detector that works as the default; an opt-in toggle for the better pipeline is a dark pattern that guarantees field failure. Evidence: `docs/DECISIONS.md` D34/D35; `docs/BUGS.md` F-21 (field gate re-armed on scanic).

## L-16 — Gate E2E waits on the control you will click, in the phase that renders it

- **Observation.** The D34 scanic E2E failed three checks with zero app defects: (1) the suite waited for `[data-scanner-root]` (renders on open) then immediately read/clicked `[data-scan-capture]`, which renders only when the camera is LIVE (~1s later) — the evaluate saw shutter:null and the first capture no-op'd; (2) it waited for `[data-scan-queue]` right after capture, but the queue renders only in review phase — the camera-phase strip is `[data-scan-strip]`; (3) scanic's default keyboard step is 1px and can land sub-pixel, so a whole-pixel post-condition never trips — holding Shift takes the same slider path at the 10px coarse step.
- **Why it matters.** Each reads exactly like a dead feature (null payload, timeout, moved:false) and each invites an app-side "fix" to satisfy a test artifact. The app was live, queued, and stepping correctly in every case — proven by a plain-DOM probe and by the green rerun with E2E-only changes.
- **Rule.** Wait for the exact control the next step touches (not its parent surface), and assert phase-scoped selectors only in their phase. Prefer coarse/keyboard steps that clear whole-pixel post-conditions. Evidence: `app/e2e/studio.e2e.mjs` D34 fixes (45/48 → 48/48, zero app-code change).

## L-18 — A dev-only asset failure can masquerade as dead UI (and a null result is not a throw)

- **Observation.** Two stacked causes behind the D35 run's 54/56: (1) Vite's dev middleware 500s any source-code _import_ of a `public/` file, so ORT's runtime dynamic import of the vendored `.mjs` loader painted a fullscreen `vite-error-overlay` in dev only (production serves it statically and never failed). The empty overlay eats trusted-mouse hit-testing while synthetic dispatches sail through — so programmatic clicks passed and only the real-mouse drag died, the exact signature of a broken drag handler. Diagnosed via `elementFromPoint` + the dev-server log, fixed with a 15-line `serve`-only middleware (see `app/vite.config.ts` `scanicMlDevLoader`); production untouched. (2) With ML actually running, it _honestly_ returned no-document on the synthetic Y4M square — and the inline runtime only fell back to classical on throws, never on null. The Y4M square the old suite detected fine went overlay-less with dead edge-clamped handles. Fix: null-means-missed — ML-null runs classical once before settling full-frame, in both the inline path and the (already-correct) worker core; pinned by a dedicated unit test.
- **Why it matters.** (1) Dev/prod asset asymmetry is invisible to every gate except a real browser: typecheck, lint, unit, and build all stayed green while dev-only ML silently ran classical. (2) Treating "no result" as success short-circuits detector cascades — every fallback policy must trigger on null results, not just exceptions.
- **Rule.** Vendored runtime-loaded assets need a dev-serving story verified in a real browser (not just a passing build); detector fallbacks trigger on null/empty results exactly like on throws. Evidence: `app/vite.config.ts`, `ScanicCapture.tsx` detectEntry, D35 54/56 → 56/56.

## L-19 — Copy the interaction grammar users already know

- **Observation.** The D36 redo replaced the D35 overlay-hero review (photo + ML-found quad as the hero) with the Google-Drive-scan pattern the user supplied screenshots of: capture → processed-result review → crop-as-mode → batch commit.
- **Why it matters.** Novelty in scan UX reads as brokenness — the D35 overlay hero made the raw photo + quad the chore instead of showing what you get.
- **Rule.** Copy the interaction grammar users already know (capture → processed review → crop-as-mode → batch commit); novelty in scan UX reads as brokenness. Evidence: user-supplied Drive screenshots analyzed 2026-10-04 vs D35 overlay-hero rejection; `docs/DECISIONS.md` D36.

## L-14 — Vite `server.fs.allow` overrides the default app-root allowance

- **Observation.** The D33 strip agent narrowed `vite.config.ts`'s `server.fs.allow` from `['..']` to `['../wasm']` while removing the deleted `scan/pkg` allowance. Because an explicit `fs.allow` list _replaces_ Vite's implicit allowance of the project root, every dev-server request for the app's own files (`index.html`, `/assets/...`) returned `403 Restricted — outside of Vite serving allow list`; the app never mounted (empty `#root`, zero links) and the canonical E2E died at the first `a[href="#/merge"]` wait with no console errors to point at it. Unit tests, typecheck, and lint all stayed green — only the real browser saw it.
- **Why it matters.** A config list that _adds_ an allowance looks identical to one that _replaces_ the default; the failure mode (every page 403) reads like a hosting/CDN problem, not a config typo. Only a live browser probe (body text = the Vite 403 page) located it in one step.
- **Rule.** Any explicit Vite `server.fs.allow` must re-list the app root (`.`) alongside external paths; after trimming allow lists, smoke-test the dev server in a real browser, never trust unit greenness for serving-layer changes. Evidence: `app/vite.config.ts` (D33 fix, `allow: ['.', '../wasm']`).

## L-15 — Parallel agents need exclusive file ownership plus a contract stated up front

- **Observation.** The D34 scanic wave ran five agents concurrently with exclusive file ownership (docs agent writes docs-only; vendor/worker/UI/E2E on disjoint sets) and locked integration contracts (versions, vendor path, quality policy, precache cap) fixed before editing started. The P0/P2/D21/D30–D33 waves used the same shape (parallel agents on disjoint file sets, central integration).
- **Why it matters.** Concurrent edits to shared files merge-conflict or silently contradict; contracts decided mid-wave force rework across every agent.
- **Rule.** One owner per file set, no cross-writes; lock integration facts in the brief; verification numbers are filled by the orchestrator, never invented by agents. Evidence: the D34 spawn brief (Agent G docs-only ownership); `docs/WORKLOG.md` D34 entry and prior multi-agent entries.

## L-20 — Eight handles beat four; a result view shows exactly one canvas

- **Observation.** Eight handles beat four for precise adjust — D32 proved rigid whole-edge midpoints, D35 regressed to corners-only, D37 restores them; and a result view shows exactly one canvas (the verdict), never the evidence beside it.
- **Why it matters.** Four corner dots cannot push an edge straight without shearing it, so precise adjust needs whole-edge midpoints that translate the full edge by one clamped delta; and a review hero that shows the photo beside the result makes the raw evidence the chore instead of showing what you get — the Use-original path is a verdict state (photo + unprocessed chip), not a second canvas.
- **Rule.** Adjust modes ship 8 handles (4 corners + 4 convexity-guarded whole-edge midpoints, 44px targets); result views render exactly one canvas (the warped verdict, eager-warped so it is never empty). Evidence: `docs/DECISIONS.md` D32/D37; `app/e2e/studio.e2e.mjs` D37 8-handle + whole-edge checks; `app/src/studio/tools/ScanicReview.tsx` (Use-original verdict with unprocessed chip).

## L-21 — Request the frame you display

- **Observation.** A landscape capture on a portrait phone poisons every downstream surface (viewfinder ratio, layout stability, letterbox bars, handle alignment) — all four were downstream of landscape frames.
- **Why it matters.** Fixing any one surface leaves the poisoned source in place; each downstream fix re-breaks the moment the frame shape changes.
- **Rule.** Request the frame you display: set portrait ideals at the constraint level so all four surfaces are fixed at the source. Evidence: `docs/DECISIONS.md` D38 (user phone screenshots 2026-10-04).

## L-22 — Fill the viewfinder; loupe the handles

- **Observation.** D39 shipped a fullscreen edge-to-edge viewfinder (video fills the surface, chrome floats over scrims — no bars by construction) and a grab/focus magnifier loupe (circular 2.5x zoom scope with centered crosshair tracking the active corner) while handle visuals stayed dotted-thin with 44px hits preserved.
- **Why it matters.** A viewfinder must fill its surface — any boxed preview reintroduces bars, ratio math, and shift bugs; full-bleed cover plus floating chrome deletes the whole category. And precision handles need a loupe, not bigger dots.
- **Rule.** Viewfinders fill their surface (full-bleed cover + floating chrome, never a boxed preview); precise adjust gets a loupe, never enlarged dots. Evidence: `docs/DECISIONS.md` D39 (user phone feedback 2026-10-04).

## L-23 — Never gate navigation on acceptance

- **Observation.** D40 deleted the per-page Looks-good accept-click: every queued page auto-accepts its current crop (warped when available, else original) and navigation runs via filmstrip/pager/batch-Next with no accept gate.
- **Why it matters.** Viewing a fine page IS the verdict; forced accept-clicks tax every page to protect against a discard case users already have.
- **Rule.** Never gate navigation on acceptance — viewing a fine page IS the verdict. Evidence: `docs/DECISIONS.md` D40 (user phone feedback 2026-10-04).

## L-24 — jsdom never hit-tests, so pointer-events bugs ship green

- **Observation.** The camera picker sat under a `pointer-events-none` ancestor with no opt-back-in: dead to every real touch, yet all 47 unit tests passed because `fireEvent` bypasses hit-testing entirely. Found only by reading the ancestor chain (`ScanicCapture.tsx` topbar), never by any suite.
- **Why it matters.** A whole class of mobile breakage (pointer-events, z-order, overlay coverage) is invisible to jsdom and to synthetic E2E dispatches — only trusted-input probes and real phones see it.
- **Rule.** Any control added under an overlay/portal must carry an explicit hit-test assertion (computed `pointer-events`, `elementFromPoint` in E2E); icon-only toggles additionally need visible labels. Evidence: `docs/DECISIONS.md` D43 (user phone feedback 2026-10-04).

## L-25 — Render and drag must measure the same rect

- **Observation.** The adjust overlay positioned from async-measured `frameBox` STATE while drag mapped through a live `getBoundingClientRect()` — any layout shift between them offset every handle and sheared the stretched SVG. Fix: measure synchronously in render with state as fallback, so both paths share one rect; and don't render the overlay until the rect exists.
- **Why it matters.** Two rect sources that agree "almost always" disagree exactly when the user is interacting (scroll, DVH shift, resize) — the drift reports always look like warp bugs but live in the overlay.
- **Rule.** One live rect source for render + pointer mapping; gate overlay rendering on its presence. Evidence: `docs/DECISIONS.md` D43 (user phone feedback 2026-10-04).
