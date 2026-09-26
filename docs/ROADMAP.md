# Folio — Roadmap

This roadmap records actual project direction. Items are separated by commitment level. Do not present "Future / not committed" items as promises.

## Completed

- **v1.0.0** — first public release: local Merge, Split, Rearrange, Rotate, Compress tool set (per About page; earliest git history 2026-08).
- **v1.1.0** — client-side PDF tools refinement (`f4d8f17`, 2026-08-17).
- **v1.2.x – v1.6.0** (2026-08-23) — PWA offline fix, windowed rendering, theme polish, mobile flows, PDF render worker, cancellable merge jobs with stage progress.
- **v1.7.0 (`dev`)** — unified Folio repository: complete Rust engine source + WASM bridge + tests + examples + production Studio in one repo; Rust/WASM manipulation in a Web Worker; PDF.js rendering-only; real progress/cancellation/structured errors; Metadata and Images → PDF tools; Compress disabled; Testbench removed from product.
- **Phase 1 (done)** — repository renamed `pdf-studio` → `folio`; product identity corrected; persistent documentation system established (`AGENTS.md` + `docs/`).
- **Phase 2 (done)** — filesystem restructured into project-oriented ownership: `engine/` (Rust source, tests, examples, manifest + lockfile), `wasm/` (bridge, path-dependency updated), `app/` (frontend, no config changes required), `docs/` untouched. No Cargo workspace; no behavior changes; full suite re-verified.
- **Phase 3 (done)** — testing policy finalized: large external PDFs reclassified as optional developer-owned benchmark inputs (see `docs/DECISIONS.md` D13); canonical E2E (`studio.e2e.mjs`) passes from a fresh clone with no corpus via deterministic synthetic small fixtures (`app/e2e/corpus.mjs`) and explicit SKIP of large-file sections; `large-files`/`thumbnail`/`metadata` E2E marked optional with clean SKIP semantics; old `folio-engine` workspace retired.
- **v1.7.1 (done)** — mobile UI fixes F-7–F-10 patch (UI-only, engine untouched), full suite re-verified with baselines unchanged (see `docs/WORKLOG.md` 2026-09-23 handoff closure).
- **v1.8.0 (done)** — Images → PDF page assembly (app-only, engine untouched): unified ordered page collection for uploads + camera captures, preview grid, ←/→ move reorder (drag as enhancement), remove, add-more, per-page rotate, camera input (see `docs/DECISIONS.md` D14).

## Current

- v2.0 scanner on `dev` (M1–M3 + M3.x hardening done; M4 docs-prep in progress, version bump HELD): `folio-scan` core (detect → warp → enhance, Otsu + closing + area-order + spine-split merge), dedicated scan worker + WASM (protocol v2 `detectOnly`/`detected`), CameraCapture integration with review-before-accept for processed scans and fallback auto-accept for no-boundary captures, live-guidance-only detection, portaled scanner surface, memory-safe sequential imports (`MAX_IMPORT_LONG_EDGE = 2500`, PNG→JPEG). Also on `dev`: PWA update manager (D16), JPEG DCT passthrough (D17), PNG→JPEG + Rearrange-parity page list (D18), perf P0–P2+P4 (D19/D20), naming-first downloads all tools (D21), preview hardenings F-18/F-19. Real-device Android validation PENDING — gates the v2.0.0 release (checklist in `docs/STATUS.md`); `package.json` still 1.8.0.

## Next

- **Performance program (`docs/PERFORMANCE.md`).** P0, P1, P2, P3, P4 **all done 2026-09-26** (P3: image-build sharding + parallel-honesty-by-construction, D22). Remaining: P0.2 main-thread slice removal (design-gated on measurements — P4 harness available; HELD for deep discussion per user). Threaded WASM explicitly gated behind a future decision.
- Decide promotion of the Folio build to `main` / production hosting (currently `main` carries the pre-engine release). Unscheduled — requires an explicit decision, not a side effect of other work.

## Future / not committed

The following appear in the product surface or history as aspirations. None are committed, scheduled, or designed. Do not quote them as roadmap promises.

- **Compress** — button reserved in the Studio UI; engine + UI implementation not started.
- **Sign & annotate** — listed in the About page version tree as a planned "v1.2.0" (e-signatures, form-fill overlay, watermarks/page numbers). About-page aspiration only.
- **Batch & OCR** — listed in the About page version tree as a planned "v2.0.0" (batch queue, local OCR). About-page aspiration only. Note: that "v2.0.0" label predates the scanner v2.0 release and collides with its numbering — resolving it is an explicit gate in the `docs/STATUS.md` v2.0.0 checklist.
- Engine-adjacent ideas mentioned in code comments as "later lessons" (text extraction, rendering inside the engine, compression, encryption): explicitly out of scope for the current engine, recorded here only so they are not mistaken for plans.

- **Scanner zoom (revisit)** — the zoom control was removed because the track-reported range is not a focal-length multiplier (docs/BUGS.md F-11); revisit only with focal-accurate lens handling.
