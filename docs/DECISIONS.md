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

## D16 — PWA update manager: silent check + one-tap apply (SYNAPSE pattern)

- **Decision.** A framework-free update store (`app/src/pwa/updateManager.ts`) wraps `virtual:pwa-register`: silent launch check (~3s), manual `registration.update()` with a 5s settle wait, localhost/insecure-LAN guard, capped diagnostic log. A global `UpdateBanner` (one-tap `updateSW(true)` → reload) and an About "App updates" card (Check for updates / Update now / Details log) share the store via `useSyncExternalStore` with a cached snapshot. Adapted from the SYNAPSE repo's update engine; restyled to the Folio design system (no terminal theatrics — a subtle mono log only).
- **Reason.** `registerType: 'autoUpdate'` updates the worker in the background but never tells the open page, so post-deploy users sat on a stale precache with no recourse but a manual hard refresh (near-impossible to discover on mobile) — F-13. Stale-chunk recovery (F-12) only fires after a failure; the manager is the proactive layer.
- **Alternatives considered.** `useRegisterSW` hook from `virtual:pwa-register/react` (rejected: hook-local state can't feed both the banner and About without prop drilling; the external store does). Forcing `reload` on every launch (rejected: destroys session state when no update exists).
- **Consequences.** New `app/src/pwa/` boundary; `virtual:pwa-register` is dynamically imported so unit tests and the dev server (no SW) degrade to `local`/`unsupported` instead of crashing; E2E asserts the About card on localhost.
- **Status.** Decided, implemented, verified (14 manager unit tests, canonical E2E 43/43 + 4 SKIP).

## D17 — JPEG DCT passthrough in images_to_pdf (container, not re-encoder)

- **Decision.** Baseline JPEGs with EXIF orientation 1 embed byte-identical (`/DCTDecode`, `/DeviceRGB`/`DeviceGray`/`DeviceCMYK`+inverting `/Decode` for Adobe transform-0). A conservative SOF parser gates passthrough (progressive SOF2, YCCK, 4-component-without-APP14, truncated, or probe-mismatched frames all fall through); non-passthrough JPEGs get one internal q82 re-encode; PNGs keep the lossless raw path. No wire change: no new option, no protocol change, fixed internal quality constant.
- **Reason.** The engine discarded JPEG compression entirely (decode → uncompressed raw RGB stream), so a 3 MB phone photo became ~14 MB in the PDF — 13 photos → 81 MB (F-14). Passthrough matches the img2pdf reference approach (PDF as container) with zero quality loss on the common path.
- **Alternatives considered.** Engine-wide `/FlateDecode` on raw (rejected: still ~2x the JPEGs). Lowering the app import budget/quality (rejected: punishes everyones quality to dodge an engine bug). User-facing quality slider (deferred: Compress tool territory).
- **Consequences.** Output size ≈ sum of input JPEG sizes; EXIF-rotated/progressive inputs still shrink ~10x via the fallback. Tests pin byte identity, DCT filter presence, and fallback dims.
- **Status.** Decided, implemented, verified (Rust 354 passing incl. 8 new passthrough/parser tests, E2E 43/43 + 4 SKIP).

## D18 — Images page manager uses the Rearrange list UX; PNGs normalize to JPEG at import

- **Decision.** `PageGrid` rewritten from a dnd-kit card grid to the Rearrange pattern: vertical rows (grip-handle framer-motion drag with pan-y scroll, position numbers, ↑/↓ arrows, click-to-preview modal reusing the page object URL — no new URLs), `reorderPages` pure helper + hook `reorder` for full-list commits. dnd-kit deps uninstalled; `pageDrag.ts` deleted. Separately: every Images entry path (scanner Import, Add-images, DropZone) runs pixel-budget normalization with mandatory PNG→JPEG conversion (white-filled, `.jpg` rename).
- **Reason.** Real-phone reports: (1) gallery PNG imports built 100 MB+ PDFs while camera JPEGs stayed small (F-16); (2) the grid reorder/preview UX lagged Rearrange and the user asked for parity.
- **Alternatives considered.** Keeping the dnd-kit grid and adding a preview modal (rejected: two drag systems to maintain; user explicitly asked for the Rearrange UX). PNG→JPEG only in the scanner (rejected: Add-images had the identical flaw).
- **Consequences.** Upload fixture names change (`red-wide.png` → `red-wide.jpg`) — E2E updated; E2E drag coverage moves from dnd-kit keyboard to handle pointer-drag; unit count changes (pageDrag suite gone, reorder/PNG suites added).
- **Status.** Decided, implemented, verified (unit 229, E2E 45/45 + 4 SKIP twice).

## D22 — P3 image-build sharding: parallel shards + ordered merge, small batches untouched

- **Decision.** Batches ≥8 pages shard across K device-aware engine jobs (`2–3` by `hardwareConcurrency`, 256 MiB in-flight cap, one shard per page max), each a plain `pdf.images_to_pdf` call through unchanged orchestration, merged in order via temp studio docs (closed in `finally`); below 8 pages the historical single call runs byte-for-byte. Progress is aggregated honestly, cancellation reaches every in-flight job, failures fail honestly with no silent retry. `ExecutionStrategy::Parallel` stays documented-but-unselected (comment-only) so the frozen `OperationCapabilities` contract is untouched — the illusion is resolved by construction, not deletion.
- **Reason.** PERFORMANCE.md P3: sharding is the highest-value parallelism on the stable toolchain (no nightly, no COOP/COEP); transfer+merge overhead wins small, so the threshold keeps small builds identical.
- **Alternatives considered.** Silent single-worker fallback on shard failure (rejected: doubles worst-case time and hides errors). Removing the `Parallel` variant (rejected: frozen-contract churn for zero behavioral gain).
- **Consequences.** Large image builds fan out K WASM jobs (memory ×K while sharded — hence the cap); small builds provably unchanged.
- **Status.** Decided, implemented, verified (engine 357, frontend 272, sharded 8-page E2E in order; builds clean).

## D21 — Naming-first downloads: smart defaults + custom names (all tools)

- **Decision.** Every tool completion renders a naming card instead of auto-downloading with an inline-invented filename: `downloadNaming.ts` (pure policy — per-kind smart defaults from input names, `sanitizeFileName` guaranteeing a safe `.pdf`), `DownloadCard` (Smart prefilled toggle / Custom blank slate, live `download` anchor carrying the exact final name, share with the same name, `DoneBanner` with the final name after first save), `MultiDownloadCard` for split multi-part (per-part editable rows + Download-all). Smart rules: merge `a-b-merged.pdf` / `first-plus<N-1>-merged.pdf`; rearrange/rotate/metadata `<base>-<op>.pdf`; split parts keep `-p<a>-<b>`; images `<page>.pdf` / `<first>-plus<N-1>-pages.pdf`. The `images.pdf` hardcode and all auto-download calls are gone; the card anchor is the single download trigger.
- **Reason.** Real-user report: outputs were literally named `featurename.pdf`; no smart naming existed and no naming UI at all.
- **Alternatives considered.** Keeping auto-download with smarter defaults only (rejected: the user explicitly asked for Smart-or-Custom choice before download). Wrapping `DoneBanner` with a rename prop (rejected: the pre-download naming step needs its own card; `DoneBanner` stays as the post-save re-save/share surface, unchanged).
- **Consequences.** Completion flows gain one tap (naming → Download); E2E drives the card (in-page capture asserts exact names). No engine/protocol/service changes; no new dependencies.
- **Status.** Decided, implemented, verified (frontend 257, E2E 52/52 + 4 SKIP; builds clean).

## D20 — Performance pass P2+P4: encode worker, bounded thumbnail encode, preview LRU, bench CLI

- **Decision.** Four behavior-preserving changes: (1) a dedicated `imageEncode.worker.ts` (OffscreenCanvas + `convertToBlob`, transferable bitmap) serves import normalization and shutter capture, with the verbatim main-thread path as fallback (first-failure latching; post-transfer failure poisons the worker and the single file errors in isolation); (2) thumbnail encodes run at bounded concurrency 2, order-preserving, same webp→jpeg→png chain (first-error rethrow after draining, all bitmaps released — strictly less leak than the old abort-mid-loop); (3) `studioPreview` gains a service LRU (cap 8, `renderId:pageNumber` keys) with revocation on eviction and on `closeStudioDoc` (same trade as the D6 thumb LRU: an evicted URL a caller still holds is revoked; unreachable through tool paths since remounts yield new doc ids); (4) engine `bench_operations` example (synthetic {1,10,50p} + optional read-only `--dir` corpus, `--repeat`/`--json`) and dev-only `perfMarks` attribution on the studio result (production shape unchanged, engine duration authoritative per D4).
- **Reason.** P2 moves the two heaviest main-thread encodes (import re-encode, shutter capture) off-thread for phone shutter/import feel; the preview LRU removes per-open full-res re-renders; P4 makes every future change (P0.2, P3) decidable with data instead of estimates.
- **Alternatives considered.** Deleting the zero-caller `copyBytes`/`getStudioBytes` (rejected: kept pending an out-of-tree-use audit — finding-15 assessment recorded in PERFORMANCE.md). Removing the scan `apply_mode` path as dead (rejected: it is live, tested core capability; only the UI selector is absent).
- **Consequences.** New worker bundles with the app (no new dependencies); `EncodeWorkerUnavailableError` is an internal control signal, never user-visible; E2E flows unchanged.
- **Status.** Decided, implemented, verified (engine 357, frontend 247, E2E 49/49 + 4 SKIP; builds clean).

## D19 — Performance pass P0+P1: owned inputs, cached page map, in-place rotate, detect-only live, single-getPage thumbnails

- **Decision.** Six optimizations, all behavior-preserving: (1) WASM glue takes ownership of input blobs (`mem::take`) instead of cloning per dispatch (D2 keeps the single JS→WASM copy); (2) `PdfDocument` caches its resolved page map with explicit invalidation, and all internal page loops use it; (3) `pdf.rotate` mutates its private parse in place instead of deep-copying every page (unselected pages now keep inherited ancestor `/Rotate` — more correct than the old flatten, pinned by the pre-existing inheritance tests; `page_geometry`'s documented accumulation quirk is unchanged); (4) `copy_pages_with_map` removes duplicate per-part validation in split/delete/reorder; (5) the scan live path is detection-only (protocol v2 `detected`, no warp/encode/bytes), detection borrows the RGB view instead of copying, and the glue accepts owned bytes; (6) `renderPage` fits to a `targetBox` and returns scale-1 geometry so a thumbnail needs one `getPage`, with a render-seeded dimensions cache.
- **Reason.** The PERFORMANCE.md audit ranked these as the highest-cost, lowest-risk items: avoidable full-file copies (main thread + WASM), O(N²) page-tree traversals, a per-page event storm, and per-thumbnail double `getPage` round-trips.
- **Alternatives considered.** Threaded WASM and the main-thread `slice()` removal were deliberately deferred (D-track decision: measurements first; both trade reproducibility or memory for latency). Re-adding the rotate deep copy to preserve the old ancestor-rotation drop was rejected: that behavior silently changed unselected pages.
- **Consequences.** Scan worker protocol bumped v1→v2 (`detectOnly`, `detected`); `RenderPageOptions.targetBox` + `RenderedPage.sourceWidth/sourceHeight` join the rendering contract; F-17 (live detection never fired) fixed as a byproduct.
- **Status.** Decided, implemented, verified (engine 357, scan 35, glue 5 new, frontend 240, E2E 46/46 + 4 SKIP; builds clean).
