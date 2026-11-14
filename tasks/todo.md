# Scanner follow-up tasks

- [x] **1. Baseline and audit** — docs first; identify presentation causes and
  detail-loss stages; verify unchanged typecheck and frontend tests.
  Observed: 800 tests / 57 files; typecheck passed. No output mismatch proven.
- [x] **2. Review redesign (Terra)** — square page with visible mat, one working
  filmstrip, labeled actions, responsive 44px controls, explicit editing lifecycle.
  Verify: focused capture/review tests red→green, typecheck/lint, real-browser
  geometry and interaction assertions. Depends on 1.
- [x] **3. Quality experiment (Luna)** — identical source/quad/warp dimensions;
  alternate warmed q0.95/q0.97/q0.98 encodes; report bytes/time/detail error.
  No production capture changes. Verify deterministic metrics and released
  bitmaps/canvases; physical-image limitations explicit. Depends on 1.
- [x] **Checkpoint: implementation decision (Sol)** — review 2 and 3, select
  measured codec change or explicitly retain current quality; no concurrent
  edits to UI-owned files.
  Selected crop q0.97 (~17% more fixture bytes, ~33–39% lower detail MAE).
  Live capture remains q0.95; phone acceptance is still pending.
- [x] **4. Integration verification** — full frontend suite, type/lint/format,
  production build, actual Chromium review/crop/build flow; check short-height,
  320px and 60-page navigation. Record results, not inferred success.
  Observed: frontend 802/57; review smoke 22/22; canonical E2E 104/104 with
  four optional-corpus skips; type/lint/format/build pass. Phone acceptance pending.
- [x] **5. Project memory** — update F-28, STATUS, architecture/decisions as
  applicable, WORKLOG and operation/narrative limitations in place. Preserve
  historical evidence. No unrequested deployment/main promotion.
