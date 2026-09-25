# Folio — Bug & Known-Issue Registry

IDs are stable (`F-<n>`). "Resolved" entries stay recorded — they explain why the code looks the way it does. Only issues supported by code, tests, or observed behavior are listed; nothing here is invented.

## Active

### F-13 — Hard-cached PWA with no update path after a deploy

- **Status.** Resolved (update manager). **Area.** PWA/service-worker boundary (`app/src/pwa/`, `StudioApp.tsx`, `About.tsx`). **Severity.** High (after every deploy, mobile and desktop users sat on the stale precache with no in-app recourse — only a manual hard refresh, undiscoverable on phones).
- **Symptoms.** New versions deployed to Cloudflare Pages never surfaced in the installed/open app; users had to know to hard-refresh. `registerType: 'autoUpdate'` updated the worker silently in the background while the open page kept serving old chunks.
- **Root cause.** Nothing in the app ever called `registerSW` / listened for `onNeedRefresh`, so a waiting worker had no UI. Stale-chunk recovery (F-12) only fires after a lazy import already failed.
- **Fix.** Update manager adapted from the SYNAPSE repo pattern (D16): silent launch check, global one-tap `UpdateBanner`, About "App updates" card (manual check + diagnostics log), localhost/LAN guard.
- **Verification.** 14 manager unit tests (incl. snapshot-stability regression for `useSyncExternalStore`); canonical E2E 43/43 + 4 SKIP (new: About card checks and reports local status on dev, no stray banner).

### F-14 — Images → PDF output ~5× larger than the input photos (81 MB for 13 images)

- **Status.** Resolved (DCT passthrough). **Area.** Engine (`engine/src/processing/pdf/images_to_pdf/mod.rs`), engine-only — wire, protocol, and app untouched. **Severity.** High (the scanner's main output was unusable at scale: share failures, storage bloat).
- **Symptoms.** 13 phone/camera photos (~2–4 MB JPEGs each) built an ~81 MB PDF on a real phone.
- **Root cause.** The engine decoded every JPEG to raw pixels and embedded an _uncompressed_ stream (`w×h×3` bytes, no `/Filter`) — the original JPEG compression was discarded at the engine boundary. A 2500px photo entered as ~3 MB and left as ~14 MB.
- **Fix.** Baseline orientation-1 JPEGs embed byte-identical (`/DCTDecode`); progressive/YCCK/EXIF-rotated fall back to one internal q82 re-encode; PNGs keep the lossless raw path (D17).
- **Verification.** 8 new Rust tests (byte identity, DCT filter, fallback dims, parser gates incl. progressive rejection + Adobe CMYK); full Rust 354 passing, fmt/clippy clean; frontend 228 + E2E 43/43 + 4 SKIP unchanged (DCT renders identically in PDF.js).

## Known limitations (by design, not defects)

- **L1 — Compress disabled.** The Studio action stays disabled; no engine or UI implementation exists yet. See `docs/ROADMAP.md`.
- **L2 — Password-protected PDFs unsupported.** Reported as `UNSUPPORTED_FORMAT`, never attempted. UI copy: "This PDF needs a password, which is not supported yet."
- **L3 — Metadata empty-string set rejected.** Reading preserves `Some("")` distinctly from absent; _setting_ `""` is rejected — use `Clear` (engine rule, `engine/src/processing/pdf/metadata/`).
- **L4 — Inspect is structural only.** No text extraction, rendering, or image extraction (`engine/src/processing/pdf/inspect/mod.rs`).
- **L5 — Images → PDF is JPEG/PNG only.** Other formats fail as `UNSUPPORTED_FORMAT` (engine rule, `image` crate features `jpeg`+`png`).

## Resolved

### F-7 — Mobile bottom nav wrapping into two rows and covering content

- **Status.** Resolved. **Area.** Studio shell (`app/src/studio/StudioApp.tsx` `MobileNav`). **Severity.** Medium (footer and bottom content unreachable behind the nav on phones).
- **Symptoms.** The nav grid was `grid-cols-4` but held 8 destinations (Home + 7 tools), wrapping to ~135px-tall two rows while the page reserved only `pb-[76px]`; cells ~44px wide with 9.5px labels.
- **Root cause.** Grid sized when the tool list was shorter; never resized as tools grew to 7.
- **Fix.** Single-row horizontally scrolling strip (snap, hidden scrollbar, 56px touch height, 10px labels); page bottom padding (`pb-[92px]`) applied only when the nav renders.
- **Verification.** Frontend-only on a Rust-less machine: eslint clean, prettier clean, vitest 118/118. Full suite re-verified on the Rust-capable side 2026-09-23: Rust 345 tests, `fmt`/`clippy` clean, WASM build passing, typecheck/lint/format clean, 118 unit tests, production build (PWA SW, 34 precache entries, zero testbench strings), canonical E2E 21/21 + 4 SKIP without the optional corpus, optional suites exit 0 with explicit SKIP — baselines unchanged, patch bumped to v1.7.1.

### F-8 — Hero proof-line clipped on small phones

- **Status.** Resolved. **Area.** Home (`app/src/studio/Home.tsx`). **Severity.** Low (text cut off, no function lost).
- **Symptoms.** The "0 servers · 100% browser · ∞ free" row was `whitespace-nowrap` at 13px — wider than a 360px viewport — and body `overflow-x-hidden` clipped it.
- **Fix.** Wraps below `sm` (`flex-wrap`, kept single-line on larger screens).

### F-9 — Rearrange touch-drag capturing page scroll

- **Status.** Resolved. **Area.** Rearrange tool (`app/src/studio/tools/RearrangeTool.tsx`). **Severity.** Medium (primary reorder gesture unusable on touch; arrows were the only reliable path).
- **Symptoms.** Vertical `Reorder` list with no drag handle: touch gestures on rows were captured by drag instead of scrolling the page.
- **Fix.** Drag starts only from a grip handle (`dragControls` + `dragListener={false}`); rows keep `touch-action: pan-y` so the page scrolls normally. Arrow buttons enlarged (`px-3 py-1`); helper copy now names the handle.

### F-10 — Dead bottom padding on mobile Home/About

- **Status.** Resolved with F-7. **Area.** Studio shell. **Severity.** Low (76px empty space).
- **Symptoms.** `pb-[76px]` applied on every mobile page although the nav renders only inside tools.
- **Fix.** The padding applies only when the nav renders (`showMobileNav`).

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

### F-11 — Zoom slider reported wrong scale (control removed)

- **Status.** Resolved by removal (revisit with focal-accurate handling). **Area.** Scanner camera dock (`app/src/studio/tools/CameraCapture.tsx`, `cameraCapabilities.ts`). **Severity.** Medium (the control lied to users about the optical state).
- **Symptoms.** The zoom slider showed "1.0×" while the device was actually using its ultrawide lens (real ~0.6×) — the track's reported zoom range is a device-internal scale, not a focal-length multiplier, so any displayed value was misleading.
- **Root cause.** `MediaStreamTrack.getCapabilities().zoom` exposes an arbitrary per-device numeric range with no guaranteed mapping to focal length or lens choice; browsers/phones may switch physical lenses behind a single "1×" value.
- **Fix.** The zoom control (slider, state, `applyConstraints({ advanced: [{ zoom }] })` path, capability model field) was removed entirely; the camera dock keeps torch only. Documented for re-introduction (ROADMAP "Future / not committed") once a focal-accurate approach is available.
- **Verification.** Unit tests assert no zoom control renders even when the track reports a zoom range (`CameraCapture.test.tsx`, `cameraCapabilities.test.ts`); canonical E2E asserts `zoomControls === 0` in the scanner surface check.

### F-12 — Stale code-split chunk 404 after a deploy ("Failed to fetch dynamically imported module")

- **Status.** Resolved (recovery UX + cache retention). **Area.** Deploy/service-worker boundary (`app/vite.config.ts`, shared `ErrorBlock`, lazy engine-adapter import). **Severity.** High (builds fail with an undebuggable raw fetch error; user cannot proceed without knowing to reload).
- **Symptoms.** After a Cloudflare Pages deploy, an already-open page from the previous deployment failed its next lazy import (`.../assets/WasmWorkerEngineAdapter-<hash>.js` → 404) and surfaced the raw exception text as a red build error. Seen on a real phone mid-build with 44 images staged.
- **Root cause.** Deploy skew: the new service worker activates and (by default) deletes the previous deployment precaches, while the still-open old page keeps old chunk hashes that no longer exist on hosting. Retrying the operation can never succeed — only a reload to the current shell helps.
- **Fix.** Two layers: (1) `ErrorBlock` detects stale-chunk failures across bundler message shapes and renders "A new version of Folio was released…" with an explicit Reload button (raw URL kept as secondary diagnostics) — covers every tool at once, consistent with the existing lazy-route recovery copy. (2) `cleanupOutdatedCaches: false` so a new SW no longer deletes the previous deployment chunks out from under open pages (browser quota eviction is the backstop).
- **Verification.** New `ui.test.tsx` (bundler message shapes, null-safety, recovery rendering, ordinary-error passthrough); canonical E2E 41/41 + 4 SKIP.

### F-15 — Scanner viewfinder shrinks after the first capture (phone)

- **Status.** Resolved (stable layout). **Area.** Scanner shell (`app/src/studio/tools/CameraCapture.tsx`). **Severity.** Medium (framing gets harder with every capture; reported with before/after screenshots).
- **Symptoms.** Pre-capture the viewfinder filled the screen; after one capture it lost ~130px to three newcomers: the top bar wrapping onto two rows (View-pages CTA), the in-flow "Added as photo" note strip, and the session thumbnail strip.
- **Root cause.** The viewport flexes to leftover column space, so every in-flow sibling added post-capture stole from it directly.
- **Fix.** Top bar is single-row nowrap (truncating title, short "Pages (n)" CTA <400px, `shrink-0` buttons; device picker moved to the bottom hint row); the import note became a floating auto-dismissing (5s) pill over the viewport instead of an in-flow strip; the session strip stays in-flow below the dock (E2E layering contract) but slimmer with no duplicate safe-area padding.
- **Verification.** New E2E check: narrow-phone framing-box height before vs after first capture — 263px → 263px, pixel-identical; canonical E2E 44/44 + 4 SKIP.

### F-16 — Gallery PNG imports build 100 MB+ PDFs (camera JPEGs stayed small)

- **Status.** Resolved (PNG→JPEG at import). **Area.** App import path (`app/src/studio/tools/imageImport.ts`, `ImagesTool.tsx`). Engine untouched. **Severity.** High (same class as F-14, other half: scanner Import + Add-images gallery entries).
- **Symptoms.** Camera captures (always JPEG → DCT passthrough) built tiny PDFs, but gallery imports (PNG screenshots/photos retained byte-identical within budget) embedded as uncompressed raw RGB — 100 MB+ outputs.
- **Root cause.** `prepareImportFile` retained within-budget originals regardless of format; `addFiles` never normalized at all. PNG has no engine DCT path by design (lossless raw), so retained PNG bytes exploded.
- **Fix.** PNGs always convert to white-filled JPEG at import (budget-clamped, `.jpg` rename — truthful, matches scan naming); `Add images`/DropZone now run the same normalized `importFiles` path with progress text instead of raw `addFiles`. JPEG behavior unchanged (originals retained).
- **Verification.** New unit tests (PNG conversion identity, JPEG retention); E2E upload block updated for the rename + still builds; canonical E2E 45/45 + 4 SKIP.
