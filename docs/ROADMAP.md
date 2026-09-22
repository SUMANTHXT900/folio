# Folio — Roadmap

This roadmap records actual project direction. Items are separated by commitment level. Do not present "Future / not committed" items as promises.

## Completed

- **v1.0.0** — first public release: local Merge, Split, Rearrange, Rotate, Compress tool set (per About page; earliest git history 2026-08).
- **v1.1.0** — client-side PDF tools refinement (`f4d8f17`, 2026-08-17).
- **v1.2.x – v1.6.0** (2026-08-23) — PWA offline fix, windowed rendering, theme polish, mobile flows, PDF render worker, cancellable merge jobs with stage progress.
- **v1.7.0 (`dev`)** — unified Folio repository: complete Rust engine source + WASM bridge + tests + examples + production Studio in one repo; Rust/WASM manipulation in a Web Worker; PDF.js rendering-only; real progress/cancellation/structured errors; Metadata and Images → PDF tools; Compress disabled; Testbench removed from product.
- **Phase 1 (this phase)** — repository renamed `pdf-studio` → `folio`; product identity corrected; persistent documentation system established (`AGENTS.md` + `docs/`).

## Current

- Phase 1 completion: full verification re-run, commit, normal push to `dev`, clean working tree.

## Next

- **Phase 2 — filesystem restructuring.** Reorganize the unified repository layout (currently `src/`, `tests/`, `examples/`, `frontend/`, `wasm/`) into the planned `engine/` + `app/` + `wasm/` structure. Separate task with its own verification; do not start it inside Phase 1 work.
- Decide promotion of the Folio build to `main` / production hosting (currently `main` carries the pre-engine release). Unscheduled — requires an explicit decision, not a side effect of other work.

## Future / not committed

The following appear in the product surface or history as aspirations. None are committed, scheduled, or designed. Do not quote them as roadmap promises.

- **Compress** — button reserved in the Studio UI; engine + UI implementation not started.
- **Sign & annotate** — listed in the About page version tree as a planned "v1.2.0" (e-signatures, form-fill overlay, watermarks/page numbers). About-page aspiration only.
- **Batch & OCR** — listed in the About page version tree as a planned "v2.0.0" (batch queue, local OCR). About-page aspiration only.
- Engine-adjacent ideas mentioned in code comments as "later lessons" (text extraction, rendering inside the engine, compression, encryption): explicitly out of scope for the current engine, recorded here only so they are not mistaken for plans.
