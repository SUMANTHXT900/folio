# Full-repo audit research brief (handoff document)

**Status: research round complete — P0–P3 fix waves implemented 2026-10-20 (see
`docs/WORKLOG.md` 2026-10-20 fix-waves entry); full gate green (engine 433,
frontend 783, build 53 entries / 7896.14 KiB, E2E 104/104 + 4 SKIP).
Deferred-with-handoff: batch render‖encode interleave, isolation-loop bound,
full useStudioJob, strip-helper unify, ORT runtime integrity pin, rearrange
fallback-selector removal (next E2E run). BUGS.md promotion: none — every
reproduced item was fixed + test-pinned in-session; F-22 stays open (field
confirmation pending). The findings below remain the evidence record.**
Twenty specialist review agents reported 2026-10-20 (this chat session).
Nothing below is committed, scheduled, or promised. Findings are static-analysis
(read in-tree, file:line-verified) — none were reproduced at runtime here.
When direction is chosen, record it in `docs/ROADMAP.md` + `docs/DECISIONS.md`
per `AGENTS.md`. Confirmed bugs graduate to `docs/BUGS.md` only after
reproduction; until then this file is the single source for the audit.

> **Reuse pattern.** Follows the `docs/scanner-v2.1-research.md` handoff shape
> (baseline → constraints → findings → phasing → deferred → hooks →
> validation), per the `AGENTS.md` research-brief convention.

## How to use this document (remote agents start here)

1. Read `AGENTS.md`, then `docs/PROJECT.md`, `docs/STATUS.md`,
   `docs/ARCHITECTURE.md`, `docs/BUGS.md` (F-22 active; F-21/F-23 resolved
   2026-10-18), `docs/DECISIONS.md` D46–D54.
2. This file is the complete output of the 2026-10-20 audit round. It is
   self-contained: you do not need the original chat session.
3. Scope of research: whole-repo review for bugs, security vulnerabilities,
   code-quality issues, and UI/UX defects/improvements — plus a fix plan.
   No code was changed by any agent in this round.

## 1. Baseline: what was audited (verified in source)

- Engine core: `engine/src/core/`, `execution/`, `observability/` (agent A1).
- Engine operations: all 10 ops in `engine/src/processing/pdf/` + `engine/tests/`
  (agent A2). Validation-before-mutation and atomicity hold in all 10 ops.
- WASM/worker boundary: `wasm/src/`, `app/src/engine/` incl. worker, protocol,
  binary store (agent A3). `mem::take` discipline clean; terminal-100 cannot be
  lost; cancel-before-ready settled-guarded.
- Rendering/thumbnails: `app/src/rendering/` + `usePageThumbs` (agent A4). No
  F-2 neuter gap (`data.slice()` at `PdfJsRenderEngine.ts:145`).
- Studio service: `folio.ts` (1548 lines) + `downloadNaming.ts` +
  `PendingTransfer` handoff + `types/engine.ts` (agent A5).
- PDF tools: Merge/Split/Rearrange/Rotate/Metadata (agent A6). P5-1
  remove-discipline and F-19/F-20 portal anchoring correct.
- Images pipeline: ImagesTool, PageGrid, imagePages/Prepare/Import/Sharding,
  encode worker (agent A7). No P5-2 viewer bug (id-keyed); sharded temps close
  in `finally`.
- Scanner: ScanicCapture/Review + `scan/` client/policy/drain (agent A8).
  Shutter path F-22-clean; L-24/L-25 clean.
- Shell/PWA: StudioApp/Home/About/components + `app/src/pwa/` + theme (agent A9).
- Config/build/E2E harness: manifests, vite config, `_headers`, e2e (agent A10).
- Specialist passes: staff code review of engine (R1), full-stack security (R2),
  app-surface security (R3), engine+app performance (R4), WCAG 2.1 AA audit (R5),
  honest-UX audit (R6), simplification sweep (R7), test-gap analysis (R8),
  error-path audit (R9), bundle/offline audit (R10).

Meta-routing (via `using-agent-skills`): review task →
`code-review-and-quality` + `security-and-hardening` +
`performance-optimization` + `frontend-ui-engineering`, supported by
`debugging-and-error-recovery`, `browser-testing-with-devtools`,
`code-simplification`; merge → `planning-and-task-breakdown` +
`documentation-and-adrs`. Orchestration: parallel fan-out with merge, read-only.

## 2. Hard constraints (this round respected these; fix waves must too)

- Read-only: zero source edits in this round; every finding carries file:line
  evidence; nothing invented.
- Folio invariants stand: engine contract frozen (D9), binary ownership (D5),
  single-owner preview URLs (D26), zero-encode shutter path, 10MB precache cap
  with 9MB alarm, WASM single-threaded baseline.
- `docs/BUGS.md` admits only code/test/observation-backed issues — §3 items
  graduate there after reproduction, not before.
- L-15 applies to fix waves: one owner per file set, contracts locked up front.

## 3. Findings (deduplicated, ranked; agent source in brackets)

### 3.1 Release-blockers (fix before any release claim)

- **AUD-1 [R1] Engine panics on untrusted input (byte-slice).**
  `engine/src/processing/pdf/core/loader.rs:80` (`&text[..500]` splits UTF-8)
  and `images_to_pdf/mod.rs:574` (`&flat[..300]` byte-slice after char count).
  Panics in the WASM engine on attacker-influenced strings. Fix: char-boundary
  truncation. (Peer note: `timing.rs:78` expects re-graded non-finding.)
- **AUD-2 [R9] Silent wrong-data success on wire mismatch.**
  `app/src/engine/engineResult.ts:137-184,245-251` — blind `as` casts; a
  mismatched summary yields `{pageCount: undefined}` success instead of the
  documented throw-to-`INTERNAL` (`WasmWorkerEngineAdapter.ts:496-506`).
  Fix: presence/type-guard translation.
- **AUD-3 [R9] `INVALID_PAGE_RANGE` is dead code.**
  `engine/src/core/error.rs:18,46` — zero constructions repo-wide; empty
  selection returns `InvalidInput`, so `OPERATIONS.md`'s promised range errors
  and the UI `ERROR_TEXT` branch are unreachable. Fix: construct it or remove
  it from the contract docs.

### 3.2 High severity

- **AUD-4 [A6/R5] Keyboard-unreachable drag handles.**
  `MergeTool.tsx:82`, `RearrangeTool.tsx:53` (`span role="button"`, pointer-only,
  no tabIndex/keys). Core reorder gesture is mouse-only.
- **AUD-5 [A6] Split preview dead-click.**
  `SplitTool.tsx:555` — falsy `thumbs[preview]` renders nothing: no error, no
  fallback. Failed thumb = dead click.
- **AUD-6 [R5] Dialog semantics missing on all three preview overlays.**
  `PageGrid.tsx:391-392`, `SplitTool.tsx:584-585`, `RearrangeTool.tsx:521-522`:
  no `aria-modal`, no Escape, no focus trap, backdrop-click only.
- **AUD-7 [R5] Home heading skip + no skip link.**
  `Home.tsx:198,300` (h1→h3, no h2); `StudioApp.tsx:296-313` (no
  skip-to-content; header re-traversed every route).
- **AUD-8 [A10] Stale lockfile.**
  `app/package-lock.json` pins 1.10.1 vs `app/package.json` 1.12.2 —
  frozen/CI installs unreproducible. Fix: regenerate + commit.
- **AUD-9 [A10/R2] Zero security headers.**
  `app/public/_headers` sets only `Cache-Control`; no CSP/HSTS/X-Frame-Options/
  X-Content-Type-Options/Referrer/Permissions-Policy, no CSP meta in
  `index.html`. R2: a single future `innerHTML`/URL-scheme slip becomes full
  XSS with no second layer. Fix: `default-src 'self'`-class policy first.
- **AUD-10 [R4] Unthrottled per-page progress in 5 ops.**
  `extract/mod.rs:148-159` (+ delete, reorder, inspect-detailed, images_to_pdf)
  report + `format!` per page; only merge/split/rotate use `ProgressThrottle`.
  Glue coalesces the wire but WASM still pays construction per page (2585-page
  class). Fix: extend throttle.
- **AUD-11 [R4] Thumb-cache 400-cap churn on large docs.**
  `folio.ts:621,704-733` + `usePageThumbs.ts:108-119` — every eviction past 400
  blanks the whole thumb array and resets progress: churn, not misses, on the
  2585-page class. Fix: incremental eviction.
- **AUD-12 [R4] Scan page decoded 3× at full res on the main thread.**
  `ScanicCapture.tsx:660-696,1989,2159,2301-2328` — drain decode + warp
  re-decode + commit `prepareImportFile` decode (~36MB sync longtask each at
  12MP). INP risk on phones. Fix: decode-once + handoff (measured).
- **AUD-13 [R9] Thumbnail hook swallows structured errors.**
  `usePageThumbs.ts:253-255,194-196,286-288` — `load()` rethrows codeless
  `Error('Could not render page previews.')`; background/fill-all `catch {}`
  swallow window errors; holes masquerade as done. Fix: propagate codes.
- **AUD-14 [R6] "0 servers" absolute claim.**
  `Home.tsx:218-243,195,207` vs `updateManager.init()` silent `reg.update()`
  ~3s after launch + hourly checks. `docs/PROJECT.md:49-50` deliberately avoids
  this claim. Fix: honest network copy.
- **AUD-15 [A9] InstallCard retry promise that cannot exist.**
  `InstallCard.tsx:57` promises retry; `installPrompt.ts:184` nulls the one-shot
  prompt so `InstallCard.tsx:62` hides the button. Fix: copy or lifecycle fix.
- **AUD-16 [R10] First-paint bundle carries About + full framer-motion + 9 font
  subsets.** `StudioApp.tsx:4-5` (About static, should be `lazy()`),
  `main.tsx:3-4` + precache glob (~290KB unused subsets), motion sync on first
  paint. Fix: lazy About, subset glob to latin(+ext), motion-lite/split.
- **AUD-17 [R8] Mid-run cancel proven for 2/10 ops.**
  `audit_cancel_midrun.rs` covers images_to_pdf + merge only; 8 ops prove the
  first checkpoint, not per-item loops. Fix: `CancellingSink` pattern × 8.

### 3.3 Medium severity (selected; full agent reports in session)

- Engine: scheduler discards strategy silently (`scheduler.rs:132`), no
  pre-cancel check (`:122`), `Cancelled`-derivation without token cross-check
  (`result.rs:64`), `Job`/`JobState` dead parallel truth (`job.rs:109`),
  wall-clock `completed_at` vs monotonic `duration` (`scheduler.rs:135`),
  `VecEventSink` poison panic (`logger.rs:45`), merge size-gate ignores
  engine-built docs (`merge/mod.rs:241`), rotate zero-page misreport
  (`rotate/mod.rs:189`), geometry/effective_rotation fail-open vs fail-closed
  (`document.rs:486,523`), reorder O(n²) duplicate check (`reorder/mod.rs:216`),
  rotate "copying pages" phase lie (`rotate/mod.rs:215`), cancels logged at
  Error (`scheduler.rs:173`), whitespace-only metadata accepted
  (`write.rs:162`), Latin-1 C1 corruption (`document.rs:649`), caller-map
  untied to source (`copy.rs:96`).
- Bridge/workers: version-mismatch silent hang, no per-job timeout
  (`WasmWorkerEngineAdapter.ts:348`); mock jobId shape collides with engine ids
  (`MockEngineAdapter.ts:134`); crash-seal `IO_ERROR` vs init-fatal `INTERNAL`
  (`:222-243`); duplicate-100% always forwards (`lib.rs:274`); backward-% jump
  swallowed (`lib.rs:271`); binaryStore unbounded in-scope
  (`binaryStore.ts:19`); engine worker trusts input shape (`engine.worker.ts:77`);
  scanic import + share swallows (`DefaultPdfThumbnailEngine.ts:286`,
  `folio.ts:1419-1465`).
- Rendering/thumbs: loadDocument validates after converting — raw TypeError, not
  `RENDER_INVALID_INPUT` (`PdfJsRenderEngine.ts:124`); background-fill no
  liveness recheck → revoked URLs in state (`usePageThumbs.ts:183`); fillAll vs
  backgroundFill double windows past concurrency-2 (`:248,262`); unbounded
  `generateDocumentThumbnails` page list (`DefaultPdfThumbnailEngine.ts:510`);
  list-tier cache hit served to grid surfaces, no fit check (`usePageThumbs:241`,
  F-23 residual); `box<=0` poisons pages (`:218`); aborted wave leaves spinner
  (`:253`); shared-canvas clobber (`PdfJsRenderEngine.ts:332`); cancel latency
  one render (`DefaultPdfThumbnailEngine.ts:359`).
- Service: PendingTransfer overwrite orphans docs+URLs (`folio.ts:370,387`);
  adopt dual-ownership store-vs-UI (`:334`); THUMBNAIL_* bypasses toStudioError
  (`:1169,1177`); preview-LRU evict has no invalidation channel (`:1239`);
  stagedIds never pruned on close (`:269`); output-resolve INTERNAL leaks later
  refs (`:577`); fallback-verbatim sanitize bypass (`downloadNaming.ts:76`,
  also R3-Med via ContinueCard `sourceName`); ErrorCode closed-enum vs
  THUMBNAIL_*/RENDER_* reality (`engine.ts:32`); adopt misattributes
  `pdf.inspect` (`folio.ts:192,208,343`); `getStudioBytes` hands live mutable
  ref (`:214`).
- Tools: stale done/error across Clear/remove/file-swap (Merge `:182-190`,
  Rotate `:388`); zero-rotation Download enabled (`RotateTool.tsx:484`);
  "All parts saved" unverified (`DownloadCard.tsx:318`); Compress in MobileNav
  despite disabled (`StudioApp.tsx:498`); sub-44px targets — arrows, pills,
  spins, handles (Merge/Rearrange/Split/Rotate); Split/Rearrange tiles lack
  F-18 recovery (`SplitTool.tsx:60`); stale-chunk regex gap in RouteErrorBoundary
  (`StudioApp.tsx:51`); update activation 8s×2=16s worst case
  (`updateManager.ts:469-486`).
- Images: unmount-mid-import URL leak (`useImagePages.ts:157`); camera pages
  blind the pixel gate (`ImagesTool.tsx:161,253`); dead Cancel during staging
  (`jobRef` null till `:263`); rotation re-encode skips pixel clamp
  (`imagePrepare.ts:81`); zero-pixel batches keep byte-only gating
  (`imageSharding.ts:210`); PNG-magic gap (`imageImport.ts:88`); worker-boot
  latch no retry (`:304`); healed-row resync gap (`PageGrid.tsx:77`);
  snapshot double-draw fallback (`imagePrepare.ts:107`).
- Scanner: eager-warp paging victim stuck on "Processing auto-crop…", no retry
  (`ScanicCapture.tsx:2153,2270,2191`); Re-detect duplicates drain detect on
  shared lane 0 (`:1195,1256,476`); stale-warp commit over fresh redetect
  (`:2184`); global warpInflightRef seq collision (`:2168,2148`); StrictMode
  probe skip (`:1587`); mount cleanup never stopTracks (`:1012`); cancelled
  items drift progress (`reviewDetection.ts:92`); `useScanicProcessor` unmount
  never terminates worker (`:327`).
- Shell/PWA: MobileNav includes reserved Compress (`StudioApp.tsx:498`);
  Compress focus dead end (`Home.tsx:327`); DownloadCard success unverified
  (`:318`); theme toggle static label (`StudioApp.tsx:380`); InstallCard dead-end
  card (`:80`); nav mask clips focus (`StudioApp.tsx:470`); ink-400 3.8:1 at
  text-xs (`studio-theme.css:17`).
- Honesty extras: About "· dev" label on production (`About.tsx:44-56`);
  Compress level radios with zero consequence (`CompressTool.tsx:60-88`);
  Compress `tabIndex=0` dead div (`Home.tsx:321-333`); UI-blended chained
  progress (`RotateTool.tsx:262-271`); staging→engine bar jump-back
  (`ImagesTool.tsx:238-261`); single-output saved-before-verified
  (`DownloadCard.tsx:148-154`); confirm-free discards of irreplaceable captures
  (`ScanicCapture.tsx:2238`, `ScanicReview.tsx:1253`, `ImagesTool.tsx:343`);
  no-op "Done" celebrations (identity rearrange, 0ms rotate, empty patch);
  ToolFallback infinite spinner (`StudioApp.tsx:20-27`).
- Config/E2E: immutable-1yr on unhashed model bytes (`_headers:7`);
  ~40 bare E2E predicates, L-11 by comment only (`studio.e2e.mjs:597`);
  Windows-only Chrome path, no env override (all 6 e2e files); no canonical
  offline-request guard (`studio.e2e.mjs:165`); no engines/packageManager pin +
  caret ranges (`package.json:2`); fs.allow wider than served (`vite.config:158`);
  caret Rust deps, no cargo-deny (`Cargo.toml:17`); ORT 1.27 JS vs 1.23.2 wasm
  skew risk (`VERSIONS.md:33-49`); dead install screenshot ships
  (`install-about.jpeg` 63KB); CompressTool lazy chunk for a stub.
- Tests: binaryStore unbounded + untested (`binaryStore.ts:19`, no test file);
  `errorData` casts untested (`engineResult.ts:245`); retained-jobs eviction +
  FakeWorker ordering untested (`WasmWorkerEngineAdapter.ts:581`);
  L-11 totality comment-only, no `total()` wrapper; handoff clear-without-take
  byte accounting untested (`folio.ts:385`); D53 shutter-guard overlapping-tap
  test missing; loupe LRU evict/release untested (`ScanicReview.tsx:603`).

### 3.4 Low severity / hygiene

- Bidi-override chars pass filename sanitizer (R2); unbounded metadata values
  (R2); advisory-only 150MB gate (R2); engine-message internals in UI (R2);
  unvalidated stored deviceId (R2); `--no-sandbox` in committed harnesses (R2);
  precache accumulation unmonitored (R2); vendored ORT bytes no integrity pin
  (R2); error secondary leaks filenames (R3); DoneBanner no last-mile sanitize
  (R3); download-URL 60s retention no unmount revoke (R3); scroll-behavior vs
  reduced-motion (R5); input focus 1px-only indicator (R5); ContinueCard focus
  invisible (R5); completion/file errors not announced (R5); SubProgressMapper
  unchecked (A1); InvalidInput vs InvalidDocument split (A1); success/failure
  ctors unconstrained (A1); copy error detail poorer than split (A2); over-max
  DPI unpinned (A2); YCCK-transform-1 unpinned (A2); EXIF 2/4/5/7/8 unasserted
  (A2); engine-level DCT edge cases absent (A2); K2 unit-only (A2).

### 3.5 Positive confirmations (do not "fix")

- Validate-before-mutate + atomic outputs hold in all 10 ops; DCT passthrough
  byte-identity pinned; shutter zero-encode invariant holds; worker message
  validation strong on scan/encode/main routers; upload chain defense-in-depth
  (extension→magic→engine caps→isolated render); camera tracks stopped on all
  exits; `toolUsage.ts` shape-validation exemplary; precache ~8.0MB healthy.

## 4. Phasing (proposed — pick before implementing)

- **P0 safety (1 day, engine + service owners).** AUD-1 panics, AUD-2 wire
  guards, AUD-8 lockfile regen, AUD-9 CSP baseline, AUD-5 dead-click fallback.
  Gate: `cargo test` + new panic/guard tests, build green.
- **P1 correctness (2–3 days).** AUD-3 dead code resolve, AUD-10 throttle × 5,
  AUD-13 error propagation, transfer-orphan close (`folio.ts:370`), cancel
  mapping (`IO_ERROR` + tool `setError` codes), AUD-17 mid-run cancel × 8.
  Gate: engine + frontend suites green.
- **P2 UX honesty + a11y (2 days).** AUD-4/6/7 keyboard+dialog+headings+skip
  link, 44px pass, focus indicators, live regions; AUD-14 copy fix; About dev
  gate; Compress dead/interactive controls; success-before-verification cards.
  Gate: axe + keyboard walk + targeted E2E.
- **P3 measured perf (gated on spans).** AUD-11 eviction, AUD-12 decode-once,
  batch canvas retention, serial isolation loop, drain O(Q²) maps, staging
  triple-buffer, serial intake, shard fan-in caps, webp-fallback tax. Phased
  per PERFORMANCE.md protocol: bench + mid-tier-phone trace before/after each
  fix. F-22 field confirmation rides here.
- **P4 simplification + tests (ongoing).** `usePendingTransfer` +
  `useStudioJob` extraction, `cancelledError(tool)`, shared `truncatedCause`,
  stale-comment sweep; binaryStore caps, `errorData` allowlist, E2E portability
  (env Chrome), offline flow, `total()` predicate wrapper, handoff accounting,
  D53 tap test, loupe evict test.

## 5. Deferred (explicitly not now)

- Full-suite + canonical E2E re-run: laptop-side (standing split).
- Real-device validation: shutter feel (F-22 open), P3 numbers, a11y screen
  readers, install prompts.
- Model/headers final form (immutable scoping, ORT pair assertion, integrity
  pin) with the next scanic bump.
- `docs/BUGS.md` promotion of §3 items: only after reproduction.

## 6. Hooks (file-ownership map for parallel fix agents, L-15)

| Lane | Files (exclusive) | Skill |
| ---- | ----------------- | ----- |
| Engine-safety | `engine/src/processing/pdf/core/loader.rs`, `images_to_pdf/mod.rs`, `core/document.rs`, `core/error.rs` | test-driven-development |
| Engine-lifecycle | `engine/src/execution/*`, `core/result.rs`, `core/copy.rs`, op loops (extract/delete/reorder/rotate/inspect) | test-driven-development |
| Bridge | `wasm/src/lib.rs`, `app/src/engine/*` | code-review-and-quality |
| Render/thumbs | `app/src/rendering/*`, `usePageThumbs.ts` | debugging-and-error-recovery |
| Service | `folio.ts`, `downloadNaming.ts`, `types/engine.ts` | code-review-and-quality |
| Tools-PDF | Merge/Split/Rearrange/Rotate/Metadata tools | frontend-ui-engineering |
| Tools-Images | ImagesTool/PageGrid/image* | frontend-ui-engineering |
| Scanner | ScanicCapture/Review + `scan/` | debugging-and-error-recovery |
| Shell/PWA | StudioApp/Home/About/components/`pwa/`/theme | frontend-ui-engineering |
| Config/E2E | manifests, vite config, `_headers`, `app/e2e/*` | security-and-hardening |
| Docs | `docs/*` only | documentation-and-adrs |

## 7. Validation (every fix wave)

- Rust: `cargo test` (engine/), `fmt --check`, `clippy --all-targets`.
- Frontend (app/): `build:wasm`, typecheck, lint, `format:check`, `npm test`,
  production build (precache ≤9MB alarm / 10MB cap).
- E2E: canonical `studio.e2e.mjs` green; new assertions only for user-visible
  behavior (L-11 total predicates, L-12 dispatch→wait→measure, L-16 exact
  control waits).
- Docs: `STATUS.md` baselines in the same commit; `WORKLOG.md` entry;
  `CHANGELOG.md` only on releases; `BUGS.md` only on reproduced bugs.
- Never invent numbers: lane-reported stays lane-reported until the
  orchestrator observes it.
