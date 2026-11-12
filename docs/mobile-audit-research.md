# Mobile and workflow audit (research only)

Baseline: `dev` at `23b5cb6`. This is an audit handoff, not an approved implementation plan. Static findings below are grounded in the cited code; performance impacts require measurement on physical devices.

## Findings

1. **PDF intake failures are hidden in Merge, Rotate and Metadata.** `usePdfFiles` catches failures and stores `error` (including the 150 MiB limit and rejected files), but these three consumers do not read that field. An invalid selection can therefore leave the upload screen unchanged without its explanation. Split and Rearrange display it. Surface the intake error and loading state consistently, including when no file has been opened.
2. **Document lifetime on navigation needs repair.** `usePdfFiles` closes documents on remove/clear but has no unmount cleanup. The app changes tool components by route; pending-transfer cleanup covers only claimed transfers under specific conditions, not ordinary uploads. Repeated navigation can leave document bytes and render resources in module stores. Add ownership-aware cleanup, handling in-flight loads, React StrictMode, and transferred documents; verify stores and PDF.js resources return to baseline.
3. **Image preview dialog accessibility is inconsistent.** `PageGrid` renders a dialog without `aria-modal`, initial focus, Escape handling, focus return, or a focus trap. Split and Rearrange at least support Escape and focus restoration. Align modal behavior and test keyboard, screen reader and touch use.
4. **Merge limits disagree across layers.** Intake permits up to 150 MiB in total, while the merge engine rejects combined inputs over 100 MiB. Two otherwise valid files can be loaded before merge fails. Show the operation limit before staging or align the limits deliberately; retain the engine guard.
5. **Concurrent file selection needs a guard.** `usePdfFiles.addFiles` calculates the budget before an asynchronous open and has no in-flight guard; Merge does not consume `busy`. Overlapping selections can independently pass the budget, append out of order, and make busy status inaccurate. Reproduce with delayed loads, then serialize or reserve capacity and handle cancellation on unmount.

## Performance and UX investigations

- Scan detection decodes a full original bitmap before producing a <=1600-pixel detection frame. Crop application also decodes full-resolution pixels, and later image import caps the long edge to 2500 pixels. Profile peak memory, shutter-to-review time, crop time and long tasks on representative phones. Experiment with a bounded working image while preserving orientation and coordinate mapping. Avoid claiming a smaller canvas prevents the original bitmap decode.
- The output import quality is 0.95 when re-encoding; crop JPEG uses 0.9. Compare 2000/2500-pixel variants and quality levels on small handwriting, pencil marks, diagrams and photographs. Measure readability and PDF size before changing defaults. `Use original` currently has a specific meaning in review; explain any resulting reduction honestly.
- Detection defaults to multiple workers when memory information is unavailable; image-to-PDF sharding can also use multiple WASM workers. Measure peak memory and latency on constrained devices before changing worker policy.
- Image `PageGrid` maps every page into a row; test long lists for scroll responsiveness and accessibility before deciding on virtualization. PDF thumbnails already have bounded windows and caches, so do not assume the same behavior applies to every list.
- Reconcile `docs/ARCHITECTURE.md` scanner descriptions with the current worker, JPEG and default-detector implementation; parts describe earlier behavior as current. `docs/DEVELOPMENT.md` still mentions the removed `scan/` crate and `build:scan`.

## Validation and remaining work

### Capture prototype comparison (2026-11-12)

`app/e2e/capture-benchmark.mjs` compares a canvas JPEG from the live video with an `ImageCapture.takePhoto` request scaled to a 2000-pixel long edge. It uses Chromium's synthetic camera and is a research prototype, not the production shutter. With a local Vite server on port 5199, two independent runs of 10 timed captures after warm-up produced median frame times of 46.2 ms and 38.15 ms at 1080×1920; photo times were 97.8 ms and 94.35 ms at 3840×2160. The camera was asked for 1920×1080 but returned 3840×2160, so this is not a controlled comparison at equal output resolution. Capture timing ends when the JPEG blob is available; it excludes decoding for dimension inspection and downstream detection, crop and PDF generation. The fake camera cannot establish real-device latency, image quality, camera behavior or handwriting legibility. Recommend video-frame capture for a next prototype, followed by phone comparison before replacing production capture.

On 2026-11-12, frontend Vitest passed 792 tests in 56 files and `cargo test --locked` passed. Canonical desktop Chromium E2E reported 101/102 passed and four optional large-corpus checks skipped. The no-camera denial check timed out in this environment; uploads in that scenario passed. The cause has not been established, so it is not yet classified as an application defect. The environment required the suite's CI no-sandbox option to launch Chromium.

No physical phone, camera hardware, mobile browser performance trace, real document image quality comparison, large-file corpus, or accessibility device was exercised. The full source and all permutations have not been exhaustively reviewed; further audit remains. No source or deployment changes were made.
