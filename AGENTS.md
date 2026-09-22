> **STOP: Before analyzing, modifying, or implementing anything in Folio, map the documentation relevant to the user's request and use it as the project's source of truth.**

Folio's documentation is persistent project memory. It lives in this file and in `docs/`, it is committed to the repository, and it outlives any single chat session. Chat history is not project memory — if something matters, it belongs in `docs/`.

## How to work in this repository

1. **Determine the user's task category** (bug, feature, architecture, development/build, PDF operation, or broad analysis).
2. **Map the relevant documents** using the table below — read those documents first.
3. **Then inspect the source code** needed to verify implementation claims. Documentation tells you where to look and why things are the way they are; source code tells you what is actually true right now. Use both together.
4. **Do not rely on chat history** as permanent project memory. If the conversation contains decisions, bugs, lessons, or state changes that are not yet in `docs/`, record them before finishing.
5. **Update the relevant documentation** before the task is considered complete (see "Documentation update rule").

Do not blindly read the entire repository before understanding the task. Targeted reading — docs first, then code — is faster and more accurate than exhaustive exploration.

## Documentation relevance protocol

### Broad project analysis

If the user asks to analyze the project, review the architecture, audit Folio, describe the current state, explain what has been built, or decide what to do next — comprehensively read **all of these** before producing the analysis:

```text
AGENTS.md
docs/PROJECT.md
docs/ARCHITECTURE.md
docs/STATUS.md
docs/ROADMAP.md
docs/DECISIONS.md
docs/BUGS.md
docs/DETOURS.md
docs/LESSONS.md
docs/DEVELOPMENT.md
docs/OPERATIONS.md
docs/CHANGELOG.md
docs/WORKLOG.md
docs/GLOSSARY.md
```

Then inspect source code where required to verify implementation claims.

### Task-category mapping

| Task category | Read first |
|---|---|
| Architecture task | `PROJECT.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `LESSONS.md`, `STATUS.md` |
| Bug task | `STATUS.md`, `BUGS.md`, `ARCHITECTURE.md`, `LESSONS.md`, `DECISIONS.md` |
| Feature task | `PROJECT.md`, `STATUS.md`, `ROADMAP.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `OPERATIONS.md`, `BUGS.md` |
| Development / build task | `DEVELOPMENT.md`, `STATUS.md`, `ARCHITECTURE.md` |
| PDF operation task | `ARCHITECTURE.md`, `OPERATIONS.md`, `STATUS.md`, `BUGS.md`, `DECISIONS.md`, `LESSONS.md` |

### Terminology

`docs/GLOSSARY.md` defines Folio-specific terms (`ExecutionEngine`, `EngineAdapter`, `WasmWorkerEngineAdapter`, `PdfRenderEngine`, binary ownership, windowed processing, …). Use its definitions; do not redefine terms ad hoc.

## Repository map (pointers, not a substitute for docs)

```text
folio/
├── AGENTS.md          This file — agent entry point.
├── docs/              Persistent project memory (13 documents).
├── engine/            Folio Rust PDF engine — independent of UI concerns.
│   ├── src/           Engine source (core, execution, observability, processing, testing).
│   ├── tests/         Rust integration tests (one file per operation + lifecycle).
│   ├── examples/      Rust CLI examples (opt-in corpus tools).
│   ├── Cargo.toml     Engine manifest (package `folio-engine`).
│   └── Cargo.lock     Engine dependency lock.
├── wasm/              Thin Rust → WASM bridge (wasm-pack). No PDF logic here.
│   ├── src/           Glue crate (`folio-wasm`) over the engine.
│   └── Cargo.toml     Bridge manifest; path-depends on `../engine`.
├── app/               Production web app (React + TS + Vite) — engine consumer.
│   ├── src/engine/    TypeScript engine API: adapters, worker, protocol, binary store.
│   ├── src/rendering/ PDF.js rendering + thumbnail engines.
│   ├── src/studio/    Application UI: shell, tools, hooks, Folio service boundary.
│   ├── e2e/           Production E2E suite (real headless Chrome, real engine, no mocks).
│   ├── package.json   App scripts (`dev`, `build`, `build:wasm`, `test`, E2E via node).
│   └── vite.config.ts App build config (PWA precache incl. WASM, `fs.allow` for `../wasm/pkg`).
├── ARCHITECTURE.md    Long-form historical architecture log (lesson-by-lesson build record).
└── README.md          Public project front page.
```

Rust commands run in `engine/`; frontend commands run in `app/`. There is no
Cargo workspace: `engine/` and `wasm/` keep their independent manifests and
lockfiles (see `docs/DECISIONS.md` D12). The `test pdfs/` corpus (gitignored,
local-only) stays at the repo root.

## Documentation update rule

Every meaningful engineering task must update the relevant documentation before the task is considered complete. Do not log trivial actions (files opened, lines changed). Record meaningful project knowledge: decisions, bugs, lessons, detours, state changes, releases.

| Task outcome | Update |
|---|---|
| Feature implemented | `STATUS.md`, `ROADMAP.md`, `CHANGELOG.md`, `OPERATIONS.md`, `ARCHITECTURE.md`, `DECISIONS.md` (as applicable) |
| Bug discovered | `BUGS.md`, plus `LESSONS.md` if there is a reusable lesson |
| Bug fixed | `BUGS.md`, `STATUS.md` |
| Architecture changed | `ARCHITECTURE.md`, `DECISIONS.md`, `STATUS.md` |
| Approach abandoned | `DETOURS.md` |
| Development discovery | `LESSONS.md` |
| Release | `CHANGELOG.md`, `STATUS.md` |
| Meaningful dev session | `WORKLOG.md` |

Rules that keep the memory accurate:

- **Update, don't append blindly.** If a fix changes a limitation, edit the limitation where it is stated (`STATUS.md`, `OPERATIONS.md`, `README.md`) instead of only adding a new entry elsewhere.
- **No contradictions.** After editing, cross-check: `STATUS.md`, `ROADMAP.md`, `README.md`, and `About.tsx` must agree on what exists, what is disabled, and what is planned.
- **No invented history.** Record only what is verified in code, tests, git history, or observed behavior. If rationale is unknown, write "rationale not recorded" — never fabricate reasoning, dates, or events.
- **History stays accurate.** The repository was previously named `pdf-studio`; historical documents (`ARCHITECTURE.md`, git history) legitimately use that name. Update current-identity references to Folio; preserve historical references as history.
