# Folio — Performance Analysis & Optimization Plan

Analysis date: 2026-09-26 (`dev` @ `f3dc0fd`). Every finding below is either **verified** (read directly in source by the planning pass) or **reported** (found by the codebase audit pass; spot-verify before fixing). Estimates are engineering estimates, not measured benchmarks — Folio's rule against presenting ad-hoc timings as benchmarks applies here too.

## Purpose

The pipeline is correct, memory-disciplined, and now produces reasonably sized outputs (JPEG passthrough, F-14; PNG→JPEG import, F-16). This plan attacks the remaining costs: avoidable full-file copies, O(N²) page-tree traversals, per-page event storms, main-thread encode work, and the parallel-computing question.

## Constraints (non-negotiable)

- **Engine contract stability.** No changes to operation IDs, wire shapes, worker protocol, or `folio.ts` orchestration behavior. Optimizations must be behavior-preserving; tests prove it.
- **Single-threaded WASM is the shipping baseline.** Threaded WASM (nightly + `SharedArrayBuffer` + COOP/COEP) is a separate, gated decision — see "Parallel computing" below.
- **Memory discipline stays.** No bytes in React state, no base64, outputs move by reference, one decoded image peak (P6 invariant preserved).
- **No new dependencies without a recorded decision** (`docs/DECISIONS.md`).
- **Verification per change.** Rust `cargo test` + `fmt` + `clippy`; frontend typecheck/lint/format/test; canonical E2E. Baselines in `docs/STATUS.md` update in the same commit.

## Where time actually goes (pipeline stage map)

```text
intake (File → ArrayBuffer)            main thread, once per open           — disk read, unavoidable
render load (PDF.js copy)              main thread, once per open           — PDF.js owns a copy (F-2 lesson)
staging for execution                  main thread, PER RUN                 — slice() of the whole file  ← P0
transfer to worker                     zero-copy (transferable)             — fine
WASM heap intake                       worker ← JS, PER INPUT               — to_vec() + clone()          ← P0
parse (lopdf)                          worker                               — inherent
operation loop (per-page)              worker                               — O(N²) traversals           ← P1
progress events (per page)             worker → main, PER PAGE              — event + JSON + render storm ← P0
serialize output                       worker                               — inherent (~output size)
output transfer + wrap                 zero-copy after one WASM copy-out    — fine
thumbnail render+encode                PDF.js worker + main-thread encode   — double getPage             ← P1
import/capture decode → encode         main thread (normalization)          — double decode, serial     ← P2
```

## Findings register

Status: ✅ = fixed in the 2026-09-26 performance pass; ◻ = open (phase in parentheses). Every finding was either **verified** (read directly in source by the planning pass) or **reported** (found by the audit pass) before it was fixed.

| #   | Finding                                                                                                                                                                                                            | Where                                                                          | Impact     | Effort | Status                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Rendering-backed inputs are `slice()`d in full on the main thread before every execution; the store copy cannot be transferred because re-runs need it.                                                            | `app/src/engine/WasmWorkerEngineAdapter.ts:213-229`                            | **High**   | S      | ◻ design-gated (P0.2)                                                                                                                   |
| 2   | WASM intake copies each input twice: `Uint8Array::to_vec()` into `Vec<Vec<u8>>`, then `input_at` `clone()`s again per dispatch (≈2× file size resident in WASM).                                                   | `wasm/src/lib.rs:941-950`, `:513`                                              | **High**   | S      | ✅ verified                                                                                                                             |
| 3   | `PdfDocument::page_count()` rebuilds the full page map (`get_pages()`) on every call; per-page loops that call geometry/rotation helpers become O(N²).                                                             | `engine/src/processing/pdf/core/document.rs:87-89` (+ `:139-182`, `:239-271`)  | **High**   | M      | ✅ verified                                                                                                                             |
| 4   | Rotate deep-copies **every** page (all streams, images) even when one page is selected, then does per-selected-page traversals. Any rotate on a large doc rewrites the whole file.                                 | `engine/src/processing/pdf/rotate/mod.rs:178-207`                              | **High**   | M      | ✅ verified                                                                                                                             |
| 5   | Inspect-detailed does one page-tree rebuild per page.                                                                                                                                                              | `engine/src/processing/pdf/inspect/mod.rs:185-204`                             | **High**   | S      | ✅ verified                                                                                                                             |
| 6   | `copy_pages` re-derives page count, re-runs `find_invalid_page`, and re-resolves the page map even though callers validated already; split repeats it per part (~4 traversals/part).                               | `engine/src/processing/pdf/core/copy.rs:78-91`; `split/mod.rs` (per part)      | **High**   | M      | ✅ verified                                                                                                                             |
| 7   | One progress event per page: `format!` → event → JSON → `postMessage` → `JSON.parse` → React `setState` per page. 1000 pages ≈ 2000 events/renders.                                                                | `engine/src/processing/pdf/*/mod.rs` loops; `wasm/src/lib.rs:244-251`; adapter | **High**   | S      | ✅ verified                                                                                                                             |
| 8   | Every thumbnail does two PDF.js `getPage` round-trips (dims, then render); each triggers parse/cleanup. 100-page doc wave ≈ 200 round-trips.                                                                       | `DefaultPdfThumbnailEngine.ts:286,315`; `PdfJsRenderEngine.ts:242`             | **High**   | S      | ✅ verified                                                                                                                             |
| 9   | Scan pipeline duplicates full-res RGB: `to_rgb8()` clone + `RgbImage::from_raw(rgb.to_vec())` inside detection, plus glue `to_vec()`. 12 MP capture ≈ 3× 36 MB churn.                                              | `scan/src/pipeline.rs:61-82`; `scan/src/detect.rs` (`from_raw`)                | **High**   | S      | ✅ verified                                                                                                                             |
| 10  | Live detection runs the full warp + JPEG encode and throws the bytes away; only `status`/`corners` are read.                                                                                                       | `scan/src/pipeline.rs:70-88`; `useScanProcessor.ts` live path                  | Medium     | S      | ✅ verified                                                                                                                             |
| 11  | Import normalizes with a double decode (bitmap for dims, then again to resize) and serial main-thread canvas encodes.                                                                                              | `app/src/studio/tools/imageImport.ts:140,155,90-119`                           | Medium     | M      | ✅ reported                                                                                                                             |
| 12  | Capture encodes full-res JPEG on the main thread at shutter.                                                                                                                                                       | `CameraCapture.tsx` capture path                                               | Medium     | M      | ✅ shutter offloaded (P2; live-tick `toBlob` untouched)                                                                                 |
| 13  | Thumbnail encode (`toBlob` webp→jpeg→png) is sequential per batch on the main thread for 24 live canvases.                                                                                                         | `folio.ts:383-413` (encode), `:498-505`                                        | Medium     | S      | ✅ bounded-2 concurrent (P2)                                                                                                            |
| 14  | `ExecutionStrategy::Parallel` + `InputTransfer`-grade hints exist but the scheduler always returns `Inline`; `OperationCapabilities` parallelism is unused. Loophole: README of the scheduler suggests capability. | `engine/src/execution/scheduler.rs:22-51`                                      | Medium     | M      | ◻ (P3)                                                                                                                                  |
| 15  | Dead perf surfaces: `binaryStore.copyBytes`, `getStudioBytes` have no callers; `apply_mode` re-encode path unreachable from UI (latent double decode/encode).                                                      | `app/src/engine/binaryStore.ts`; `scan/src/pipeline.rs:83-88`                  | Low        | S      | ◻ assessed 2026-09-26: zero-caller pair kept (no deletion); `apply_mode` is live tested core, only the UI selector is absent — not dead |
| 16  | Detection collects all contours before filtering (thousands of tiny `Vec`s at 800 px) rather than filtering cheaply first.                                                                                         | `scan/src/detect.rs:79-88`                                                     | Low-Medium | S      | ✅ verified                                                                                                                             |
| 17  | Full-res previews re-render per open (scale 2, webp encode), cached only per-mount in tool state, not in a service LRU.                                                                                            | `folio.ts:532-543`; `RearrangeTool.tsx:164-180`                                | Low-Medium | S      | ✅ service LRU cap 8 (P2)                                                                                                               |

## Parallel computing: reality check

**What "parallel" can mean here, in increasing cost:**

1. **Worker-level parallelism (recommended, no toolchain change).** Multiple independent WASM instances, one per worker, splitting _independent_ work: image pages, output chunks, thumbnail windows. Folio already uses three execution contexts (engine worker, PDF.js worker, scan worker) and bounded concurrency 2 for thumbnails. Extending this to `images_to_pdf` (shard N images → N single-purpose workers → ordered merge) is the highest-value parallelism and ships on the current stable toolchain.
2. **In-engine page parallelism (not viable per-operation without threads).** lopdf mutations are single-threaded; page loops share one document. Chunking _copies_ across threads requires shared or per-thread docs; the deep-copy primitives make this a large refactor for modest gains once the O(N²) issues are fixed.
3. **Threaded WASM (`wasm-bindgen-rayon` + COOP/COEP).** Real in-engine parallel decode/copy. Needs: nightly Rust + `-Z build-std`, `SharedArrayBuffer` (COOP/COEP response headers via Cloudflare Pages `_headers`), Safari support variance, +bundle size, and a reproducibility policy change (pinned nightly). Large lift, real risk; only justified if measurements (P4) prove CPU-bound engine time after P0–P2. Gate: separate `DECISIONS.md` entry before any work.
4. **Non-goals.** Worker-per-page (thrash), GPU compute (no PDF kernel), offloading small ops (transfer beats compute).

**Recommendation.** Do P0–P2 first (they are pure wins and shrink what parallelism would even need to cover), add measurement in P4, then decide on (1) worker sharding for images with data, and only later evaluate (3).

## Phased plan

### P0 — Copy elimination & event hygiene (est. 1–2 focused days) — **implemented 2026-09-26**

1. **Glue ownership fix (finding 2).** ✅ `dispatch` consumes the blob vec (`std::mem::take`); only the unavoidable JS→WASM copy remains; 5 new glue unit tests.
2. **Main-thread slice removal — design-gated, NOT a pure win (finding 1).** The store's resident copy is what makes re-runs copy-free; removing the `slice()` means re-reading from the retained `File` per run (async, browser-managed, no second resident copy) at the cost of disk I/O — a memory-vs-latency trade that must be decided with P4 measurements on real devices. Design notes recorded; no implementation until measured.
3. **Progress coalescing (finding 7).** ✅ Implemented at the WASM glue sink: lifecycle always passes, phase changes pass, Δpercentage ≥ 1 passes, terminal 100 always passes; wire shape unchanged (fewer messages).
4. **Scan pipeline (findings 9, 10).** ✅ Borrowed-view detection (no full-res copy), `into_rgb8()` move, `detect_only` live path (no warp/encode/bytes; protocol v2), contour prefilter. Also fixed a latent corner-parsing bug that disabled live detection entirely (BUGS F-17).
5. **Import double decode (finding 11).** ✅ One decode per file via a live-bitmap seam, closed exactly once on every path.

**Acceptance:** identical outputs (byte-level tests for passthrough paths), one fewer full-file copy per run and per input; live mode never encodes; all suites green; E2E runtimes unchanged or better.

### P1 — Algorithmic single-pass operations (est. 2–3 focused days) — **implemented 2026-09-26**

6. **Page-map cache (finding 3).** ✅ `PdfDocument` owns a lazy page-map cache with explicit invalidation; every internal lookup uses it.
7. **Rotate in place (finding 4).** ✅ The private parse is mutated in place; one traversal resolves the selection and writes `/Rotate`; ancestor-`/Rotate` unselected pages keep their inherited rotation (pre-existing semantics tests pass; the `page_geometry` accumulation quirk is unchanged and documented in code).
8. **Split/copy single-pass (finding 6).** ✅ `copy_pages_with_map` validates against a caller-resolved map; split/delete/reorder use it; error codes/messages unchanged.
9. **Thumbnail single `getPage` (finding 8).** ✅ `renderPage` fits to a `targetBox` and returns `sourceWidth/sourceHeight`; the dimensions cache is seeded by renders and cleared on close; one `getPage` per thumbnail.
10. **Contour filtering before materialization (finding 16).** ✅ Cheap point-count/bbox filter during iteration.

**Acceptance:** rotate/split/inspect timings scale linearly in synthetic large-N bench (see P4 for harness); unchanged outputs across Rust + E2E suites.

### P2 — Main-thread offload (est. 2–3 focused days) — **implemented 2026-09-26**

11. **Encode offload (findings 12, 13).** ✅ Dedicated `imageEncode.worker.ts` (OffscreenCanvas + `convertToBlob`, transferable bitmap) serves import normalization (`browserImportRenderer.resizeToJpeg`) and the `CameraCapture` shutter capture (front-camera un-mirror preserved); verbatim main-thread fallback whenever workers/OffscreenCanvas are unavailable, with failure latching so the no-worker case pays one check. Thumbnail encode is bounded-concurrent (2) instead of sequential, order-preserving, same webp→jpeg→png chain. One-image-at-a-time import discipline unchanged; live-tick `toBlob` untouched (out of scope).
12. **Preview cache (finding 17).** ✅ Service LRU (cap 8, keyed by `renderId:pageNumber`) in `folio.ts`; revocation on eviction and on `closeStudioDoc`; tools keep per-mount maps as fast path.

**Acceptance:** main-thread long tasks during import/capture/thumbnail waves drop (measure via P4 marks); memory baselines unchanged; suites green — met (E2E 49/49 + 4 SKIP, unit 247).

### P3 — Worker-level parallelism for Images (est. 3–5 focused days, gated on P4 data) — **implemented 2026-09-26**

13. **Shard `images_to_pdf` across K workers** ✅ `imageSharding.ts`: batches ≥8 pages split into contiguous collection-order shards across K device-aware workers (2–3 by `hardwareConcurrency`, one shard per page max, 256 MiB in-flight cap → single path over cap), each shard its own `pdf.images_to_pdf` engine call through unchanged orchestration, then ordered `pdf.merge` over temp studio docs (closed in `finally`). Progress aggregated honestly (90% shards page-weighted + 10% merge); cancellation cancels every in-flight job; failures fail honestly (no silent single-worker retry — recorded in code). Below 8 pages the historical single-worker call runs byte-for-byte.
14. **Parallel honesty (finding 14).** ✅ Satisfied by construction: `InlineScheduler` stays `Inline` (correct for the single-threaded WASM baseline) with a doc comment stating real parallelism lives at the app layer (`imageSharding.ts`); the `Parallel` variant stays documented-but-unselected so `OperationCapabilities` (frozen contract, D9) is untouched.

**Acceptance:** large image batches build measurably faster with identical output bytes (modulo engine-identical serialization), cancellation and progress semantics preserved, E2E passes — met (8-page sharded E2E: all pages in order; 15 sharding unit tests).

### P4 — Measurement harness & attribution (est. 1–2 focused days) — **implemented 2026-09-26**

15. **Engine bench CLI:** ✅ `engine/examples/bench_operations.rs` benches merge/split/rotate/inspect/images over synthetic docs at {1, 10, 50 pages} plus optional `--dir` corpus (read-only, never required); `--repeat N` + `--json` follow the existing example conventions. Run: `cd engine && cargo run --example bench_operations -- --repeat 3 --json`.
16. **App-side attribution:** ✅ `performance.mark/measure` spans around intake → staging → transfer → wait → outputs in `runStudioOperation` plus render/encode spans for thumbnails/previews, exposed as dev-only `perfMarks` on the studio result (production shape unchanged; engine duration stays authoritative).

## Pass record — 2026-09-26 (P3)

| Verification        | Result                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Engine Rust suite   | 357 passing (comment-only scheduler note; behavior unchanged)                                                    |
| Frontend unit tests | 272 passing (+15 sharding: K policy, coverage/order, single-path fidelity, failure/cancel honesty, temp cleanup) |
| Canonical E2E       | sharded 8-page build keeps all pages in order (new check; full count updated below)                              |
| Builds              | typecheck/lint/format clean                                                                                      |

Implemented in `app/src/studio/tools/imageSharding.ts` (new, + tests) + `ImagesTool.tsx` build path, integrated centrally.

## Pass record — 2026-09-26 (P2 + P4)

| Verification        | Result                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine Rust suite   | 357 passing (239 unit + 118 integration; unchanged — bench is examples-only)                                                                            |
| Frontend unit tests | 247 passing (+7: 4 import worker-fallback, 3 thumbnail encode-concurrency)                                                                              |
| Canonical E2E       | 49/49 + 4 SKIP (unchanged flows; no new user-visible behavior to assert)                                                                                |
| Builds              | production build clean (new encode worker bundles); typecheck/lint/format clean                                                                         |
| Bench smoke         | `bench_operations --repeat 2 --json` well-formed, 15/15 reports, 0 failures (debug-build timings indicative only, not benchmarks)                       |
| Finding assessed    | F-15: `copyBytes`/`getStudioBytes` zero callers but kept (no deletion without out-of-tree audit); scan `apply_mode` is live tested core, not dead — D20 |

Implemented in `engine/examples/bench_operations.rs` (new), `app/src/studio/services/folio.ts` (+ `folio.test.ts`), `app/src/studio/tools/{imageImport.ts (+ test), imageEncode.worker.ts (new), CameraCapture.tsx}` — three disjoint workstreams, integrated centrally.

## Pass record — 2026-09-26 (P0 + P1)

Implemented in `engine/src/processing/pdf/{core/document,core/copy,rotate,inspect,split,delete,reorder}`, `wasm/src/lib.rs`, `scan/src/{pipeline,detect,wasm}`, `app/src/studio/tools/{imageImport,scan/*}`, `app/src/rendering/*`.

## Verification protocol (every phase)

- Rust: `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets` (engine and scan).
- Frontend: `npm run build:wasm` + `build:scan`, typecheck, lint, format, `npm test`, production build.
- E2E: canonical suite green; add focused assertions only where behavior is user-visible (e.g., a rotate-on-large-synthetic-PDF timing budget as a regression tripwire, not a benchmark).
- Docs: `STATUS.md` baselines, `WORKLOG.md` record, `DECISIONS.md` for design changes (P0.2 memory model, P3 sharding, any threaded-WASM gate).

## Risks

- **P0.2 changes binary ownership semantics** — highest-risk item; requires a dedicated DECISIONS entry and full E2E (large-file paths) before merge.
- **Progress coalescing** could hide the last event; mitigated by always emitting terminal 100%.
- **Worker sharding (P3)** multiplies resident WASM memory by K; must be capacity-gated and fall back on low-memory devices.
- **Threaded WASM** would break the "stable toolchain" reproducibility promise; deliberately deferred.

## Non-goals

- Rewriting lopdf usage or replacing the serialization layer.
- Caching documents in IndexedDB/OPFS (privacy/scope decision, not performance).
- Micro-optimizing paths already dominated by transfer or user think-time.
