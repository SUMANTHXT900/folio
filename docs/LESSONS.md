# Folio — Lessons (Reusable Engineering Knowledge)

Each lesson states the observation, why it matters, and the resulting rule. All lessons are grounded in this repository's code or verified behavior.

## L-1 — `std::time` panics on WASM; clocks must be platform-abstracted

- **Observation.** `std::time::{SystemTime, Instant}` panic on `wasm32-unknown-unknown` (verified against the toolchain's `sys/pal/wasm`); the engine needs wall-clock timestamps and monotonic durations on both targets.
- **Why it matters.** Authoritative engine timing (`engineDurationMs`) is a core contract — without a WASM clock it cannot exist in the browser build.
- **Rule.** Clock access goes through `src/core/clock.rs`; WASM builds use JS-backed clocks via the `js-sys` dependency gated behind `target.'cfg(target_arch = "wasm32")'`. Never call `std::time` directly in engine code paths that run on WASM. Evidence: `Cargo.toml` comments.

## L-2 — PDF.js neuters input buffers; copy at the rendering boundary

- **Observation.** PDF.js detaches (neuters) the `ArrayBuffer` handed to `loadDocument`. Sharing the studio store's buffer with the renderer destroys the document bytes.
- **Why it matters.** Silent data destruction one API call away from every document open.
- **Rule.** The rendering engine always loads from a defensive copy; the byte store keeps the original. Evidence: `frontend/src/rendering/PdfJsRenderEngine.ts` (~line 128).

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
- **Rule.** `wasm/pkg/` stays gitignored and reproducible via `npm run build:wasm`; `src/`, `wasm/src/`, `tests/`, `examples/` are the tracked source. Fresh-clone verification is mandatory after integration work. Evidence: `.gitignore`; `docs/DETOURS.md` T-5.

## L-8 — Fresh-clone verification catches what worktree verification misses

- **Observation.** The v1.7.0 integration verification caught two worktree-only illusions: a stale dev server from a prior session serving E2E's port, and CRLF checkouts breaking `format:check` on fresh clones (fixed with `.gitattributes` `eol=lf`).
- **Why it matters.** "Works on my machine" includes "works in my worktree." Only a fresh clone proves reproducibility.
- **Rule.** After integration work: commit, push, clone to a temp directory, and run the full suite there. Verify server process identity (path/PID) before trusting E2E results. Evidence: `docs/WORKLOG.md` v1.7.0 entries.

## L-9 — History must not be rewritten to hide mistakes

- **Observation.** The incorrect `866761f` integration was fixed by exact revert (`390194a`, empty diff vs `ffa87c8`) plus a correct commit on top — no reset, no force-push. The mistake and its correction are both visible.
- **Why it matters.** Future agents need to see what was tried and why it failed (see `docs/DETOURS.md` T-5); rewritten history destroys that evidence and risks force-push damage to shared branches.
- **Rule.** Prefer revert-on-top for pushed mistakes. Never `--force` push, never touch `main` from feature work.
