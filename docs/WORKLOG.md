# Folio — Worklog

Chronological record of meaningful development events. Each entry records objective, work, findings, decisions, verification, and remaining work — not command-by-command activity. Lesson references in code comments (Lesson 0–14) belong to engine development that predates this log's detail level; they are cited where the code cites them.

## 2026-08-16 → 2026-08-17 — Foundation and v1.1.0

- **Objective.** Establish the client-side PDF tools app and its editorial identity.
- **Work.** Initial commits (`index.html`, `main.tsx`, `.gitignore`), polished README, mobile UX (bottom nav, 2-col grid, glass header), bento home redesign, privacy-proof About, CTA dropzones, motion/shine polish. Released as "Folio v1.1.0 — client-side PDF tools."
- **Verification.** App releases v1.0.0 → v1.1.0 per About record.
- **Remaining.** Correctness, progress, cancellation, and large-file bars unmet by the `pdf-lib` implementation — motivated the engine project.

## 2026-08-20 → 2026-08-23 — Rendering maturity (v1.2.x – v1.6.0)

- **Objective.** Make rendering fast, correct, and large-file-safe; add honest progress.
- **Work.** 25x faster thumbnails (single document load), windowed rendering with right-sized scale, PWA offline fix, object-URL revocation, PDF render Worker with main-thread fallback, blob-URL thumbnails, Show-All resume via shared session, Rearrange/Split blob ownership, theme wave system, mobile save flow, cancellable merge jobs with stage progress, large-selection memory notice.
- **Verification.** Release chain v1.2.0 → v1.6.0 (`a2554a6` … `ffa87c8`).
- **Remaining.** Processing still browser-side (`pdf-lib`); engine integration pending.

## Engine development (predates unification; lessons 0–14 per code comments)

- **Objective.** Build a purpose-built, test-covered Rust PDF engine compilable to WASM.
- **Work.** Lesson 0 foundation (`folio-engine` crate); core/operation/result/error model; execution (context, jobs, progress, scheduler, cancellation); observability (events, logger, timing with WASM clock abstraction); shared copy primitives (Lessons 3+); ten PDF operations; metadata model with patch semantics; images-to-PDF with EXIF/DPI handling; thin `wasm` glue crate (Lesson 10); localhost HTTP bridge prototype (Lesson 9, later abandoned); Developer Testbench for manual verification.
- **Findings.** `std::time` panics on WASM (→ `js-sys` clocks); PDF.js detaches buffers (→ defensive copy); unbounded retention hurts (→ bounds everywhere).
- **Remaining.** Engine lived in a separate local directory; production integration pending.

## 2026-09-21 → 2026-09-22 — Unified Folio integration (v1.7.0)

- **Objective.** Make the repository the single source of truth for engine + app on `dev`, replacing the `pdf-lib` path without redesigning the UI.
- **Work.** First attempt `866761f` (production-only WASM-consumer layout) was identified as the wrong architecture and exactly reverted (`390194a`, empty diff vs `ffa87c8`). Correct integration `d76a22e`: engine source (39 files), WASM bridge, 11 integration tests, 10 examples, Studio frontend with engine-data plumbing (duration/counts/size, engine progress labels, `ErrorBlock`, `imageCount` fix, Merge progress-scale fix), PWA restored with WASM precache (`vite-plugin-pwa` 0.21.1 → ^1.3.0), Testbench excluded from the product, README rewritten, `.gitignore` hardened, E2E paths made repo-relative.
- **Findings.** Fresh-clone verification caught CRLF checkouts breaking `format:check` (→ `.gitattributes` `eol=lf`, `74943c4`) and a one-line lockfile peer-flag churn (→ normalized in `d9bb998`); stale dev servers from prior sessions served E2E's port twice (→ PID/path verification discipline).
- **Decisions.** Engine treated as frozen (UI-only adaptation); version 1.7.0 (next minor; v2.0.0 reserved for the About-listed Batch & OCR); `main` untouched.
- **Verification.** Rust 345 tests, fmt, clippy; frontend typecheck/lint/format/118 tests; build + PWA SW; bundle scan zero testbench strings; 25/25 E2E incl. ~514 MB / 2585-page file; fresh-clone full suite green; live browser merge with 0 external requests; Cloudflare dev deploy (`dev.folio-pdf.pages.dev`).
- **Remaining.** Repository still named `pdf-studio`; no persistent project-memory docs — both addressed by Phase 1.

## 2026-09-22 — Phase 1: identity + project memory

- **Objective.** Rename the repository to `folio`, correct product identity, establish the persistent documentation system, and verify no regressions.
- **Work.** Safety checks (clean tree, `dev` at `d9bb998`, `main` untouched, `gh` authenticated). `gh repo rename folio` (old URL redirects; branches/issues/PRs/releases preserved by GitHub). Local `origin` updated to `SUMANTHXT900/folio`. Identity audit: 8 current-identity references updated (README layout + product name, About/StudioApp GitHub links, `main.tsx`/`folio.ts`/E2E comments); historical `ARCHITECTURE.md` Phase-1B references to `pdf-studio` preserved as accurate history. Created `AGENTS.md` (documentation-first rule, relevance mapping, update rule) and all 13 `docs/` files from verified code/history (no invented dates, features, or reasoning). Full verification re-run; normal push to `dev`.
- **Findings.** Identity was already ~90% Folio (package names, PWA, UI copy); the residue was repo-URL links and "PDF Studio" phrasing in comments/docs. No behavior changes were needed.
- **Decisions.** Historical references stay historical; `main.tsx` stale Testbench comment corrected as part of the identity edit (documented here, zero behavior change).
- **Verification.** Full suite green, baselines unchanged: Rust 345 tests, `fmt`/`clippy` clean, WASM build passing, frontend typecheck/lint/format clean, 118 unit tests, production build with PWA SW (34 precache entries, zero testbench strings in bundle), 25/25 E2E against a PID-verified worktree server (incl. 2585-page large file + cancellation). `docs/STATUS.md` baseline table confirmed accurate, no update needed.
- **Remaining.** Phase 2 filesystem restructuring (separate task); `main`/production promotion decision (unscheduled).

## 2026-09-22 — Phase 2: repository filesystem architecture (this entry)

- **Objective.** Reorganize into project-oriented ownership (`engine/` + `wasm/` + `app/` + `docs/`) with zero behavior change.
- **Work.** Read `AGENTS.md` + structural docs first; inspected manifests, configs, and every path-sensitive reference before moving. `git mv` relocations: `src/` → `engine/src/`, `tests/` → `engine/tests/`, `examples/` → `engine/examples/`, root `Cargo.toml`/`Cargo.lock` → `engine/`, `frontend/` → `app/` (verbatim, incl. configs); `wasm/` untouched in place. Functional changes (3): `wasm/Cargo.toml` path dep `..` → `../engine`; `corpus_inspect.rs` default discovery dir `test pdfs` → `../test pdfs` (documented cargo cwd is now `engine/`); `.gitignore` `frontend/*` → `app/*` (+ explicit `engine/target/`). Depth-preserving move: worker import `../../../wasm/pkg`, E2E corpus `../../test pdfs`, `build:wasm` `cd ../wasm`, `fs.allow: ['..']`, tsconfig/vite relative paths all still resolve — verified, not edited. No Cargo workspace (see D12). Docs updated to the new canonical structure (`AGENTS.md` map, `README.md`, `DEVELOPMENT.md`, `ARCHITECTURE.md`, `STATUS.md`, `ROADMAP.md`, `DECISIONS.md` + D12, `GLOSSARY.md`, `OPERATIONS.md`, `LESSONS.md`, `BUGS.md`); historical `ARCHITECTURE.md` log and `CHANGELOG.md` release entries left accurate as history.
- **Findings.** The frontend tree required zero config edits — every path it uses is repo-root-relative at preserved depth. The only true cross-boundary coupling was the `wasm` → engine path dependency.
- **Decisions.** No workspace; corpus stays at repo root; stale root `target/` (ignored) removed after `engine/target/` proved working.
- **Verification.** Full suite green from the new structure, baselines unchanged: Rust 345 tests in `engine/`, `fmt` clean, `clippy --all-targets` and strict `--all-features -- -D warnings` clean, WASM build passing against `../engine`, frontend typecheck/lint/format clean, 118 unit tests, production build with PWA SW (34 precache entries, zero testbench strings in bundle), 25/25 E2E from PID-verified `app/` server (incl. 2585-page large file + cancellation). `docs/STATUS.md` baseline table confirmed accurate, no update needed.
- **Remaining.** Phase 3 fresh-clone validation (separate task); `main`/production promotion decision (unscheduled).
