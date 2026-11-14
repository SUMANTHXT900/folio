# Plan: scanner review and modest detail improvement

## Goal

Preserve the phone-confirmed fast 50–60-page capture workflow while improving
post-capture review usability and measuring a modest exported-detail improvement.
The reported “deep crop” feeling is a presentation complaint, not proven output
pixel loss (F-28). Baseline: `dev` at `fc793cf`, v1.12.8.

## Ownership

- **Luna quality lane:** new isolated scanner-quality benchmark; no production edits.
- **Luna baseline/verification lane:** bounded test execution and evidence.
- **Terra UI lane:** `ScanicReview.tsx`, review-only sections of
  `ScanicCapture.tsx`, their tests, and canonical scanner E2E assertions.
- **Sol:** contracts, task sequencing, documentation, integration, final review.
  No simultaneous edits to Terra-owned files.

## Design and engineering contract

- One complete square-edged verdict image, intentionally inset into a flat dark
  mat. Mat is preview-only, never PDF padding. No rounded image clipping.
- One direct-navigation filmstrip, not a filmstrip plus 60 pager dots.
  Existing page hooks identify real visible thumbnail buttons.
- Clear page count, previous/next, Add pages, labeled crop/original actions,
  secondary re-detect/discard, and a single primary Build PDF.
- Preserve non-blocking ML preparation, crop-settled build gating, recoverable
  commit, use-original semantics, eight 44px handles, loupe and keyboard support.
- Editing has explicit Apply/Cancel; do not silently discard a dirty draft when
  paging, adding or building. Prefer a simple guarded editing state to a new
  draft-management or confirmation subsystem.
- Respect 320px width, short-height screens and safe areas. Use one scroll path
  where needed; never cover controls with a fixed bar.
- Do not change the fast live shutter, stream resolution, detection budget,
  import budget, engine contract, or add new dependencies for an unmeasured win.

## Tasks and checkpoints

1. Audit review presentation and detail-loss stages; verify baseline.
2. Implement/test review redesign (Terra).
3. Measure q0.95 / q0.97 / q0.98 crop-encode tradeoffs on identical production
   warp pixels (Luna), without altering production behavior.
4. Sol chooses the smallest justified quality change, or keeps q0.95 if evidence
   does not justify a default change. Shutter remains unchanged either way.
5. Verify integrated unit/type/lint/format/build and real-browser geometry,
   crop/edit/build lifecycle, source/output dimensions and capture timing.
6. Update relevant docs with observed results and explicit physical-phone gates.

Task checklists and acceptance criteria: `tasks/todo.md`.

## Risks and evidence limits

- JPEG pixel error is a reproducible codec proxy, not proof of phone handwriting
  readability. Actual video dimensions, focus and lighting may dominate quality.
- Provisional codec tradeoff: seek materially lower detail error with at most
  roughly 1.5× cropped JPEG bytes; report encoding cost instead of extrapolating
  desktop milliseconds to phones. Reject a blanket “higher quality is better.”
- Review changes must not leak into capture or asynchronous worker ownership.
- No deployment or main promotion is part of this plan without authorization
  for this wave. Physical-phone visual/detail/latency acceptance remains open.
