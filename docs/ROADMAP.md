# Folio — Roadmap

This roadmap records actual project direction. Items are separated by commitment level. Do not present "Future / not committed" items as promises.

## Completed

- **v1.0.0** — first public release: local Merge, Split, Rearrange, Rotate, Compress tool set (per About page; earliest git history 2026-08).
- **v1.1.0** — client-side PDF tools refinement (`f4d8f17`, 2026-08-17).
- **v1.2.x – v1.6.0** (2026-08-23) — PWA offline fix, windowed rendering, theme polish, mobile flows, PDF render worker, cancellable merge jobs with stage progress.
- **v1.7.0 (`dev`)** — unified Folio repository: complete Rust engine source + WASM bridge + tests + examples + production Studio in one repo; Rust/WASM manipulation in a Web Worker; PDF.js rendering-only; real progress/cancellation/structured errors; Metadata and Images → PDF tools; Compress disabled; Testbench removed from product.
- **Phase 1 (done)** — repository renamed `pdf-studio` → `folio`; product identity corrected; persistent documentation system established (`AGENTS.md` + `docs/`).
- **Phase 2 (done, this change)** — filesystem restructured into project-oriented ownership: `engine/` (Rust source, tests, examples, manifest + lockfile), `wasm/` (bridge, path-dependency updated), `app/` (frontend, no config changes required), `docs/` untouched. No Cargo workspace; no behavior changes; full suite re-verified.

## Current

- Phase 2 completion: full verification re-run from the new structure, commit, normal push to `dev`, clean working tree.

## Next

- **Phase 3 — fresh-clone validation.** Clone `-b dev` to a temp directory and re-run the full suite there (see `docs/LESSONS.md` L-8). Separate task; not performed in Phase 2.
- Decide promotion of the Folio build to `main` / production hosting (currently `main` carries the pre-engine release). Unscheduled — requires an explicit decision, not a side effect of other work.

## Future / not committed

The following appear in the product surface or history as aspirations. None are committed, scheduled, or designed. Do not quote them as roadmap promises.

- **Compress** — button reserved in the Studio UI; engine + UI implementation not started.
- **Sign & annotate** — listed in the About page version tree as a planned "v1.2.0" (e-signatures, form-fill overlay, watermarks/page numbers). About-page aspiration only.
- **Batch & OCR** — listed in the About page version tree as a planned "v2.0.0" (batch queue, local OCR). About-page aspiration only.
- Engine-adjacent ideas mentioned in code comments as "later lessons" (text extraction, rendering inside the engine, compression, encryption): explicitly out of scope for the current engine, recorded here only so they are not mistaken for plans.
