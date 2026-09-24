# Folio — Architecture

This document describes the actual current architecture as implemented. The long-form lesson-by-lesson build record lives in the root `ARCHITECTURE.md`; this file is the normative summary. Where they disagree, verify against source and fix this file.

## System overview

```text
Manipulation:
Folio App (app/src/studio/)
    ↓  application concepts only (ids, names, progress, errors)
studio/services/folio.ts  (single integration boundary)
    ↓  Folio TypeScript APIs (app/src/engine/, app/src/types/engine.ts)
WasmWorkerEngineAdapter
    ↓  typed worker protocol (workerProtocol.ts), transferable Uint8Array
Web Worker (engine.worker.ts)
    ↓  wasm-bindgen calls, JSON control plane + binary transfer
Rust/WASM (wasm/src/lib.rs — thin glue, no PDF logic)
    ↓
ExecutionEngine (src/execution/, src/core/)
    ↓
Operations (src/processing/pdf/*/) → lopdf

Rendering:
Folio App
    ↓
PdfRenderEngine (interface, rendering/PdfRenderEngine.ts)
    ↓
PdfJsRenderEngine (rendering/PdfJsRenderEngine.ts)
    ↓
PDF.js (pdfjs-dist, local assets + worker)
    ↓
Canvas

Thumbnails:
PdfThumbnailEngine (interface) → DefaultPdfThumbnailEngine
    ↓
PdfRenderEngine → PDF.js
```

## Engine boundaries

- **UI ↔ service.** Tools and hooks (`studio/tools/`, `studio/hooks/`) hold lightweight handles only: `{id, name, sizeBytes, pageCount}`. They call `runStudioOperation`, `openStudioDocs`, `studioThumb*`, `studioPreview`, `studioDownload`/`studioShare`. No PDF parsing or mutation in UI code.
- **Service ↔ engine API.** `folio.ts` translates between application concepts and the TypeScript engine contract (`types/engine.ts`, a field-by-field mirror of the Rust contract). The engine remains authoritative: timing, status, progress, and errors originate from the adapter, never from UI computation.
- **Page collection (Images → PDF).** `useImagePages` owns the ordered `ImagePage[]` (handles + metadata, never bytes) and every preview object URL (created on add, revoked on remove/clear/unmount). The build loop reads bytes in collection order and stages them into the unchanged `pdf.images_to_pdf` engine — ordering is app-level. Camera (`CameraCapture.tsx`) produces `File`s into the same collection; rotation is applied app-side at build time (canvas re-encode for rotated pages only). See `docs/DECISIONS.md` D14.
- **Main thread ↔ worker.** `WasmWorkerEngineAdapter` posts `EngineRequest`s and subscribes to `EngineEvent`s (`lifecycle | progress | log`). PDF bytes cross as `Uint8Array`, never inside JSON, never base64.
- **Glue ↔ core.** `wasm/src/lib.rs` is a thin API layer over the `folio-engine` crate: same `ExecutionEngine`, same operations, same error model as native/CLI. No PDF logic in the glue.
- **Manipulation ↔ rendering.** The engine never renders; PDF.js never mutates. Page counts for intake come from the rendering side (`loadDocument`); manipulation results return to it for display.

## Browser boundary

Everything PDF-related executes in one of three places: the main thread (UI + rendering orchestration), the engine Web Worker (manipulation), and PDF.js's own worker (rendering). The main thread never blocks on engine work: `adapter.execute()` returns a `jobId` plus a `done` promise, and progress streams via subscription.

## Scan worker boundary (v2.0 M2)

Document-scan processing runs in a DEDICATED scan worker (`app/src/studio/tools/scan/scan.worker.ts`), separate from the PDF engine worker: different responsibility (image analysis vs PDF manipulation), different WASM module (`scan/pkg`, ~514 KB + glue), independent lifecycle. `ScanWorkerClient` is the main-thread gateway: lazy worker creation, init-once module reuse, transferable byte ownership (neuter-on-send), epoch-guarded stale-result discard, terminate-to-cancel with transparent recreate. The protocol (`scanProtocol.ts`, versioned) distinguishes `processed | original | error` — "no document detected" is fallback, not failure. Scan WASM loads on first scanner use, never at app boot; PWA precache budget unchanged (4.1 + ~0.5 « 8 MB cap).

## Binary ownership

- PDF bytes live in module-level maps: the adapter-side binary store (`engine/binaryStore.ts`, keyed by `outputId`) and the studio-side `binaries` map (keyed by studio doc id). **Never in React state.**
- Outputs move into studio ownership by reference (`getBytes` → `releaseBytes` immediately): no copies, no accumulation.
- Closing a document (`closeStudioDoc`) cancels thumbnail work, closes the rendering document, revokes object URLs, and frees bytes — in that order.
- Test-only reset (`__resetStudioForTests`) exists for unit tests; the app never calls it.

## Operation lifecycle

1. UI stages inputs (bytes already in the studio store; images staged without a rendering document).
2. `runStudioOperation(operation, docIds, options)` resolves bytes by reference, builds an `EngineRequest`, and calls `adapter.execute()`.
3. The worker runs the `ExecutionEngine` job: validation → processing with progress events → atomic output commit.
4. The adapter resolves `done` with an `EngineExecution`: terminal `status` (`completed | failed | cancelled`), authoritative `engineDurationMs`, `result.summary + outputs` or `error`.
5. Cancellation (`cancel()`) races safely: if called before the adapter handle exists, a flag ensures the job is cancelled once created. Terminal `cancelled` maps to the `CANCELLED` studio error.

## Timing

- The engine owns authoritative timing: `engineDurationMs` is monotonic (native: `std::time::Instant`; WASM: JS-backed monotonic clock via `js-sys`, because `std::time` panics on `wasm32-unknown-unknown` — see `docs/LESSONS.md`).
- UI displays durations (`formatDurationMs`: `380ms`, `1.24s`) but never computes them. Completion lines show engine duration plus page counts and output size.

## Progress

- Operations declare capabilities (`OperationCapabilities`: parallelism hint, `supports_progress`, `supports_cancellation`, `supports_streaming`). All ten current PDF operations declare `parallel_friendly()` — progress and cancellation supported.
- Progress events carry `phase / completed / total / message`; the UI shows `message ?? phase` as the label and `percentage` as the fraction. Lifecycle messages with no percentage render as indeterminate labels.
- Merge progress scale and per-tool completion/progress/error UX were fixed during the v1.7.0 integration (see `docs/WORKLOG.md`); E2E asserts real progress labels, not spinners.

## Cancellation

- Cooperative: the engine observes cancellation points during page-oriented work; the adapter exposes `cancel(jobId)`; the studio job exposes `cancel()`.
- `CANCELLED` is a terminal status with its own error code and friendly message ("The operation was cancelled."), surfaced honestly in the UI and asserted by E2E (`merge cancellation surfaces honestly in UI`).
- Thumbnail jobs are independently cancellable (`studioThumbWindow` returns `{done, cancel}`) and are cancelled en masse on document close.

## Errors

- Structured end to end: Rust `ErrorCode` (11 variants: `INVALID_DOCUMENT`, `INVALID_PAGE_RANGE`, `PAGE_OUT_OF_RANGE`, `DUPLICATE_PAGE`, `PROCESSING_FAILED`, `CANCELLED`, `UNSUPPORTED_FORMAT`, `IO_ERROR`, `INVALID_INPUT`, `INVALID_OPTIONS`, `INTERNAL`) → wire strings via `code_str()` → TypeScript `ErrorCode` → `toStudioError` friendly mapping.
- The friendly message is primary; the raw engine message is preserved as secondary detail (`engineMessage`) and the code is always retained for diagnostics. The UI `ErrorBlock` shows friendly message + engine message/details + subtle code.
- Validation runs before mutation: range errors (e.g. Split's structured range error, asserted in E2E) never produce partial outputs. Split commits atomically — outputs return only after every part succeeds.

## Worker lifecycle

- One engine worker per session, created lazily by `WasmWorkerEngineAdapter`. The WASM module loads once; each `execute()` starts a new engine job (`job-N` from `ExecutionEngine`).
- Adapter-level `jobId` (`wasm-N`) is the stable UI identity (keys, history). The engine-level `engineJobId` may repeat across worker restarts and is display-only, never a key.
- A mock adapter (`MockEngineAdapter`) exists for unit tests. It reports `simulated: true` events; the worker adapter reports real events with `simulated: false`. The mock never backs a production path.

## Rendering

- `PdfJsRenderEngine` wraps `pdfjs-dist`: `loadDocument` (returns id + page count), `renderPage` (into a caller-owned canvas at a requested scale), `closeDocument`.
- Defensive copy on load: PDF.js detaches (neuters) the buffer handed to it, so the engine passes a copy and keeps the original (see `docs/LESSONS.md`).
- Full-resolution previews render at scale 2 into a temporary canvas, encode to an object URL, and release the canvas immediately. The caller owns URL revocation.

## Thumbnail architecture

- `DefaultPdfThumbnailEngine` generates thumbnails through the shared `PdfRenderEngine` (one document load, not one per page — the "25x faster thumbs" fix, v1.2.2).
- Windows, not whole documents: callers request page windows (the Studio hook uses 24 pages) with bounded concurrency (2). Transient memory stays flat regardless of document size.
- Object-URL cache is LRU-bounded to 6 documents; eviction and document close revoke URLs. Canvas bitmaps are released (`width = height = 0`) as soon as the encoded URL exists.
- MIME fallback chain on encode: WebP → JPEG → PNG, so environments without a WebP encoder (or under memory pressure) never fail the wave.

## Large-file handling

- Design target: hundred-megabyte / thousand-page documents (historically verified against a ~514 MB / 2585-page file: full page count loads (2585/2585), thumbnail DOM stays bounded (24 images, not 2585), zero console errors — see `docs/WORKLOG.md` and the root `ARCHITECTURE.md` log for the benchmark evidence).
- Mechanisms: windowed page processing, bounded concurrency, binary ownership (no copies, no base64), no full-document thumbnail materialization, no unbounded event retention, no React-state binaries, document close/release.
- Testing split (see `docs/DEVELOPMENT.md`): the canonical E2E suite (`app/e2e/studio.e2e.mjs`) runs from a fresh clone without any private corpus (deterministic synthetic small fixtures when needed; large-file sections SKIP explicitly). The `test pdfs/` corpus (including any large file) is gitignored, developer-owned, optional benchmark infrastructure — never committed, never required for canonical validation. `e2e/large-files.e2e.mjs`, `e2e/thumbnail.e2e.mjs`, and `e2e/metadata.e2e.mjs` are optional suites that run only when the corpus is present.

## Concurrency and caching

- Engine: `ParallelismHint` (`Sequential` for structural rewrites like reorder, `SubTaskParallel` for page-oriented work, `FullyParallel` for independent items). The scheduler reads the hints; operations never schedule themselves. WASM execution itself is single-threaded.
- Frontend: thumbnail concurrency 2, windows of 24 pages, 6-document LRU URL cache. No IndexedDB/OPFS caching of documents.

## WASM / native distinction

- One Rust core, two targets: native (CLI examples, `cargo test` in `engine/`) and `wasm32-unknown-unknown` (browser via `wasm-pack`, `npm run build:wasm` in `app/`, output to gitignored `wasm/pkg/`).
- WASM-only dependencies (`lopdf/wasm_js` for a JS-backed RNG, `js-sys` for clocks) are gated behind `target.'cfg(target_arch = "wasm32")'` — native builds see zero new dependencies.
- `image` (JPEG/PNG) and `kamadak-exif` are pure-Rust, WASM-compatible; `default-features = false` keeps rayon (threading) out for the single-threaded baseline.
- `wasm-pack` build requires a `LICENSE` file presence note (license key set in `Cargo.toml`); the repo root `LICENSE` (MIT) covers this.
