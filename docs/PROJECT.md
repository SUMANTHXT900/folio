# Folio — Project Description

## What Folio is

Folio is a local-first PDF application powered by a Rust PDF processing engine compiled to WebAssembly for browser execution, with PDF.js providing PDF rendering and previews.

Short form: **PDF processing is powered by Rust/WASM, while PDF.js handles rendering and previews.**

The production app is a static web app (React + TypeScript + Vite) that runs entirely in the browser. There is no PDF-processing backend: documents are processed in memory on the user's device and discarded when the tab closes.

## The problem Folio solves

Most PDF tools upload documents to a remote server for processing. That is slow (network round-trips), fragile (offline = broken), and wrong for private documents (tax forms, contracts, medical records, IDs). Folio removes the server from the pipeline: every operation runs locally, so files never leave the device, work continues offline once the app is loaded, and there is nothing to sign up for.

## Vision

Private PDF tools that are fast, honest, and local — an application users can trust with sensitive documents because there is architecturally nowhere for the documents to go.

## Goals

- **Correctness first.** Page-level operations must be byte-exact: no dropped pages, no reordered-without-consent output, no silent metadata loss. The engine test suite (345 Rust tests) exists to guarantee this.
- **Honest UX.** Real progress (engine events, not spinners), honest cancellation (the `CANCELLED` path is a first-class status, verified in E2E), structured errors with codes (never "something went wrong" alone), and completion metadata (duration, page counts, output size) on every tool.
- **Large-file competence.** The engine is designed for hundred-megabyte / thousand-page documents (historically verified against a ~514 MB / 2585-page file — optional benchmark evidence, not a repository fixture): bounded thumbnails, windowed processing, no full-document materialization, no binary copies, cancellable work, released resources.
- **Single repository.** The Rust engine source, WASM bridge, tests, examples, and the production frontend live in one repository that builds from a fresh clone. Generated WASM (`wasm/pkg/`) is a reproducible artifact, never the source of truth.

## Non-goals

- Folio is not a PDF viewer company feature — it does not aim to replace full document editors, form-fill workflows, or e-signature platforms (some are listed as possible future work in `ROADMAP.md`, not commitments).
- Folio is not a server product. There is no upload endpoint, no processing queue, no account system — by design, not by omission.
- Folio does not chase feature count over correctness. `Compress` stays visibly disabled rather than shipping a fake implementation.

## Target users

Anyone who works with PDFs containing private or sensitive content and prefers an offline-capable tool: individuals handling personal records, professionals handling client documents, and users on unreliable connections who need tools that work after first load.

## Product philosophy and core principles

1. **Local-first.** Core processing runs on-device through Rust/WASM in a Web Worker. The browser may load local app assets; it never calls a remote PDF-processing server.
2. **Separation of manipulation and rendering.** Rust/WASM (via `lopdf`) mutates documents; PDF.js renders them to canvas. Neither crosses into the other's job.
3. **Engine authority.** Timing, progress, status, and errors originate from the engine, never from UI computation (`engineDurationMs` is monotonic and authoritative).
4. **Binary ownership.** PDF bytes live in module-level stores, never in React state, never base64-encoded, never copied without reason. See `docs/ARCHITECTURE.md`.
5. **No mocks in production paths.** The production E2E suite drives the real app in real headless Chrome against the real engine. A mock adapter exists for unit tests only and never ships a production code path.

## Privacy model

- Core PDF processing runs locally in the browser through Rust/WASM and does not require uploading documents to a remote PDF-processing server.
- PDF.js rendering uses local application assets for previews and thumbnails.
- Once loaded, the app is offline-capable (PWA precache covers the app shell, fonts, PDF.js worker, and the WASM engine).
- Deliberately avoided claim: "the application never makes network requests." The browser still loads local app assets; the guarantee is about document processing, not about all network activity.

## Large-file goals

Open, inspect, thumbnail, and operate on hundred-megabyte / thousand-page PDFs without tab crashes, unbounded memory growth, or frozen UI: bounded thumbnail concurrency (2) and windows (24 pages), LRU-bounded thumbnail URL cache (6 documents), canvas bitmap release after URL encode, cancellable jobs, and document close/release semantics. Historically verified against a ~514 MB / 2585-page file (optional large-file validation during engine development — the file is not part of the repository).

## Current capabilities (`dev`, pre-v2.0: scanner M1–M3, perf P0–P4, naming-first downloads)

| Tool         | Operation(s)                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge        | `pdf.merge` — ordered concatenation, real progress + cancellation                                                                                                                                                   |
| Split        | `pdf.split` — visual pick mode + page-range parts, atomic, structured range errors                                                                                                                                  |
| Rearrange    | `pdf.reorder` — exact permutation via drag-to-reorder                                                                                                                                                               |
| Rotate       | `pdf.rotate` — relative quarter-turns per page or whole document                                                                                                                                                    |
| Metadata     | `pdf.read_metadata` / `pdf.set_metadata` — set / clear / leave-unchanged patch semantics                                                                                                                            |
| Images → PDF | `pdf.images_to_pdf` — JPEG/PNG, one page per image, fit or A4; page assembly (preview grid, reorder, remove, add-more, rotate, camera capture with document-scan processing) over a unified ordered page collection |
| Compress     | Disabled — reserved for a future update (see `ROADMAP.md`)                                                                                                                                                          |
| Rendering    | Page previews, bounded thumbnails, page-count intake via PDF.js                                                                                                                                                     |

Engine-only capabilities (tested, no Studio UI surface yet): `pdf.inspect` (basic/detailed), `pdf.extract_pages`, `pdf.delete_pages`. They are part of the engine contract in `docs/OPERATIONS.md` and must keep passing tests.

## High-level architecture

```text
Manipulation:  Folio App → TypeScript engine API → WasmWorkerEngineAdapter
               → Web Worker → Rust/WASM → ExecutionEngine → lopdf
Rendering:     Folio App → PdfRenderEngine → PdfJsRenderEngine → PDF.js → canvas
Thumbnails:    PdfThumbnailEngine → PdfRenderEngine → PDF.js
```

Details in `docs/ARCHITECTURE.md`.

## Why these technologies

- **Why Rust.** Memory safety without a garbage collector, precise control over copies (critical for 500 MB documents), and a strong type system for the operation model. The `lopdf` crate provides pure-Rust PDF parsing/manipulation with no OS dependencies.
- **Why WASM.** Compiles the same Rust core that native tests exercise, so the browser runs verified logic instead of a second implementation. Single-threaded WASM execution keeps the model simple; heavy work is isolated in a Web Worker instead.
- **Why PDF.js.** Battle-tested PDF rendering to canvas, including text selection-quality output and thumbnail generation. Using it for rendering-only avoids reimplementing a renderer in Rust while keeping manipulation in the verified engine.
- **Why Web Workers.** PDF processing and PDF rendering both leave the main thread: the engine worker (`engine.worker.ts`) keeps the UI responsive during heavy jobs, and cancellation/progress stream across the worker boundary via a typed protocol (`workerProtocol.ts`).

## What Folio is not

- Not written entirely in Rust (the app shell, orchestration, and rendering glue are TypeScript/React).
- Not a PDF.js-free codebase (PDF.js is a load-bearing rendering dependency).
- Not a backend service, Electron app, or Tauri app (earlier server-bridge and native-shell directions were tried and abandoned — see `docs/DETOURS.md`).
- Not a fork of another PDF tool. The engine (`ExecutionEngine`, operation model, error model) is purpose-built for this project.
