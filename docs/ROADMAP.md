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

- Scanic integration on `dev` (D34, 2026-10-04): document scanning rebuilt on `scanic@1.6.0` (classical detection + full-res bilinear warp + corner editor; MIT © marquaye, attribution kept) with `scanic-ml@0.2.0` self-hosted (dist vendored same-origin under `/assets/scanic-ml/`, precached at install, ORT 1.27.x ABI); ML default OFF (classical default with explicit opt-in toggle); precache cap 8MB → 10MB with the 9MB alarm rule; zero-re-encode quality (original bytes never resized/recompressed; D17 passthrough retained); ML 1-thread default (no COOP/COEP); upload-only interim ended; fresh E2E per L-11/L-12. The D33 strip deleted the custom scanner track (v2.0 M1–M3 + M3.x hardening, D29–D32 recall rounds) — history preserved. The Images gallery/build/naming flow is untouched. Also on `dev`: PWA update manager (D16), JPEG DCT passthrough (D17), PNG→JPEG + Rearrange-parity page list (D18), perf P0–P2+P4 with P0.2 shelved (D19/D20), naming-first downloads all tools (D21), P3 image-build sharding (D22), usage-based Home ordering (D23), preview hardenings F-18/F-19/F-20, audit-hardening waves 1–7 (K-series fixes, benchmark matrix), wave-A app finish (studioThumb removal, merge-readiness honesty, local-phase copy, About 44px targets, disabled-card focus, nav affordance, K4 from_bytes alignment) + portal-AnimatePresence regression fix (E2E-caught pre-ship, `3ccabeb`). `package.json` 1.9.0, v2.0.0 release HELD (checklist in `docs/STATUS.md`).

## Next

- **Scanic integration (landed in D34, 2026-10-04).** Classical detection + full-res warp + corner editor with self-hosted ML opt-in, precached at install; precache cap 10MB with the 9MB alarm rule; zero-re-encode quality; fresh scanic E2E. Remaining: real-device validation (user's phone required). See Current above and `docs/DECISIONS.md` D34.

## Next

- **Performance program (`docs/PERFORMANCE.md`) — all done.** P0, P1, P2, P3, P4 implemented 2026-09-26 (P3: image-build sharding + parallel-honesty-by-construction, D22). P0.2 main-thread slice removal measured-and-SHELVED 2026-09-27 on real-device evidence (phone 55 MB merge staging 79 ms cold / 28 ms warm vs ~40 ms engine; see `docs/WORKLOG.md` + `docs/PERFORMANCE.md`) — no implementation, reopens only on a large-PDF-on-phone crash or staging >~500 ms on a used file. Threaded WASM explicitly gated behind a future decision.
- **Production promotion — DONE 2026-09-27.** `dev` fast-forwarded into `main` and pushed; `https://folio-pdf.pages.dev` verified serving the v1.9.0 build.

## Future / not committed

The following appear in the product surface or history as aspirations. None are committed, scheduled, or designed. Do not quote them as roadmap promises.

- **Compress** — button reserved in the Studio UI; engine + UI implementation not started.
- **Sign & annotate** — a former About version-tree "v1.2.0" entry (e-signatures, form-fill overlay, watermarks/page numbers), removed 2026-09-27 with the tree. About-page aspiration only.
- **Batch & OCR** — a former About version-tree "v2.0.0" entry (batch queue, local OCR), removed 2026-09-27 with the other versioned planned entries. About-page aspiration only. Note: that "v2.0.0" label predated the scanner v2.0 release and collided with its numbering — resolved by the removal (`docs/STATUS.md` checklist gate 5 closed).
- Engine-adjacent ideas mentioned in code comments as "later lessons" (text extraction, rendering inside the engine, compression, encryption): explicitly out of scope for the current engine, recorded here only so they are not mistaken for plans.

- **Scanner zoom (revisit)** — the zoom control was removed because the track-reported range is not a focal-length multiplier (docs/BUGS.md F-11); revisit only with focal-accurate lens handling. Any future capture UX is rebuilt on scanic (D33), not on the deleted pipeline.
