# Folio — Bug & Known-Issue Registry

IDs are stable (`F-<n>`). "Resolved" entries stay recorded — they explain why the code looks the way it does. Only issues supported by code, tests, or observed behavior are listed; nothing here is invented.

## Active

None. No open defects are known as of Phase 1. If verification finds one, add it here first, then fix it.

## Known limitations (by design, not defects)

- **L1 — Compress disabled.** The Studio action stays disabled; no engine or UI implementation exists yet. See `docs/ROADMAP.md`.
- **L2 — Password-protected PDFs unsupported.** Reported as `UNSUPPORTED_FORMAT`, never attempted. UI copy: "This PDF needs a password, which is not supported yet."
- **L3 — Metadata empty-string set rejected.** Reading preserves `Some("")` distinctly from absent; *setting* `""` is rejected — use `Clear` (engine rule, `engine/src/processing/pdf/metadata/`).
- **L4 — Inspect is structural only.** No text extraction, rendering, or image extraction (`engine/src/processing/pdf/inspect/mod.rs`).
- **L5 — Images → PDF is JPEG/PNG only.** Other formats fail as `UNSUPPORTED_FORMAT` (engine rule, `image` crate features `jpeg`+`png`).

## Resolved

### F-1 — WASM wall-clock panic (`std::time` on `wasm32-unknown-unknown`)

- **Status.** Resolved. **Area.** Engine timing (`engine/src/core/clock.rs`, `engine/src/observability/timing.rs`). **Severity.** High (every timed WASM execution would panic).
- **Symptoms.** `std::time::{SystemTime, Instant}` panic on the WASM target (verified against the toolchain's `sys/pal/wasm`).
- **Root cause.** The WASM target has no OS clock backend for Rust `std::time`.
- **Fix.** Platform clock abstraction: native uses `std::time`, WASM uses JS-backed clocks via `js-sys` (WASM-only dependency, gated by target cfg). Documented in `Cargo.toml` comments.
- **Verification.** WASM build passes; `engineDurationMs` reported correctly in browser E2E (e.g. merge completion metadata).
- **Related lesson.** `docs/LESSONS.md` L-1.

### F-2 — PDF.js ArrayBuffer detachment neutering engine bytes

- **Status.** Resolved. **Area.** Rendering intake (`app/src/rendering/PdfJsRenderEngine.ts`). **Severity.** High (data corruption vector).
- **Symptoms.** PDF.js detaches (neuters) the buffer handed to `loadDocument`; sharing the studio store's buffer would destroy the document bytes.
- **Root cause.** Transfer semantics of the PDF.js loading API.
- **Fix.** Defensive copy at the rendering boundary; the studio store keeps the original.
- **Verification.** Comment at `PdfJsRenderEngine.ts:128`; E2E operates on documents after rendering intake with no corruption.
- **Related lesson.** `docs/LESSONS.md` L-2.

### F-3 — Unbounded thumbnail canvas / object-URL retention

- **Status.** Resolved. **Area.** Studio thumbnails (`app/src/studio/services/folio.ts`). **Severity.** High (tab memory growth, fatal on large files).
- **Symptoms.** Canvases and object URLs accumulated per thumbnail with no release; large documents ballooned memory.
- **Root cause.** No ownership discipline for transient render artifacts.
- **Fix.** Canvas bitmaps released on URL encode; object-URL cache LRU-bounded to 6 documents with revocation on evict/close; windows of 24 pages at concurrency 2.
- **Verification.** Large-file E2E: 2585-page document renders 24 thumbnail images, zero console errors.
- **Related lesson.** `docs/LESSONS.md` L-3.

### F-4 — Unbounded engine event-log growth (Testbench store)

- **Status.** Resolved (by removal + bounding discipline). **Area.** Former Developer Testbench (`stores/testbench.ts`, since deleted). **Severity.** Medium (dev-tool DOM/memory growth).
- **Symptoms.** Unbounded `pastExecutions` map retained full event histories; documented in the root `ARCHITECTURE.md` developer-console notes.
- **Root cause.** History retained without bound for developer inspection.
- **Fix.** Testbench application removed from the product entirely; production paths never retain unbounded event lists (`EngineExecution.events` is per-job and job-scoped).
- **Verification.** Production bundle scan: zero testbench strings; E2E passes with no DOM growth assertions failing (bounded 24-image DOM on the large file).
- **Related lesson.** `docs/LESSONS.md` L-4.

### F-5 — Cancellation lifecycle races

- **Status.** Resolved. **Area.** Studio jobs + engine cancellation (`folio.ts` `runStudioOperation`, `engine/src/execution/cancellation.rs`). **Severity.** High (untrusted cancel button).
- **Symptoms.** Cancel issued before the adapter handle existed could be lost; thumbnail work survived document close.
- **Root cause.** Async handle creation vs. synchronous user intent; independent thumbnail job lifetimes.
- **Fix.** `cancelled` flag races safely with handle creation (cancel-after-create guaranteed); thumbnail jobs tracked per document and cancelled en masse on close; `CANCELLED` is a terminal status with its own code and message.
- **Verification.** E2E `merge cancellation surfaces honestly in UI`; large-file E2E exercises cancellation paths.
- **Related lesson.** `docs/LESSONS.md` L-6.

### F-6 — Merge progress scale misreporting

- **Status.** Resolved during v1.7.0 integration. **Area.** Studio Merge tool progress plumbing. **Severity.** Medium (dishonest progress).
- **Symptoms.** Progress fraction did not reflect the engine's reported scale.
- **Root cause.** UI-side progress computation instead of direct engine-event mapping.
- **Fix.** Progress renders engine `percentage`/`message` directly (see `docs/WORKLOG.md` v1.7.0 entry).
- **Verification.** E2E merge assertions on real progress labels.
- **Related lesson.** `docs/LESSONS.md` L-5.
