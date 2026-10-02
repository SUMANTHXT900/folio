# Scanner v2.1 research brief (handoff document)

**Status: research only — no implementation, no decisions recorded.**
Six specialist research agents reported 2026-10-01 (chat session `ses_f319c1318ffeQwmrFty2bogUFH`).
Nothing below is committed, scheduled, or promised. When direction is chosen,
record it in `docs/ROADMAP.md` + `docs/DECISIONS.md` per `AGENTS.md`.

> **Reuse pattern.** This file is the template for all future research
> handoffs: lowercase `docs/<topic>-research.md`, same section shape
> (baseline → constraints → findings → phasing → deferred → hooks →
> validation), status header always stating research-only until direction
> is chosen. See `AGENTS.md` research-brief convention.

## How to use this document (remote agents start here)

1. Read `AGENTS.md`, then `docs/PROJECT.md`, `docs/STATUS.md`, `docs/ARCHITECTURE.md`
   (scan worker boundary + scanner integration sections), `docs/DECISIONS.md` D15.
2. This file is the complete output of the v2.1 scanner research round. It is
   self-contained: you do not need the original chat session.
3. Scope of research: making the automatic crop and capture experience
   next-level. OCR, cloud processing, and ML models were out of scope.

## 1. Baseline: what v2.0 does today (verified in source)

- Pipeline (`scan/src/`): detect (Otsu → closing → Canny → `find_contours` at
  800px, ≤8 area-ordered contours, centroid-rotated RDP with exactly-4 rule,
  `validate_quad` + 0.5 edge-support gate, largest-wins, spine-split
  horizontal merge) → `warp_quad` (output capped `MAX_OUTPUT_LONG_EDGE=2500`)
  → `enhance::apply_mode` (Original passthrough / Grayscale Rec.601 in place /
  B&W local-mean adaptive via u64 integral image) → JPEG q92 (`warp.rs:SCAN_JPEG_QUALITY`).
- App (`app/src/studio/tools/scan/` + `CameraCapture.tsx`): dedicated scan
  worker, versioned protocol (v2: `detectOnly` request flag + `detected`
  result status), `ScanWorkerClient` gateway (lazy init, transferable bytes,
  epoch-guarded staleness, terminate-to-cancel).
- Review: processed scans require explicit accept (Use scan / Use original /
  Retry / Discard); no-boundary captures auto-accept as photos with a
  transient note; originals retained in `scanStore` per page id.
- Live detection: ~160px JPEG frames at 500ms ticks, guidance-only
  ("Document detected" pill); shutter always re-detects at full resolution;
  live corners are never reused. Single capture experience
  (`CORE_MODE = 'original'`); no mode selector, no manual corners,
  no auto-capture, no lighting cleanup.

## 2. Hard constraints (every proposal below respects these)

- On-device only. No cloud, no network calls in the scan path.
- WASM-compatible: wasm32-unknown-unknown, single-threaded worker,
  wasm-pack build. Current scan WASM ≈ 542KB — stay near it.
- No OpenCV (ruled out: ~8MB WASM minimum, Emscripten toolchain,
  threading needs COOP/COEP — evidence in §8).
- No ML models/runtimes this round (deferred, see §8).
- Memory discipline: no full-res bytes in React state; bounded/sequential
  processing; never hold two full-res buffers longer than necessary
  (32-bit 4GB-capped WASM linear memory).
- Engine contract stability: operation IDs, worker protocol shape,
  `folio.ts` orchestration unchanged unless proven necessary.
- Every automatic step needs a manual override (quad adjust, retake,
  mode choice). Autosuggest, never autocommit.
- Downscale-then-refine: detect on a small proxy (≤1000px), map quad back
  to full-res for warp/output.

## 3. Auto-crop quality / boundary refinement

Failure modes of contour detection on real photos: cluttered backgrounds,
low-contrast edges, shadows, rounded pages, partial occlusion (global Otsu
collapses; texture loops flood candidates; non-quads never pass exactly-4 RDP).

- **Option A — Quad scoring (recommended first step).** Replace
  largest-passing-wins with a weighted score (area fraction + aspect sanity
  via A/DIN-ratio bands as mild penalty + edge-support + 90°-deviation
  plausibility) over the ≤4 passing candidates; confidence = score blend.
  ~0.5KB binary, <0.1ms, zero memory. Hook: new `score_quad()` in
  `scan/src/detect.rs`; winner = argmax. Creates the scoring slot that
  refinement and confidence-gating plug into.
- **Option B — Edge refinement.** Snap each winning edge (±3px normal
  search for max Sobel response on 800px gray at N samples per side),
  least-squares refit 4 lines, intersect → refined corners. 2–5px tighter
  crops, kills RDP jitter; ~100 lines, ~1–2ms, stack-only memory. Hook:
  post-pass in `detect.rs` before upscale; `warp.rs` untouched.
- **Option C — Multi-frame fusion + quality gate.** 3–5-frame corner
  history from live ticks in `useScanProcessor.ts` (4×2 floats, no frames
  retained), EMA-smooth + jitter-reject; shutter seeds full-res detection
  and prefers the candidate nearest the smoothed prior. Composite
  confidence (edge-support × stability × area-frac × frame-edge margin);
  below threshold → existing fallback auto-accept-as-photo path.
  ~30 lines Rust (optional prior param via `wasm.rs`/`scanProtocol.ts`)
  - ~30 lines TS. Cross-aspect mapping (160px tick vs shutter frame)
    needs scale care.

## 4. Manual corner adjustment UX

Industry consensus (Adobe Scan, Apple Notes, CamScanner): 4 draggable
corner dots on the **original photo** (not the warped preview), dimmed
surround, tappable edge lines, long-press magnifier loupe offset above
finger, pinch zooms photo (never moves corners). No `warp_quad` changes
needed: drag in screen space → contain-rect mapping (`scanViewport.ts`)
→ image px → full-res input coords; convexity via cross-product-sign
check (cheap TS port of `validate_quad:162-182`); clamp to bounds; keep
TL/TR/BR/BL roles fixed (never re-run `order_corners` mid-drag — roles
swapping under the finger is the classic bug); seed once from auto
`result.corners`, fallback 90% inset rect.

- **Recommended: Adjust-crop mode on original photo.** "Adjust crop"
  button in the processed review panel → editor (original from retained
  `pending.original`, SVG quad overlay) → Confirm posts re-warp job /
  Cancel restores auto result. Overlay-only feedback during drag (free
  polygon redraw) + debounced re-warp on release/300ms idle at ≤800px
  preview; full-res only on Confirm. Cost M: new `CropEditor.tsx`
  (pointer events, contain mapping, loupe) + one protocol message
  (`rewrap {quad}`) + `scan_process_with_quad` glue over existing
  `warp_quad`. No detect/geometry changes.
- Include keyboard steppers in the same handles (`role=slider`, arrow
  keys, `role=status` announcements); 44×44px targets (24px dot + invisible
  padding); `touch-action: none` on handles; high-contrast handles.
- **Explicitly not recommended:** live re-warp while dragging (worker
  contention — single synchronous WASM call, no cancel — plus battery
  churn for marginal value). Defer until real-device timing proves
  warp-on-release feels laggy.

## 5. Auto-capture (hands-free shutter)

Current flow reference: `CameraCapture.tsx:768-811` tick →
`useScanProcessor.requestLive()` detect-only → hint only; protocol v2
`detectOnly`; review-before-accept preserved throughout.

- Primitives: stability = max corner displacement normalized by frame
  diagonal (<1–2%/tick over N ticks, confidence ≥0.6, area change <5%;
  corners already come free from detect). Sharpness on ~160px gray
  (≈25k px): Laplacian variance (~200k integer ops), Tenengrad-lite
  (~2×), or Brenner (cheapest, stride-2 OK) — but thresholds must be
  calibrated per corpus: low-light/textureless pages score "blurry" when
  sharp; glare scores "sharp" falsely. Combine with exposure floor; never
  fire on sharpness alone. Battery note: metrics are ~1% of detect cost;
  keep 500ms ticks (firing latency 1.5–2s doubles as steadiness proof).
- **Recommended: stability ring + cancellable countdown, toggle
  default-off.** N=3 stable+confident ticks arms a visible 2s countdown
  (tap cancels; instability aborts); 5s cooldown; max 3 auto-fires per
  session; misfires absorbed by existing review (Retake). Zero
  WASM/protocol change. Hooks: live-tick effect + new `useAutoCapture`
  hook; existing generation guards handle stale fires.
- **Phase 2:** in-worker sharpness score (`sharpness` in result envelope)
  as an AND-gate — but FIRST log a main-thread sharpness estimate per
  tick (telemetry only) to calibrate real thresholds.
- Policy needs hysteresis throughout; image-vs-device motion cannot be
  separated by image methods alone (DeviceMotion as optional veto only).

## 6. Lighting / shadow / background handling

Key costing fact: illumination work happens post-warp on ≤~5MP output,
not 12MP input (12MP pays only decode/detect/warp).
`enhance::apply_mode` is mode-only with no knobs; B&W already uses a
lighting-tolerant local-mean adaptive threshold.

- **Recommended: clamped thumbnail background-divide + damped gray-world,
  fused as one streaming pre-step in `enhance.rs`.** Luma thumbnail
  (~100px) → small separable blur = illumination estimate →
  bilinear-upsample → per-pixel `gain = bg/px` clamped (e.g. ≤1.3×),
  all channels equally (hue-preserving); per-channel means from the same
  thumbnail scale R/B toward G at ~50–70% damping (avoids over-blueing).
  O(N) downsample + one streaming pass, no extra full-res buffers;
  clamped gains push paper toward uniform near-white → DCT-friendly
  (likely _smaller_ JPEGs). Apply before the mode branch so Color,
  Grayscale, and B&W all benefit; B&W needs no threshold retune initially.
- **Explicitly deferred:** full shadow removal via large-SE close /
  percentile background (text ghosting, color shifts, noise amplification,
  bigger JPEGs, extra full-res buffers violating memory discipline).

## 7. Output enhancement modes

Ground truth: `enhance.rs` has Original / Grayscale / BlackWhite;
warps→mode→single q92 encode (long edge ≤2500); all scan outputs are
baseline JPEGs → all modes stay DCT-passthrough-eligible (PDF ≈ JPEG
size). Only `CORE_MODE='original'` hardcoding in `useScanProcessor.ts`
blocks choice. Size ordering for text: clean B&W < grayscale < color;
but noisy B&W balloons (speckle = high-frequency DCT content) — B&W
stays opt-in, never default, never automatic.

- **Recommended now: sticky 3-mode preference + review-panel override.**
  Persist mode, default Original (never destroys info), one-tap per-page
  override where Accept already happens. Zero new algorithms (plumbing
  exists). Hooks: `enhance.rs::ScanMode`, `pipeline.rs::ScanRequest.mode`,
  `useScanProcessor.ts`, review panel, `imagePages.ts`.
- **Follow-up: "Readable gray" default** — luma + background-normalized
  gentle contrast (smooth curve, darken text ≤~15%, no clipping below ~5%;
  hard clipping enlarges files via ringing). O(N), one pass, no new buffers.
- **Not this round:** Sauvola (second SAT ≈72MB transient, heavy WASM
  arithmetic), auto-suggest chips (needs real-capture histograms to
  validate), 3×3 mask despeckle beyond current adequacy.

## 8. Ecosystem verdicts (constraints on all of the above)

- Table stakes users expect: live polygon overlay with draggable corners;
  steady-to-capture with manual-shutter fallback (never auto-only);
  one-tap Color/Grayscale/B&W presets with right defaults; multipage
  session → single PDF with reorder/retake/delete; fully on-device.
- Crates: keep `image` (default-features off, jpeg+png) and `imageproc`
  (default-features off, no rayon) frozen as-is — Canny, contours,
  Gaussian blur, adaptive threshold are pure-Rust, single-thread-safe.
  Avoid anything pulling rayon/threads/C-bindings/filesystem.
- **OpenCV-for-WASM: ruled out** — ~8.1MB stock WASM (~4.4MB stripped)
  vs 542KB budget; Emscripten toolchain (not wasm-pack/cargo);
  threading needs SharedArrayBuffer + COOP/COEP the PWA cannot assume.
- **ML boundary detection: deferred** — model size, runtime weight,
  training data all violate constraints; classical + scoring fits.
  Revisit only on unacceptable field miss rates.
- **Shape Detection API: do not depend** (Chromium-partial, Safari/Firefox
  absent, no quad detector exists).

## 9. Recommended build order (not approved — pick before implementing)

- **Phase 1** (all small, safe, independent): quad scoring (§3A) →
  sticky 3-mode preference (§7) → illumination pre-step (§6) →
  stability-ring auto-capture default-off with sharpness logging (§5).
- **Phase 2**: edge refinement (§3B) → Adjust-crop mode (§4) →
  Readable gray (§7) → multi-frame fusion (§3C) → Rust sharpness gate
  calibrated from Phase 1 logs (§5).
- **Not now**: Sauvola, auto-suggest heuristics, live re-warp dragging,
  ML, OpenCV.

## 10. Validation needs (real-device, still open)

- Quad-scoring weights and sharpness thresholds need calibration on real
  phone captures (low light, glare, textureless pages) — synthetic
  fixtures cannot set them.
- Manual-corner feel (loupe offset, handle size) and auto-capture
  annoyance rate need on-phone testing with the countdown/cap policy.
- `test pdfs/` corpus is gitignored/local-only; E2E fake camera
  (runtime Y4M) covers plumbing, not photo realism.

## 11. Field failure analysis: white-page misses (Hermes agent, 2026-10-02)

Researched and written by Hermes agent. Four parallel investigators traced
code paths in `scan/src/detect.rs` + `scan/src/geometry.rs` against a field
report: white pages on dark/uniform backgrounds detect only intermittently,
well below the 70–80% hit rate the product needs. Research only — no
implementation, no direction chosen.

### Symptom

Same scene, different tap timing, different outcome: detection succeeds
sometimes, silently falls back to auto-accept-as-photo the rest of the time.
No error surfaces; the miss is invisible except for the missing crop.

### H-A — Frame-edge clipping (likely)

`find_contours` runs on the Canny edge map (thin strokes), and Canny output
carries a permanent zero 1px frame (hysteresis seeds interior pixels only).
A page edge touching or exiting the frame therefore yields open strokes, not
closed loops: full-span strokes produce zero contours (outer start requires
`x > 0`), U/C strokes double back into ~0-area loops killed by
`MIN_CONTOUR_AREA_FRAC`, and near-exact fits die at the 99% area gate
(`geometry.rs:212`). Kill is contact-triggered, not size-triggered —
any edge crossing the frame kills regardless of page size. Existing fixtures
all use ≥80px margins, so this path is untested. Fixes, cheapest first:
guidance copy ("leave a margin"), full-frame fallback quad at low
confidence (~20 lines), partial-quad acceptance (~40–60 lines), 99%→99.9%
for the exact-fit sliver.

### H-B — Global Otsu fragility (most likely)

`detect.rs:90-94` runs global Otsu → close → Canny **on the binary**, so
Sobel gradients are 0 everywhere except step edges and hysteresis recovery
is impossible — whatever Otsu destroys stays destroyed. A hand/phone shadow
makes the histogram trimodal; Otsu's area-weighted split lands between
shadow-paper and lit-paper when the shadow is large (page half merges with
desk) and below both when it is small (page survives) — hence intermittent,
flipping with shadow fraction. Same story for glare (boundary gaps closing
r=2 cannot bridge), dim gradients (Otsu always returns a number, splitting
the hill mid-slope), and handwriting-dense pages (ink competes with the
paper-vs-desk split). Fixes: grayscale-Canny fallback when the binary path
yields nothing (~15 lines, zero cost on success) + bimodality guard on the
already-built histogram; §6 illumination pre-step upstream; local-mean
adaptive only as a gated secondary path (it erases boundaries on clean
uniform backgrounds — never a wholesale Otsu replacement).

### H-C — Acceptance cliffs (confirmed)

`approx_closed_quad` demands exactly 4 RDP points at a single epsilon
(`detect.rs:413`) — rounded notebook corners, curl, spiral binding, and
margin writing touching the boundary all produce 5–8 points and are silently
discarded. `support < 0.5` likewise returns `None` instead of a weak guess,
so near-misses are indistinguishable from no-page. Winner is largest-first,
never re-ranked. Fixes: accept 5–8-gons + fit quad from 4 dominant corners
(~40–60 lines, highest recall leverage) → epsilon sweep (~10 lines) →
quad-scoring ranker (§3A) → graded low-confidence returns (needs caller
work) → edge refinement last (§3B pays off only once corners are roughly
right).

### H-D — Shutter luck (amplifier, not sole cause)

`requestContinuousModes()` lets AF/AE hunt up to tap time; the shutter grabs
whatever frame is current with no sharpness/exposure/steadiness gate, then
runs one fresh full-res detection. Verified: no "fill the frame" copy exists
(pill says "Frame the page in the guide"), but the inset guide rect invites
edge-fitting and nothing says "leave a margin" or "hold steady"; manual crop
does not exist yet so fallback captures skip review entirely. Fixes: copy
("Fit page inside guide, leave a small margin", "Hold steady — capture when
ready"), main-thread sharpness + exposure pre-check (telemetry first),
~500–800ms settle assist after first `liveDetected`, multi-frame fusion
(§3C), Adjust-crop (§4).

### Evidence still needed to discriminate

Per failing sample: result status + whether the pill showed detected at tap
time; page coverage % (<50 / 50–70 / 70–90 / edge-touching); blank vs
written page; lighting + shadow/glare across page; distance, angle,
handheld vs rested, settle time before tap. Edge-touching + high coverage →
H-A; shadow/glare present → H-B; notebook/rounded/spiral → H-C; pill
flicker + low coverage → H-D.

## 12. Primer: how on-device scan filtering works (Hermes agent, 2026-10-02)

No server is involved at any step — the camera frame sits in tab memory and
everything below is arithmetic on pixels, which is why steps 4–6 fail
identically on-device or in a datacenter: capture via `getUserMedia` to
canvas → downscale to ~800px (shapes don't need megapixels) → grayscale +
blur → threshold into page/background blobs (Otsu or local-mean) → Canny
edges → contour tracing with area filtering → quad fit + geometric checks →
homography un-warp with interpolation → lighting normalization → mode filter
(color passthrough / Rec.601 grayscale / adaptive B&W) → JPEG encode. Heavy
full-res steps run in a WASM worker (here Rust, ~542KB) so the UI never
freezes; 800px-scale steps are cheap enough for plain JS.
