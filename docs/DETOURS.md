# Folio — Detours (Abandoned Approaches)

Only approaches verified in code, documentation, or git history are recorded. Speculative directions with no evidence are deliberately omitted.

## T-1 — Localhost HTTP processing bridge (Lesson 9)

- **What we tried.** Running the Rust engine as a local server process and calling it from the browser over localhost HTTP (protocol v1), so the browser could consume the real engine before any WASM build existed.
- **Why we tried it.** Fastest path to prove the browser ↔ engine protocol with real PDF semantics during engine development.
- **What happened.** The bridge worked and proved the protocol (documented in the root `ARCHITECTURE.md` Lesson 9 bridge sections: design, HTTP rationale, workflow, verification).
- **Problems discovered.** A localhost server must never be the application: it requires a `cargo run` sidecar, breaks the offline PWA story, adds install friction, and contradicts the static-site architecture.
- **Why abandoned.** `ARCHITECTURE.md` (Lesson 9 retrospective) verdict: the bridge proved the protocol but "must never be the application."
- **What replaced it.** `WasmWorkerEngineAdapter` + Web Worker + `wasm-pack` build (`npm run build:wasm`).
- **Current status.** No bridge code in the repository (verified by leftover sweeps for `localhost:*`, `FOLIO_BRIDGE_URL`, `dev_bridge`). History preserved in `ARCHITECTURE.md` only.

## T-2 — Browser-side PDF manipulation (`pdf-lib` + direct PDF.js writes)

- **What we tried.** The pre-engine production app manipulated PDFs with `pdf-lib` (`src/lib/pdf.ts`: merge/split/remove/reorder/rotate/compress) plus direct `pdfjs-dist` rendering and a bespoke render worker (`src/workers/pdfRender.worker.ts`).
- **Why we tried it.** It was the original implementation before the Folio engine existed.
- **What happened.** It shipped several releases (v1.0.0–v1.6.0 era) but could not meet the correctness, progress, cancellation, and large-file bars the engine was built for.
- **Problems discovered.** No unified operation model, no structured errors, no engine-authoritative timing, UI-thread processing.
- **Why abandoned.** Replaced wholesale during the v1.7.0 integration; the old files were deleted, the dependency removed.
- **What replaced it.** Rust/WASM manipulation via the engine; PDF.js kept for rendering only.
- **Current status.** Zero `pdf-lib` / `lib/pdf` / `pdfRender.worker` references in the tree (one comment in `folio.ts` documents the deletion). Verified by sweep.

## T-3 — Developer Testbench application

- **What we tried.** An interactive developer console (`?testbench` route, panels, stores) used during engine development to exercise operations manually.
- **Why we tried it.** Manual verification surface while building engine lessons.
- **What happened.** It served its purpose through engine development, then accumulated problems (unbounded `pastExecutions` history — see `docs/BUGS.md` F-4) and risked shipping dev code in the production bundle.
- **Problems discovered.** Dev-only UI bloat, unbounded state retention, production-bundle contamination risk.
- **Why abandoned.** Manual panels were superseded by automated tests + production E2E; the app was removed from the product (kept locally during transition, then deleted from the repo).
- **What replaced it.** Rust unit/integration tests, frontend unit tests, and the production E2E suite (25/25, real Chrome, real engine).
- **Current status.** No `testbench/` directory, route, HTML, or bundle strings (verified by tree + bundle scans). Legitimate automated tests preserved.

## T-4 — Separate `folio-engine` development directory

- **What we tried.** Building the engine in a standalone local directory alongside the `pdf-studio` UI repo during development.
- **Why we tried it.** Iteration speed while the engine API was still churning.
- **What happened.** The engine matured there (lessons 0–14), but two directories meant two sources of truth and a fragile transplant workflow.
- **Why abandoned.** The project requires a single repository that builds from a fresh clone with the engine source inside it.
- **What replaced it.** Unified repository: `src/`, `wasm/`, `tests/`, `examples/` committed alongside `frontend/` (v1.7.0, commit `d76a22e`).
- **Current status.** No second repository required; fresh-clone verification is the standing proof.

## T-5 — Production-only WASM integration (commit `866761f`)

- **What we tried.** Integrating Folio as a consumed compiled WASM package: the commit replaced the production tree with engine-built output and UI, without the engine source layout the project requires.
- **Why we tried it.** Misunderstanding of the target architecture (consumer integration vs. unified source repository).
- **What happened.** Pushed as `866761f`, then identified as the wrong architecture.
- **Problems discovered.** Repository contained generated artifacts rather than the engine source of truth; not independently buildable/testable at the Rust layer.
- **Why abandoned.** Violated the single-source-of-truth requirement (see `docs/DECISIONS.md` D11).
- **What replaced it.** Exact revert (`390194a`, byte-faithful to `ffa87c8`) followed by the correct unified integration (`d76a22e`).
- **Current status.** Preserved in git history as a warning; history was not rewritten.
