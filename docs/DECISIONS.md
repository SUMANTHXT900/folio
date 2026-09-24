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

## D13 — Large external PDFs are optional benchmark inputs, not canonical fixtures

- **Decision.** Large real-world PDFs (e.g. the ~514 MB / 2585-page file used during engine development) are developer-owned, optional benchmark/stress-test inputs. They live only in the gitignored local `test pdfs/` directory, are never committed, and are never required for canonical validation. The canonical E2E suite (`app/e2e/studio.e2e.mjs`) passes from a fresh clone without them (deterministic synthetic small fixtures via `app/e2e/corpus.mjs`; large-file sections SKIP explicitly with exit-0 semantics). `e2e/large-files.e2e.mjs`, `e2e/thumbnail.e2e.mjs`, and `e2e/metadata.e2e.mjs` are optional suites that run only when the corpus is present and SKIP cleanly otherwise.
- **Reason.** Large binaries destroy repository portability (hundreds of megabytes per clone), cannot be provenance-cleaned or licensed casually, and make fresh-clone reproducibility depend on a private collection. Correctness coverage belongs to deterministic in-repo fixtures (345 Rust tests, 134 frontend tests, synthetic E2E PDFs); scale/stress evidence belongs to opt-in local runs.
- **Alternatives considered.** Committing small representative PDFs as fixtures (rejected for now: the synthetic writer covers the canonical shapes with zero bytes in git; revisitable if a real-world byte pattern ever proves necessary). Restoring the old corpus to satisfy the previous Phase 3 prompt (rejected: that corpus was early performance/stress data, never intended as a mandatory fixture).
- **Consequences.** Fresh-clone validation, CI, production builds, and normal development never touch `test pdfs/`; historical large-file results stay recorded as benchmark evidence (`docs/WORKLOG.md`, root `ARCHITECTURE.md` log) rather than live suite requirements; E2E output distinguishes PASS / SKIP (optional corpus unavailable) / FAIL and never merges them into one number.
- **Status.** Decided, implemented and verified in Phase 3 (canonical suite green without the corpus; optional suites SKIP with exit 0).

## D14 — Images → PDF page assembly: unified collection, camera as input, app-side rotation

- **Decision.** The Images → PDF tool owns a unified ordered page collection (`ImagePage[]`: stable UI id, `upload | camera` source tag, `File`/`Blob` handle, name/size, preview object URL, `rotationDeg`). Uploads and camera captures enter the same array; page N of the PDF is `pages[N-1]` because the build loop stages pages in collection order into the unchanged `pdf.images_to_pdf` engine. Reorder (←/→ move buttons guaranteed; HTML5 drag as progressive enhancement only), remove, add-more, and rotate are array operations plus preview-URL hygiene — zero binary copies. Rotation is applied app-side at build time via canvas re-encode (only for rotated pages; unrotated pages take the byte-identical direct path), keeping the engine contract frozen. Camera (`getUserMedia` → `<video>` → canvas JPEG capture) is an input source producing `File`s, with per-error-name failure copy and stream-stop on Done/close/unmount.
- **Reason.** Ordering is inherently app-level (the engine already preserves input order sequentially); a separate camera pipeline would duplicate the build path; engine-side rotation would change the Rust options struct + WASM glue + wire types for a presentation concern. Move buttons were chosen as the guaranteed mechanism because grid drag-and-drop fights single-axis reorder libraries and is unreliable on touch.
- **Alternatives considered.** Engine `rotation_deg` option (rejected: contract churn, revisit if lossless rotation is ever required). framer-motion `Reorder` grid drag as primary (rejected: single-axis library vs wrapping grid; buttons primary, native HTML5 drag as desktop-only enhancement).
- **Consequences.** No changes to `folio.ts`, adapters, worker protocol, WASM glue, or Rust. Preview URLs must be revoked on remove/clear/unmount (hook-owned). Large collections are bounded by engine-side decoded-RGB memory (pre-existing ceiling, not redesigned).
- **Status.** Decided, implemented and verified in v1.8.0 (134 frontend tests incl. 16 new page-logic tests, canonical E2E 25/25 + 4 SKIP with reorder/rotate/remove/add assertions).

## D15 — Scan integration: review-before-accept, live-guidance-only, Original preserved

- **Decision.** Captures in scan modes resolve into a session-local review (processed preview + Use scan / Use original / Retry / Retake) — nothing enters `ImagePage[]` unconfirmed. Live detection (~160px frames, 500 ms ticks, skipped while busy) drives only the "Document detected" framing hint; the shutter always runs fresh full-resolution detection and live corners are never reused for the final warp. Original mode bypasses the worker entirely (v1.9 direct capture preserved). Accepted scans store the processed `File` as the page with the pre-scan capture retained in `scanStore` under the page id (released on remove/clear/replace, never on scanner close).
- **Reason.** Unconfirmed auto-insertion would corrupt collections on mis-detection; reusing low-res corners for full-res geometry would silently degrade output; keeping the v1.9 path guarantees the camera works when WASM is unavailable.
- **Alternatives considered.** Auto-insert processed pages (rejected: mis-detection writes bad pages). Manual corner adjust in v2.0 (deferred to v2.1, explicit). Auto-capture (deferred to v2.1, explicit).
- **Consequences.** E2E uses a runtime-generated Y4M fake camera (canvas.captureStream yields 2x2 in headless); scan-build E2E probes the result blob in-page because second-browser download plumbing does not fire.
- **Status.** Decided, implemented and verified in v2.0 M3 (180 unit tests, canonical E2E 35/35 + 4 SKIP).
