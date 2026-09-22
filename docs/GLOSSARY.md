# Folio — Glossary

Definitions follow the actual implementation. Use these meanings consistently in code, docs, and discussion.

- **engine/.** Repository directory owning the native Rust PDF processing engine: `engine/src/` (source), `engine/tests/` (integration tests), `engine/examples/` (CLI tools), `engine/Cargo.toml` + `engine/Cargo.lock` (independent manifest, no workspace). Rust commands run here.
- **app/.** Repository directory owning the Folio browser application (the entire frontend tree: `src/`, `e2e/`, `package.json`, Vite/TS/lint configs, `public/`, `index.html`). Frontend commands run here. The engine consumer/orchestrator — never the engine itself.
- **wasm/.** Repository directory owning the Rust → WASM browser bridge: thin `folio-wasm` glue crate over `engine/` via path dependency. No PDF logic here.

- **Folio.** The product and project: a local-first PDF application. Also the `Folio` service prefix in the Studio layer (`studio/services/folio.ts`). Not "PDF Studio" (previous repository name, now historical).
- **ExecutionEngine.** The Rust struct that runs operations (`engine/src/execution/` + `engine/src/core/`): owns jobs, authoritative timing, progress events, cancellation, and results. Assigns engine job IDs (`job-{n}`).
- **OperationContext.** The minimal context an operation may use while running (per `engine/src/core/operation.rs`): inputs, cancellation handle, progress sink. Operations never schedule themselves.
- **OperationResult.** The terminal Rust-side record of one execution: status, summary, outputs, error, timing.
- **Operation / OperationCapabilities.** The `Input + Options -> Operation -> Result` trait plus declared characteristics: `ParallelismHint` (`Sequential` / `SubTaskParallel` / `FullyParallel`), `supports_progress`, `supports_cancellation`, `supports_streaming`. All ten current operations declare `parallel_friendly()`.
- **JobId.** Engine-side job handle (`job-{n}`, process-unique). Distinct from the adapter-level `jobId` (`wasm-{n}`), which is the stable UI identity across worker restarts.
- **Engine job ID.** See `JobId`. Display-only in the UI — never a React key — because it may repeat across worker restarts.
- **EngineAdapter.** The TypeScript interface (`app/src/engine/EngineAdapter.ts`) everything engine-like implements: `execute(request)` → `{jobId, done}`, `cancel(jobId)`, `subscribe(jobId, listener)`.
- **WasmWorkerEngineAdapter.** The production `EngineAdapter`: posts requests to the engine Web Worker, streams `EngineEvent`s, resolves `EngineExecution`s with real (non-simulated) data.
- **MockEngineAdapter.** Unit-test-only adapter reporting `simulated: true` events. Never backs a production path.
- **EngineEvent.** One live message from an execution: `lifecycle | progress | log`, with optional `phase / completed / total / percentage / message`, sequence number, and wall-clock timestamp.
- **EngineExecution.** The final TypeScript record of one execution: terminal status, authoritative `engineDurationMs`, `result` (summary + output refs) or `error`, per-job `events`, `simulated` flag.
- **PdfRenderEngine.** Rendering interface (`rendering/PdfRenderEngine.ts`): `loadDocument`, `renderPage` (into caller canvas), `closeDocument`. Manipulation-free by contract.
- **PdfJsRenderEngine.** The `PdfRenderEngine` implementation over `pdfjs-dist` (local assets + worker).
- **PdfThumbnailEngine / DefaultPdfThumbnailEngine.** Windowed thumbnail generation over a shared `PdfRenderEngine`: bounded concurrency, page windows, LRU URL cache, canvas release.
- **Studio.** The application UI shell (`app/src/studio/`: `StudioApp`, tools, hooks, services). "Studio" names the UI layer, not the product.
- **Folio service.** `studio/services/folio.ts`: the single integration boundary between the Studio UI and the engine. Owns the binary stores, translates errors, streams progress.
- **WASM.** WebAssembly: the compilation target (`wasm32-unknown-unknown`) that lets the browser execute the same Rust engine core native tests exercise. Built with `wasm-pack` into gitignored `wasm/pkg/`.
- **wasm-pack.** The tool building `wasm/` into the `wasm/pkg/` browser package (`--target web`). Invoked via `npm run build:wasm` from `app/`.
- **lopdf.** The pure-Rust PDF parsing/manipulation crate the engine builds on. No OS dependencies; WASM-compatible with default features off.
- **Windowed processing.** Requesting bounded page windows (e.g. 24 thumbnails) instead of whole documents; the mechanism that makes thousand-page files tractable.
- **Binary ownership.** The discipline that PDF bytes live in module stores (never React state), transfer by reference, and release deterministically. See `docs/ARCHITECTURE.md`.
- **Local processing.** Core PDF work executing on-device in the browser via Rust/WASM with no remote PDF-processing server. The architectural privacy guarantee.
- **PWA precache.** The service-worker asset set (Workbox, via `vite-plugin-pwa`) covering the app shell, fonts, PDF.js worker, and the WASM engine for offline use after first load.
- **Testbench.** The removed interactive developer console (`?testbench`). Historical term only — no code, route, or bundle carries it.
- **`test pdfs/`.** The gitignored, optional, developer-owned local PDF corpus used by the optional E2E suites and CLI examples. Never committed; never required for canonical testing (the canonical E2E suite generates deterministic synthetic small fixtures when the corpus is absent — see `app/e2e/corpus.mjs`).
