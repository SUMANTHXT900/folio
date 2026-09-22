# Folio — Architecture Decisions

Each entry records the decision, its reason, alternatives considered where known, consequences, and status. Where rationale was not recorded at decision time, that is stated explicitly instead of reconstructed.

## D1 — Rust owns PDF manipulation

- **Decision.** All document mutation (parse, copy, reorder, rotate, split, merge, metadata write, image-to-PDF construction) lives in the Rust engine (`engine/src/processing/pdf/` on `lopdf`). TypeScript never mutates PDF bytes.
- **Reason.** One verified implementation shared by native tests, CLI examples, and the browser build; precise control over copies for large documents; `lopdf` is pure-Rust with no OS dependencies.
- **Alternatives considered.** `pdf-lib` in TypeScript (used by the pre-engine app; removed — see `docs/DETOURS.md`).
- **Consequences.** A WASM build step is mandatory for frontend work (`npm run build:wasm`); engine changes require Rust + TypeScript contract updates together.
- **Status.** Decided, implemented, verified (345 Rust tests + E2E).

## D2 — PDF.js is rendering-only

- **Decision.** PDF.js (`pdfjs-dist`) renders pages to canvas, generates thumbnails, and provides page-count intake. It never mutates documents.
- **Reason.** Reimplementing a renderer in Rust would be a second project; PDF.js is battle-tested for rendering while the old manipulation uses of it were replaced by the verified engine.
- **Alternatives considered.** Rendering from Rust (rejected: out of scope unless the engine architecture explicitly requires it).
- **Consequences.** Two PDF libraries coexist on purpose with a hard boundary; contributors must not route manipulation through PDF.js APIs.
- **Status.** Decided, implemented, verified.

## D3 — Web Worker isolates engine execution

- **Decision.** The engine runs in a dedicated Web Worker (`engine.worker.ts`) behind `WasmWorkerEngineAdapter`; heavy work never blocks the main thread.
- **Reason.** Large-document operations (500 MB class) would freeze the UI on the main thread; the worker boundary also enforces the binary-ownership discipline.
- **Alternatives considered.** Localhost HTTP bridge (Lesson 9 prototype; abandoned — see `docs/DETOURS.md`). Main-thread WASM (rejected for UI responsiveness).
- **Consequences.** All engine traffic is async message-passing with a typed protocol; debugging spans two threads.
- **Status.** Decided, implemented, verified (E2E cancellation + progress across the boundary).

## D4 — ExecutionEngine owns authoritative timing

- **Decision.** `engineDurationMs` is measured monotonically inside the engine and reported with the result; the UI displays but never computes durations.
- **Reason.** UI-side timing includes queueing and rendering noise; only the engine knows how long the operation itself took.
- **Alternatives considered.** Rationale not recorded beyond the engine-authority principle (`types/engine.ts`: "The engine remains authoritative").
- **Consequences.** WASM needs a JS-backed monotonic clock (`js-sys`) because `std::time` panics on `wasm32-unknown-unknown` (see `docs/LESSONS.md`).
- **Status.** Decided, implemented, verified.

## D5 — Binary ownership rules

- **Decision.** PDF bytes live in module-level stores, never in React state; outputs transfer by reference with immediate release; bytes cross the worker boundary as `Uint8Array`, never base64/JSON.
- **Reason.** React state copies and base64 inflation are fatal at 500 MB scale; the rules make large-file handling structural rather than aspirational.
- **Alternatives considered.** Rationale not recorded; the rules emerged from large-file testing (Lessons 12–14 per `folio.ts` comments).
- **Consequences.** Components hold `{id, name, sizeBytes, pageCount}` only; every new feature touching bytes must follow the store discipline.
- **Status.** Decided, implemented, verified (large-file E2E).

## D6 — Bounded / windowed large-file processing

- **Decision.** Thumbnails render in windows (24 pages) with concurrency 2; the object-URL cache is LRU-bounded (6 documents); canvases release on encode; events are not retained unboundedly.
- **Reason.** A 2585-page document must never materialize 2585 canvases, URLs, or DOM nodes.
- **Alternatives considered.** Rationale not recorded; established through the v1.2.x–v1.5.0 rendering work (single-doc load, blob-URL thumbs, windowed rendering per git history).
- **Consequences.** Thumbnail hooks expose windowed APIs with holes + background fill; E2E asserts the bound (24 images for the 2585-page file).
- **Status.** Decided, implemented, verified.

## D7 — Structured errors end to end

- **Decision.** One `ErrorCode` enum (11 variants) travels Rust → wire strings → TypeScript, with friendly UI mapping that preserves the code and the raw engine message.
- **Reason.** Users need actionable messages ("Those page numbers are not valid"), developers need codes and engine detail; neither alone suffices.
- **Alternatives considered.** Rationale not recorded.
- **Consequences.** New failure modes need new codes or explicit mapping into existing ones; the UI `ErrorBlock` contract (friendly + engine detail + subtle code) must be preserved.
- **Status.** Decided, implemented, verified (E2E structured range error).

## D8 — Cooperative cancellation as a first-class status

- **Decision.** `cancelled` is a terminal execution status with its own error code (`CANCELLED`), surfaced honestly in the UI — never faked, never swallowed.
- **Reason.** Long operations on large files must be stoppable; a cancel button that does not cancel destroys trust.
- **Alternatives considered.** Rationale not recorded.
- **Consequences.** Operations declare `supports_cancellation`; the studio job races cancel-before-handle; thumbnail jobs cancel independently; E2E asserts the honest UI path.
- **Status.** Decided, implemented, verified.

## D9 — Engine API stability (frozen contract)

- **Decision.** The engine ↔ TypeScript contract (`OperationId`s, options, summaries, error wire strings) is stable: the production integration treated the engine as frozen and adapted the UI to it, not the reverse.
- **Reason.** Stability lets the UI, tests, and E2E rely on the contract while engine internals evolve.
- **Alternatives considered.** Rationale not recorded beyond the integration approach (UI-only changes during production integration).
- **Consequences.** Engine changes that alter the wire contract require coordinated TypeScript + test + E2E updates.
- **Status.** Decided, in effect since v1.7.0 integration.

## D10 — Local processing architecture

- **Decision.** No PDF-processing backend exists or may be added implicitly: core processing runs in-browser via Rust/WASM; the app is a static site (Cloudflare Pages, hash routing).
- **Reason.** The product's privacy claim is architectural, not policy-based — there is nowhere for documents to be uploaded to.
- **Alternatives considered.** Localhost server bridge (abandoned), native shells (no evidence of adoption — not claimed).
- **Consequences.** All compute budgets are the user's device; messaging must stay accurate (see `docs/PROJECT.md` privacy model).
- **Status.** Decided, implemented, verified (0 external requests in instrumented runs).

## D11 — Unified repository

- **Decision.** The Folio Rust engine source, WASM bridge, Rust tests, examples, and production frontend live in one repository (`SUMANTHXT900/folio`, branch `dev`) that builds from a fresh clone. Generated WASM is never a substitute for source.
- **Reason.** A production-only integration (compiled WASM without engine source, commit `866761f`) was reverted precisely because the repository must be independently buildable and the engine independently testable.
- **Alternatives considered.** Separate engine repository (rejected: splits source of truth, doubles release coordination). Compiled-WASM-only integration (tried as `866761f`, reverted as `390194a`).
- **Consequences.** Fresh-clone verification is mandatory after integration work; `wasm/pkg/` stays gitignored and reproducible.
- **Status.** Decided, implemented, verified (fresh-clone full suite green).

## D12 — Project-oriented filesystem layout without a Cargo workspace

- **Decision.** The repository is organized by ownership: `engine/` (Rust engine: `src/`, `tests/`, `examples/`, `Cargo.toml`, `Cargo.lock`), `wasm/` (bridge: `src/`, `Cargo.toml`, path-dependency on `../engine`), `app/` (entire frontend tree verbatim), `docs/` (project memory), root (repository-wide files only: `README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `LICENSE`, `.gitignore`, `.gitattributes`). No Cargo workspace was introduced; `engine/` and `wasm/` keep the independent manifests and lockfiles they had before the move.
- **Reason.** Organizational clarity: the layout communicates ownership (`engine` = PDF processing, `wasm` = browser bridge, `app` = product application, `docs` = project memory) without changing the build model. A workspace was not required — nothing spans manifests — so introducing one would have been architecture churn for no benefit.
- **Alternatives considered.** Cargo workspace root (`members = ["engine", ...]`) to preserve root-level `cargo` commands; rejected because it changes the dependency model (shared lockfile, possible `wasm` inclusion in host test scope) while the same workflow is served by documenting `cd engine` in `docs/DEVELOPMENT.md`.
- **Consequences.** Rust commands run in `engine/`; frontend commands run in `app/`; the `wasm` bridge needed exactly one functional change (path dependency `..` → `../engine`); the corpus example's default discovery dir became `../test pdfs` (overridable with `--dir`). Relative-depth-sensitive references (`../../../wasm/pkg` worker import, `../../test pdfs` E2E corpus, `../wasm` build script, `fs.allow: ['..']`) survived unchanged because the move preserved directory depth.
- **Status.** Decided, implemented and verified in Phase 2 (full suite green from the new structure; 25/25 E2E).
