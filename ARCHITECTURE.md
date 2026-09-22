# folio-engine — Architecture (Lessons 0–11)

A 100% local, offline document-processing core written in Rust, plus (as
of Lesson 9) a developer testbench that exercises the engine through a
stable application-level API boundary. Lesson 0
established the module boundaries and execution infrastructure; Lesson 1
added the first real operation (`pdf.inspect`) on top of them; Lesson 3
added the first document transformation (`pdf.extract_pages`); Lesson 4
added multi-part orchestration (`pdf.split`) over the shared copy
primitive; Lesson 5 added permutation reorder (`pdf.reorder`) over the
same primitive; Lesson 6 added subtractive selection
(`pdf.delete_pages`) over the same primitive; Lesson 7 added relative
rotation (`pdf.rotate`) over a full copy plus per-page `/Rotate`
materialization; Lesson 8 added multi-document assembly (`pdf.merge`)
over per-source remapping tables. No UI, no storage, no networking, no
WASM bindings.

## 1. What the core IS responsible for

- Generic document abstraction (`core::document`).
- Operation model: `Input + Options -> Operation -> Result` (`core::operation`).
- Typed errors with stable codes (`core::error`).
- Typed results with automatic timing (`core::result`).
- Jobs, execution contexts, progress, cancellation, scheduling boundary
  (`execution::*`).
- Structured events and timing primitives (`observability::*`).
- A home for future PDF operations (`processing::pdf::<operation>`).

## 2. What the core is NOT responsible for

- UI, TypeScript, browser APIs, workers, OPFS, IndexedDB.
- Filesystem access, HTTP, networking, cloud infrastructure.
- Persistence or caching (an outer application-engine concern).
- Scheduling work across threads (only the boundary exists; see §8).

Anything in this list must live outside this crate, behind a future
WASM/TS boundary.

## 3. Module boundaries

```text
src/
├── lib.rs            crate root + re-exports
├── core/             domain types (no deps on execution/observability)
│   ├── clock.rs      platform clock swap point (Lesson 10: JS clocks on WASM)
│   ├── document.rs   Document, DocumentId, MediaType, DocumentData
│   ├── operation.rs  Operation trait, OperationContext, capabilities
│   ├── error.rs      EngineError + stable ErrorCode
│   └── result.rs     OperationResult + CompletionStatus
├── execution/        runs operations, owns timing
│   ├── job.rs        JobId (process-unique), JobState, Job transitions
│   ├── context.rs    ExecutionContext (implements core::OperationContext)
│   ├── progress.rs   ProgressEvent, ProgressSink, SubProgressMapper
│   ├── cancellation.rs  CancellationToken / CancellationSource
│   └── scheduler.rs  SchedulerPolicy, InlineScheduler, ExecutionEngine
├── observability/    events + clocks
│   ├── event.rs      EngineEvent, LogLevel
│   ├── logger.rs     EventSink, Noop/Vec/Fn sinks
│   └── timing.rs     wall_now(), Timer (monotonic)
├── processing/       operations only; no shared infra duplicated here
│   └── pdf/
│       ├── core/     PdfDocument, loader, page-copy primitive, PageNumber
│       ├── inspect/  pdf.inspect (InspectOperation, PdfInspection)
│       ├── extract/  pdf.extract_pages (ExtractPagesOperation, output doc)
│       ├── split/    pdf.split (SplitOperation, multi-part orchestration)
│       ├── reorder/  pdf.reorder (ReorderOperation, full permutation)
│       ├── delete/   pdf.delete_pages (DeletePagesOperation, subtractive selection)
│       ├── rotate/   pdf.rotate (RotateOperation, relative rotation)
│       └── merge/    pdf.merge (MergeOperation, multi-document assembly)
└── testing/          test-only utilities (ships with the lib, used by tests/tools)
    ├── mod.rs        dummy Echo/Failing operations (Lesson 0 harness, not a feature)
    └── pdf.rs        engine-path helpers, assertions, benchmark records
```

Dependency direction: `processing -> execution -> core`, and
`execution -> observability`. `core` never imports from `execution`
except via the `OperationContext` trait, which `execution` implements —
so operations depend on an abstraction defined in `core`, not on the
engine itself. There are no circular module dependencies.

## 4. Operation model

```rust
trait Operation {
    type Input;    // validated input
    type Options;  // validated knobs
    type Output;   // typed success value
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> OperationCapabilities;
    fn execute<C: OperationContext>(&self, ctx: &C, input: Self::Input, options: Self::Options)
        -> Result<Self::Output, EngineError>;
}
```

Strong typing per operation — no untyped `HashMap<String, Value>`
plumbing. Each future PDF capability (`inspect`, `split`, `merge`, …)
implements this trait in its own module.

Capabilities (`OperationCapabilities { parallelism, supports_progress,
supports_cancellation, supports_streaming }`) declare what the
scheduler may do. `ParallelismHint::{Sequential, SubTaskParallel,
FullyParallel}` records that rendering may parallelize while structural
ops (reorder) stay sequential. Nothing is parallelized in Lesson 0.

## 5. Job lifecycle

```text
Pending → Running → Completed | Failed | Cancelled
```

- `Job::new` creates a `Pending` job; transitions are validated
  (`mark_running` only from `Pending`, `mark_terminal` only from
  `Running` into a terminal state).
- `ExecutionEngine::execute` assigns a fresh `JobId` per call
  (process-unique atomic counter, zero dependencies, WASM-portable),
  builds an `ExecutionContext`, runs the operation inline, and wraps the
  outcome in an `OperationResult` with timestamps + duration.
- Errors missing job/operation context are annotated by the engine, so
  every failure is attributable.

## 6. Progress model

`ProgressEvent { job_id, phase, completed, total, percentage, message,
timestamp }` — never a bare integer. `total == 0` means indeterminate.
Conventional phases (`loading → analysing → processing → writing
output`) map onto sub-ranges of 0–100%.

Sinks implement `ProgressSink::emit`; the engine ships no-op by default,
with `Vec`/`Fn` sinks for tests, benchmarks, and the future TS layer.
`SubProgressMapper` maps a child's `0..=total` range into a parent
percentage window, which is the aggregation primitive the future
multi-worker scheduler will use (job → workers) without workers knowing
about each other.

## 7. Error model

`EngineError { code, message, operation?, job_id?, timestamp, details? }`
with stable wire codes (`INVALID_DOCUMENT`, `INVALID_PAGE_RANGE`,
`PAGE_OUT_OF_RANGE`, `PROCESSING_FAILED`, `CANCELLED`,
`UNSUPPORTED_FORMAT`, `IO_ERROR`, `INVALID_INPUT`, `INVALID_OPTIONS`,
`INTERNAL`). Internal/low-level library errors must be translated into
`EngineError` at module boundaries and never leak raw. Cancellation is
an error with code `CANCELLED`, which the result layer maps to
`CompletionStatus::Cancelled`.

## 8. Timing / observability

- `started_at` / `completed_at`: wall clock (`SystemTime`) — answers "when".
- `duration`: monotonic clock (`Instant::elapsed`) — answers "how long",
  immune to clock adjustments. Never derived by subtracting wall times.
- The engine captures both automatically; operations must not manage timers.
- Structured `EngineEvent { timestamp, level, job_id?, operation?,
  phase?, message }` replaces `println!` debugging. `EventSink` is
  replaceable (console, benchmark collector, diagnostics, TS layer).

These metrics will feed debugging, benchmarking, regression detection,
and worker/concurrency tuning once real operations exist.

## 9. Scheduler / concurrency philosophy

- `SchedulerPolicy::strategy_for(capabilities) -> ExecutionStrategy`
  is the seam where inline vs. parallel-chunks vs. bounded-concurrency
  decisions will live. `InlineScheduler` always returns `Inline`.
- No worker pool, no chunking, no `1 page = 1 worker` assumption. The
  future scheduler will choose per operation and workload (page count,
  op kind), supporting single-threaded, multi-worker, dynamic chunking,
  and operation-specific strategies (sequential orchestration with
  parallel sub-work such as rendering/analysis).
- Designed for 10→500+ page documents, but nothing is pre-parallelized:
  parallelism stays operation-aware.

## 10. Future WASM integration boundary

The core is a plain native library with no browser imports and no
`wasm-bindgen`. `lopdf` is the first dependency (see §12), configured
with `default-features = false` (no `rayon` threading, no `chrono-clock`
timezone chain) to stay WASM-friendly. Integration will come as an
outer crate that:

1. receives calls + bytes/handles from TypeScript,
2. builds core `Document`/`Input`/`Options` values,
3. runs `ExecutionEngine`,
4. translates `OperationResult`/`EngineError` (stable code strings) and
   progress/event streams back across the boundary.

> **Realized in Lesson 10** (see §21): the outer crate is `wasm/`
> (`WasmEngine`), the TypeScript side is `WasmWorkerEngineAdapter` +
> `engine.worker.ts`, and the four steps above are exactly what the glue
> does — no PDF logic outside the core.

> **Architectural rule:** a new processing capability should normally be
> implemented as an independent operation module and must not introduce
> UI, storage, networking, or runtime-specific dependencies into the
> processing core.

Decisions affecting that boundary (see §11) are recorded here rather
than baked in silently.

## 11. Decisions and open questions for review before Lesson 1

1. **Zero dependencies.** No crates added. `JobId` uses a process-local
   atomic counter (`job-N`) instead of UUIDs to stay portable and avoid
   `getrandom` on WASM. If cross-process/global uniqueness is needed,
   revisit (UUID v4/v7) at the WASM-boundary lesson.
   *Amendment (Lesson 9 revision):* `[dev-dependencies]` now carries
   `serde`/`serde_json` for dev-only tooling (`examples/dev_bridge.rs`
   and its tests). The library itself stays serde-free — no operation,
   execution, or core module imports them; `lopdf` remains the only
   `[dependencies]` entry.
   *Amendment (Lesson 10):* the Lesson 9 bridge is removed, so those
   dev-dependencies are gone again. Instead there are two
   `target.'cfg(target_arch = "wasm32")'` dependencies (see §21):
   `lopdf/wasm_js` (JS-backed `getrandom`) and `js-sys` (JS clocks).
   Native builds see zero new dependencies from that section.
2. **`OperationContext` lives in `core`, implemented by `execution`.**
   This keeps the dependency arrow `execution -> core` while still
   giving operations progress/cancellation access. Alternative
   (context defined in `execution`, `core` generic over it) was
   rejected to keep `core` self-contained.
3. **No `benches/` yet.** Criterion would add dependencies for zero
   benefit before real operations exist; benchmarking starts with the
   first real PDF op (Lesson 1).
4. **No placeholder op modules** (`split/`, `merge/`, …) as source
   files — only the documented layout above. Empty stub files would
   suggest scaffolding without contracts; each operation module should
   arrive with its trait impl + tests.
5. **PDF library evaluation deferred**, per the lesson brief. First
   operation (likely `inspect`) should start with that evaluation.

## 12. Lesson 1 — PDF foundation + `pdf.inspect`

### Why `lopdf` as the initial library

- Pure-Rust, offline, no system dependencies — fits the local-first core
  and the eventual WASM target (no PDFium native binary, no Node.js,
  no browser APIs).
- Covers both structural access (needed now: page tree, boxes, Info
  dict, trailer) and future mutation (needed later: split, merge,
  rotate, encrypt), so one library spans many upcoming lessons.
- Mature and maintained (0.45.x): handles xref tables and streams,
  object streams, and transparent empty-password decryption.
- `default-features = false`: drops `rayon` (threading is unsuitable
  for single-threaded WASM and we want sequential baselines first) and
  `chrono-clock` (PDF dates are fixed-offset; full tz database chain
  unnecessary). When wasm32 becomes a target, `lopdf`'s `wasm_js`
  feature (for `getrandom`-backed encryption) will need review.

### Why `lopdf::Document` is hidden

`processing::pdf::core::PdfDocument` owns the parsed document and is
the only type operations see. `lopdf` types (`Document`, `Object`,
`ObjectId`, `Dictionary`) appear solely inside `core::document`
(structural reads) and `core::loader` (parsing). Rationale:

- Operations stay written against engine concepts (page numbers,
  points, rotation degrees), not a third-party object model.
- The parser can be swapped or complemented later without rewriting
  every operation.
- Error translation happens once, at the loader boundary: `lopdf::Error`
  becomes `EngineError` (`INVALID_DOCUMENT`, `UNSUPPORTED_FORMAT`, …)
  with a truncated cause in `details`.

### What `PdfDocument` is responsible for

- Loading from bytes (`loader::load_pdf(&[u8])` — borrowed, never
  copied again; caller's buffer untouched).
- `page_count`, `pdf_version`, `is_encrypted` / `was_encrypted`.
- Best-effort `metadata()` — missing Info yields `None` fields, never
  an error. Text strings decode UTF-16BE (BOM) else UTF-8/Latin-1
  fallback; full PDFDocEncoding tables are deferred.
- `page_geometry(n)` — MediaBox width/height in points plus effective
  rotation, with inheritance resolved along the page-tree ancestors
  (`Rotate` accumulates, mod 360). Degenerate/missing boxes are
  `INVALID_DOCUMENT`, not silent defaults.
- Read-only: only `&self` accessors exist.

### What `pdf.inspect` does (and does not do)

`processing::pdf::inspect::InspectOperation` (`"pdf.inspect"`) takes
owned bytes (or an inline core `Document`; storage references are
rejected with `INVALID_INPUT`) and returns a structured `PdfInspection`
— pure data, no formatted text:

- `InspectLevel::Basic` (the default): page count, PDF version,
  encryption state, metadata. Never iterates pages for geometry, so a
  multi-thousand-page document inspects cheaply.
- `InspectLevel::Detailed`: everything from Basic plus
  `pages: Option<Vec<PdfPageInspection>>` (number + width/height in
  points + normalized rotation, in document order). `pages` is `None`
  in basic mode, making "no page-detail work" explicit in the type.
- `InspectOptions { level }` stays a struct (not a bare enum) so future
  knobs extend without signature churn.

- Progress reuses Lesson 0 events: loading (5%) → parsing (15%) →
  per-page sweep across 15–95% → completed (100%).
- Cancellation is checked after load and on every page via the existing
  token; no new mechanism.
- Still-encrypted (password-locked) input fails cleanly with
  `UNSUPPORTED_FORMAT`; empty-password files that `lopdf` decrypts
  transparently inspect normally with `encrypted: true`.
- Does NOT do: text extraction, rendering, image extraction, mutation
  of any kind, compression, encryption/decryption. Each is a later
  lesson with its own operation module.

### Room for future parallelism

`pdf.inspect` declares `parallel_friendly()` (`SubTaskParallel`):
orchestration stays sequential today while the per-page geometry loop
is the natural unit for bounded parallel sub-work later. The engine
still runs it inline; no worker pool, no page-per-worker assumption.
`PdfDocument` is owned per execution, so a future scheduler can share
it across scoped worker threads without redesign. Memory posture: one
parse per execution, no extra full-size copies beyond `lopdf`'s own
structures; a metadata-only fast path (`load_metadata`) is available
in `lopdf` if profiling ever justifies it.

### Rendering is intentionally outside this lesson

Inspection reads structure only (dictionaries, boxes, trailer). No
content-stream interpretation, no rasterization, no font handling. A
render operation will arrive as its own module with its own capability
profile (likely `FullyParallel`) once measurement baselines exist.

### Manual corpus harness

`examples/inspect_pdf.rs` (`cargo run --example inspect_pdf --
<path-to-pdf>`) reads a file and prints the inspection result with
engine timing. Filesystem access lives in the example only; the core
receives bytes. The automated suite uses small generated fixtures and
never depends on `test-pdfs/`.

## 13. Lesson 2 - Test & benchmark infrastructure

### Fixture strategy

Automated tests must pass on a fresh checkout with no external corpus:

- **Unit tests** build PDFs in memory via `processing::pdf::core::fixtures`
  (`#[cfg(test)]`, `lopdf` writer API): `single_page_pdf()`,
  `mixed_pages_pdf()` (varied dimensions/rotations/metadata),
  `build_locked_pdf()`, plus parametric `pdf_spec`/`build_pdf`.
- **Integration tests** mirror the named set in `tests/common/mod.rs`
  (same shapes/values) using the dev-dependency `lopdf`. The two
  builders cannot share code because the unit one is `#[cfg(test)]`
  inside the library; the duplication is one small parametric builder
  and is documented here rather than hidden.
- The real-world `test pdfs/` directory is an **optional external
  corpus**: never scanned by `cargo test`, never a test dependency.

### Helper layout (`testing::pdf`)

Reusable, engine-typed helpers with no `lopdf` dependency, usable from
unit tests, integration tests, examples, and later the WASM harness:

- `test_engine()` / `run_operation()` — execute through the real engine.
- `expect_success()` / `expect_error()` / `assert_lifecycle_complete()` /
  `assert_progress_completed()` — behavioral assertions with
  `#[track_caller]`.
- `malformed_inputs()` — corpus-free error-path inputs.
- `temp_output_path()` — unique temp paths for future file-producing ops.
- `BenchmarkCase` / `benchmark_operation()` / `measure_result()` /
  `summarize_measurements()` / `BenchmarkMeasurement::to_json()` /
  `BenchmarkReport::to_json()` — benchmark records with hand-rolled JSON
  (no serde dependency by design).

### Correctness convention

Every operation test follows Arrange → execute through the real
`ExecutionEngine` → assert outcome → assert lifecycle (timestamps,
status, attribution) → validate produced data. Bypassing the engine is
reserved for unit tests targeting internal helpers. `tests/pdf_inspect.rs`
is the reference implementation of this pattern.

### Opt-in corpus testing

`cargo run --example corpus_inspect -- [FILES]... [--dir DIR]
[--filter SUB] [--limit N] [--detailed] [--repeat N] [--json]`

- Explicit files or sorted/filtered/capped directory discovery
  (default cap 25, `--limit 0` uncaps). Reaching for this example IS
  the opt-in; nothing runs implicitly.
- Reads only; nothing is ever written to the corpus.
- All runs complete before anything prints, so console output never
  pollutes a measurement.

### Benchmarks

Same example with `--repeat N`: each file runs N times through the
engine and reports min/max/mean/median over the authoritative engine
durations, plus `--json` for machine-readable output. No Criterion, no
worker pools, no optimization — measure first.

`BenchmarkMeasurement` captures: operation, input label, file bytes,
page count (when reported), success, `engine_duration_ms` (monotonic,
from `OperationResult`), wall-clock timestamp, and error code/message
on failure. `page_count_of` is a caller closure so future operations
plug in without touching the helper.

### Deliberately not built

Parallelism of any kind, performance optimization (the ~1s vs tens of
seconds spread across large PDFs is recorded as baseline, not solved),
statistical benchmarking beyond min/max/mean/median, committed binary
fixtures, UI/browser/TS/HTTP concerns.

## 14. Lesson 3 — `pdf.extract_pages`

### Purpose

First real document transformation: copy selected pages into a new PDF.
`ExtractPagesOperation` (`"pdf.extract_pages"`) takes
`ExtractPagesInput` (owned bytes or inline `Document`) plus
`ExtractPagesOptions { pages: Vec<PageNumber> }` and returns
`ExtractPagesOutput { document: PdfDocument }` — an engine-side document
that can be inspected further, passed to another operation, or serialized
via `PdfDocument::save_to_bytes` for file output / WASM transfer.

### Input contract and numbering

- `PageNumber = u32` (1-based at every public boundary; page 1 is the
  first page). No range-string parsing exists anywhere in the core; the
  CLI parses integers into the structured list.
- Empty selection → `InvalidInput`. Any out-of-range entry (including 0)
  → `PageOutOfRange` naming the requested page, with details carrying the
  document page count and the bad selection index.
- The complete selection is validated before any output is constructed,
  so `[1, 2, 999999]` fails without a partial document.

### Ordering and duplicates

Output order always equals selection order (`[5, 2, 4]` → input pages
5, 2, 4), which makes reordered subsets fall out naturally. Duplicates
(`[2, 2, 5]`) are copied independently per entry (never silently
deduplicated), each with fresh objects. Full-document permutation with
strict exactly-once semantics is the separate `pdf.reorder` operation
(§16), not a mode of extract.

### Copy mechanism (`processing/pdf/core/copy.rs`)

Deep-copies each selected page dictionary plus its reachable closure
(content streams, resources, fonts, images, annotations, nested indirect
objects) into a fresh document with remapped references. Key properties:

- Fresh reference table per selection entry (shared objects stay shared
  *within* one page's closure; entries stay independent).
- `Parent` is never copied; pages are re-parented to the new `Pages` node.
  The source page id is pre-registered so annotation `/P` back-references
  resolve to the new page instead of dragging in the source tree.
- Inheritable attributes (`Resources`, `MediaBox`, `CropBox`, `Rotate`)
  are materialized explicitly when the source page relied on ancestors,
  so extracted pages stand alone (depth-bounded ancestor walk).
- `Info` metadata is carried over best-effort; version is preserved.
- Deliberately NOT carried: `Outlines`, `PageLabels`, `Names`, `AcroForm`,
  structure trees — all tied to the original document's page set.
- Per-entry callback reports progress and may abort (cancellation);
  failure never exposes a partial document (atomicity).
- `lopdf` stays inside `core/copy.rs`; the single `pub(crate)`
  `raw_document` accessor is the only hatch, documented as such.

### Progress / cancellation / timing

Progress reuses Lesson 0 events: validating (5%) → preparing (10%) →
per-page extraction across 10–95% → finalizing (100%). Cancellation is
checked before validation, after parsing, and after every copied page via
the existing token. Timing stays entirely with `ExecutionEngine`; the
operation performs only PDF work. Capabilities: `parallel_friendly()`
(sequential today; the per-page loop is the future parallel unit).

### Developer tools

- `cargo run --example extract_pages -- <input.pdf> 1 3 5 [--out out.pdf]
  [--repeat N]` — parses CLI integers (core never sees strings), saves to
  `<stem>_extracted.pdf` in the working directory by default, then
  re-loads the written file to prove validity; `--repeat` reports
  min/max/mean engine timing via the Lesson 2 benchmark helpers.
- Extract benchmarks reuse `testing::pdf::benchmark_operation`
  (see `tests/pdf_extract.rs` smoke test); corpus validation stays manual
  and opt-in, one file at a time.

### Intentionally NOT handled yet

Split, delete, reorder-as-operation, rotate, merge, optimization,
encryption/decryption, rendering, text/image extraction, WASM/TS.

## 15. Lesson 4 — `pdf.split`

### Purpose

Divide one PDF into multiple independent PDFs. `SplitOperation`
(`"pdf.split"`) takes `SplitInput` (owned bytes or inline `Document`)
plus `SplitOptions { parts: Vec<SplitPart> }` — where `SplitPart {
pages: Vec<PageNumber>, name: Option<String> }` — and returns
`SplitOutput { parts: Vec<SplitPartOutput>, input_page_count: u32 }`.
Each `SplitPartOutput { document: PdfDocument, name: Option<String> }`
is an ordinary engine-side document: inspectable, serializable,
reloadable, usable by later operations.

### Orchestration, not a second copier

Split reuses Lesson 3's deep-copy primitive (`core::copy::copy_pages`)
once per part: single `ExecutionEngine` execution, single lifecycle,
single timing record — never nested engine executions per part. The only
shared-primitive refactor this required was extracting the range check
into `find_invalid_page`, so the plan validator and the copier enforce
the same rule; `copy_pages` messages are byte-identical to Lesson 3.

### Numbering, ordering, duplicates, overlap

Same 1-based contract as extract: `0` and anything above the page count
are invalid. Order inside each part is preserved exactly (no sorting);
duplicates are copied independently per entry; parts may overlap
(`[1,2,3]` + `[3,4,5]`) with no global deduplication. Part names are
opaque engine-level metadata — the core never treats them as filenames.

### Validation and atomicity

The entire plan is validated before anything is constructed: non-empty
plan, non-empty parts, every page in range. Failures carry part-aware
structured errors, e.g. message `"part 2, page entry 3 references page
999, but the document contains only 50 pages"` with details
`part=2 entry=3 page=999 page_count=50` (1-based, matching the message).
Outputs accumulate in local state and `SplitOutput` is returned only
after every part succeeds — a failed split never exposes partial output.

### Progress / cancellation / timing

Progress reuses Lesson 0 events over the whole operation: validating
(5%) → preparing (10%) → per-page work across parts in the 10–95% band
(`"part 2 of 3, page 5 of 10"`, counted globally so percentages are
monotonic) → finalizing (100%, only after all parts exist).
Cancellation is checked after validation, before each part, after every
copied page, and before finalization. Timing stays entirely with
`ExecutionEngine`. Capabilities: `parallel_friendly()` (sequential
today; whole parts — not pages — are the documented future parallel
unit; no Rayon, no thread pool).

### Preservation

Identical to extract by construction (same primitive): geometry,
inherited boxes/rotation materialized, resources/content/fonts/images/
annotations, `Info` best-effort, version preserved; no
Outlines/PageLabels/Names/AcroForm/structure trees.

### Developer tools

- `cargo run --example split_pdf -- <input.pdf> --part 1,2,3[:name]
  --part 4,5 [--out-dir DIR] [--repeat N] [--json]` — comma-list (plus
  optional `:name`) parsing lives in the example only; the core receives
  structured parts. Writes `<stem>-part-<i>[-name].pdf`, re-loads every
  written file to prove validity, prints engine timing; `--repeat`
  reports min/max/mean; `--json` emits the §18 benchmark fields
  (operation, input, bytes, input/output page counts, part counts,
  engine durations, errors) around the standard report JSON.
- Split benchmarks reuse `testing::pdf::benchmark_operation` (see
  `tests/pdf_split.rs` smoke test); corpus validation stays manual and
  opt-in.

### Intentionally NOT handled yet

Merge, delete, rotate, image-to-PDF,
optimization, encryption/decryption, rendering, WASM/TS, and any
parallel execution.

## 16. Lesson 5 — `pdf.reorder`

### Purpose

Reorder every page of a PDF into a new PDF. `ReorderOperation`
(`"pdf.reorder"`) takes `ReorderInput` (owned bytes or inline `Document`)
plus `ReorderOptions { order: Vec<PageNumber> }` and returns
`ReorderOutput { document: PdfDocument, page_count: u32 }` — an ordinary
engine-side document: inspectable, serializable, reloadable, usable by
later operations.

### Permutation requirement (vs `extract_pages`)

`extract_pages` means "a new PDF containing the requested pages" and
allows subsets and repeats (`[1, 3, 3, 5]` → 3 pages). `reorder` means
"the same pages in a different order": for an N-page document the order
must contain exactly N entries with every page `1..=N` exactly once.
`[1, 2, 3, 4]` (missing 5), `[1, 2, 2, 3, 4]` (duplicate 2, missing 5),
and `[1, 2, 3, 4, 5, 5]` (duplicate 5) are all rejected — never
normalized, deduplicated, completed, or sorted. The identity order is
valid and produces an independent copy like any other order; there is no
special case. This distinction matters for the future TypeScript command
API.

### Validation

The entire order is validated before anything is constructed, in a fixed
order so errors are deterministic: emptiness (`InvalidInput`), length
(`InvalidInput`, e.g. "order has 4 entries but the document has 5
pages"), range via the shared `find_invalid_page` helper
(`PageOutOfRange`, 1-based entry numbers), then uniqueness
(`DuplicatePage`, e.g. "page 4 appears more than once" with details
`page=4 first_position=2 duplicate_position=5 page_count=5`). No partial
output is ever exposed; only `ReorderOutput` after full success.

### Construction and preservation

Output construction is a single `copy_pages(source, order)` call, so
reorder inherits all Lesson 3 guarantees unchanged: deep-copied page
closures, materialized inheritable attributes, best-effort `Info`,
preserved version, independent pages. Per-page content follows the
requested order (verified down to individual text runs in tests).

### Progress / cancellation / timing

Progress reuses Lesson 0 events: validating (5%) → preparing (10%) →
per-page copying across 10–95% → finalizing (100%, only after success).
Cancellation is checked after validation, after parsing, after every
copied page, and before finalization; a cancelled run returns the
structured cancellation error with no partial output. Timing stays
entirely with `ExecutionEngine`. Capabilities: `parallel_friendly()`
(sequential today; the per-page copy loop is the future seam — no
parallelism is claimed or implemented).

### Developer tools

- `cargo run --example reorder_pdf -- <input.pdf> --order 5,2,4,1,3
  [--out out.pdf] [--repeat N] [--json]` — comma-list parsing lives in
  the example only; the core receives the structured permutation. Saves
  to `<stem>-reordered.pdf` by default, re-loads the written file to
  prove validity, prints engine timing; `--repeat` reports min/max/mean;
  `--json` emits operation, input, bytes, page counts, order, and the
  standard report JSON.
- Reorder benchmarks reuse `testing::pdf::benchmark_operation` (see
  `tests/pdf_reorder.rs` smoke test); corpus validation stays manual and
  opt-in.

### Intentionally NOT handled yet

Merge, delete, rotate, image-to-PDF, optimization, encryption/decryption,
rendering, WASM/TS, and any parallel execution.

## 17. Lesson 6 — `pdf.delete_pages`

### Purpose

Remove selected pages from a PDF. `DeletePagesOperation`
(`"pdf.delete_pages"`) takes `DeletePagesInput` (owned bytes or inline
`Document`) plus `DeletePagesOptions { pages: Vec<PageNumber> }` and
returns `DeletePagesOutput { document, input_page_count, output_page_count }`
— an ordinary engine-side document: inspectable, serializable,
reloadable, usable by later operations. The source is never mutated.

### Deletion semantics

Delete means "remove exactly these pages; keep everything else in
original order". Request order is irrelevant (`[5, 2, 4]` on a 5-page
document still yields `1 3`), since survivors are computed by a single
ordered scan. Duplicates (`[2, 2, 5]`) are rejected with `DuplicatePage`,
never silently deduplicated. An empty list is a valid no-op returning an
independent full copy (composable, predictable — no zero-copy shortcut).
Deleting every page is rejected (`InvalidInput`, "would produce an empty
document") with `input_page_count` / `requested_delete_count` /
`output_page_count=0` details: zero-page PDFs are not produced.

### Validation order

Fixed and deterministic: source parses → not locked → every entry in
range (`PageOutOfRange`, via shared `find_invalid_page`) → no duplicates
(`DuplicatePage`, 1-based `first_position`/`duplicate_position`) →
remainder non-empty. First failing category wins; e.g. `[0, 2, 2, 999]`
reports the range error. All validation completes before construction,
so failures are atomic.

### Construction and preservation

One ordered scan builds the surviving list (`HashSet` membership over
`1..=N`), then a single `copy_pages(source, remaining)` call — the input
is parsed once, deleted pages are never copied, nothing is re-parsed or
reloaded mid-operation. All Lesson 3 guarantees carry over unchanged
(geometry, rotation, resources, content, fonts, metadata, version).
Per-page content follows survivors exactly (verified down to individual
text runs in tests); source bytes and page count are untouched.

### Progress / cancellation / timing

Progress reuses Lesson 0 events: validating (5%) → preparing (10%) →
per surviving page across 10–95% → finalizing (100%, only after
success); monotonic, never premature. Cancellation is checked after
validation, after parsing, periodically while scanning
(every 1024 pages), before copying, after every copied page, and before
finalization; a cancelled run returns the structured cancellation error
with no partial output. Timing stays entirely with `ExecutionEngine`.
Capabilities: `parallel_friendly()` (sequential today; the per-page copy
loop is the future seam — no parallelism is claimed or implemented).

### Developer tools

- `cargo run --example delete_pages -- <input.pdf> --pages 2,4,7
  [--out out.pdf] [--repeat N] [--json]` — comma-list parsing lives in
  the example only (including `--pages ""` for the no-op case); the core
  receives the structured list. Saves to `<stem>-deleted.pdf` by
  default, re-loads the written file to prove validity, prints engine
  timing; `--repeat` reports min/max/mean; `--json` emits operation,
  input, bytes, input/output page counts, deleted pages, and the
  standard report JSON.
- Delete benchmarks reuse `testing::pdf::benchmark_operation` (see
  `tests/pdf_delete.rs` smoke test); corpus validation stays manual and
  opt-in.

### Intentionally NOT handled yet

Merge, image-to-PDF, optimization, encryption/decryption,
rendering, WASM/TS, and any parallel execution.

## 18. Lesson 7 — `pdf.rotate`

### Purpose

Rotate selected pages by a relative angle. `RotateOperation`
(`"pdf.rotate"`) takes `RotateInput` (owned bytes or inline `Document`)
plus `RotateOptions { pages: Vec<PageNumber>, angle_deg: i32 }` and
returns `RotateOutput { document: PdfDocument, page_count: u32 }` — an
ordinary engine-side document: inspectable, serializable, reloadable,
usable by later operations. The source is never mutated.

### Relative semantics and normalization

The angle adds to each selected page's effective rotation: `90°` on
`90°` gives `180°`; results wrap modulo 360, so `+90°` on `270°` gives
`0°` and `-90°` on `0°` gives `270°`. Only quarter turns are supported
(`/Rotate` represents multiples of 90°): any integer equivalent to a
multiple of 90° is accepted (`360` → `0`, `450` → `90`, `-360` → `0`);
anything else (`45`, `-45`, `135`, …) fails with `InvalidInput` before
the document is even parsed. Integer-only arithmetic throughout — no
floating point. The `pages` list only names pages (order irrelevant);
duplicates are rejected with `DuplicatePage`. Empty selection and `0°`
are valid no-ops producing an independent full copy, never the original
object.

### Copy strategy

Parse once, then `copy_pages` over the full page list (one uniform path
even for empty selections), then resolve and store each selected page's
final rotation on the copy. This reuses the tested primitive instead of
a second traversal, at the cost of copying unselected pages too — the
documented trade-off, consistent with every sibling operation's output
shape (fresh flat document, best-effort `Info`, preserved version).
No nested engine executions, no save/reload between pages, no rendering.

### Inherited `/Rotate` and shared ancestors

Effective rotation resolves nearest-holder-wins up the page tree
(`PdfDocument::effective_rotation`), matching PDF inheritance
semantics: ancestor `90` + bare pages reads `[90, 90, 90]`; ancestor
`90` + page-level `180` reads `[90, 180, 90]`. Each selected page gets
its final value materialized explicitly via
`PdfDocument::set_page_rotation` (normalized zero stored as explicit
`/Rotate 0`, deterministically). Because the copy has a rotation-free
flat root, writing a page's own entry cannot shift unselected pages —
ancestors are read, never mutated. Note: `page_geometry` historically
*accumulates* chained rotations instead; the two agree whenever at most
one `/Rotate` exists in a chain (the common case), and `page_geometry`
is deliberately left untouched.

### Validation, atomicity, progress, cancellation

Fixed validation order — angle, range (`PageOutOfRange`, 1-based
entries), duplicates (`DuplicatePage` with positions) — all before
construction; first failing category wins deterministically. Outputs
accumulate in local state; only `RotateOutput` after full success.
Progress reuses Lesson 0 events: validating (5%) → preparing (10%) →
copying 10–80% → applying 80–95% → finalizing (100%, only after
success); monotonic, never premature. Cancellation is checked after
validation, after parsing, after every copied and every rotated page,
and before finalization. Timing stays entirely with `ExecutionEngine`.
Capabilities: `parallel_friendly()` (sequential today; the per-page copy
loop is the future seam — no parallelism is claimed or implemented).

### Preservation and metadata

Only `/Rotate` entries change: content streams, resources, fonts,
images, annotations, MediaBox/CropBox, and destinations are carried by
the shared primitive untouched (geometry is never rewritten — the
viewer interprets rotation). Metadata policy matches Lessons 3–6;
outlines, labels, names, forms, and structure trees remain out of scope,
as does any annotation-coordinate transform (standard `/Rotate`
viewer interpretation is relied upon).

### Developer tools

- `cargo run --example rotate_pdf -- <input.pdf> --pages 2,4 --angle 90
  [--out out.pdf] [--repeat N] [--json]` — comma-list parsing lives in
  the example only; the core receives structured values. Saves to
  `<stem>-rotated.pdf` by default, re-loads the written file, prints
  effective rotations and engine timing; `--repeat` reports min/max/mean;
  `--json` emits operation, input, bytes, page counts, selection, angle,
  and the standard report JSON.
- Rotate benchmarks reuse `testing::pdf::benchmark_operation` (see
  `tests/pdf_rotate.rs` smoke test); corpus validation stays manual and
  opt-in.

### Intentionally NOT handled yet

Image-to-PDF, optimization, encryption/decryption,
rendering, WASM/TS, and any parallel execution.

## 19. Lesson 8 — `pdf.merge`

### Purpose

Combine multiple PDFs into one PDF, in order. `MergeOperation`
(`"pdf.merge"`) takes `MergeInput { documents: Vec<PdfDocument>, name }`
plus the empty `MergeOptions` and returns `MergeOutput { document,
input_document_count, input_page_count, output_page_count }` — an
ordinary engine-side document: inspectable, serializable, reloadable,
usable by later operations. Inputs are never mutated, deduplicated, or
reordered — not even identical ones.

### Cross-document remapping (`core::copy::merge_documents`)

The shared page-body copier (`copy_page_body`, factored out of
`copy_single_page` with byte-identical Lesson 3 behavior) is driven once
per source document, each with its own reference table:

- Identical object numbers from different documents never collide: each
  table maps into fresh destination-owned IDs (`new_object_id`, no
  hard-coded offsets).
- Shared objects *within* one document are copied exactly once (the
  table is also the visited set, so cycles terminate).
- Every source page is pre-registered before any body is copied, so
  inter-page references (link destinations, `/P` back-references)
  resolve to the copied pages instead of dragging in shadow copies of
  source trees. First registration wins, keeping even degenerate shared
  page objects valid.
- Inheritable attributes are materialized per page exactly like
  extraction, so each copied page stands alone in the new flat tree.
  Nothing is inherited across documents: ancestor `Rotate 90` in
  document A cannot leak into B's pages.

The output gets one fresh page tree (`Catalog` → `Pages` → copied
pages in input order, correct `Kids`/`Count`), built only after every
page succeeds — never a partial document.

### Validation and atomicity

Fixed order: non-empty list (`InvalidInput`), per-document locked check
(`UnsupportedFormat`, first failure wins, details carry
`document_index`), non-empty page total (`InvalidInput`). Copy errors
(e.g. dangling references) abort the whole merge, attributed with
`document_index=` prefixed onto the preserved inner details.
Cancellation is checked before the run, after validation, on every
copied page, and before finalization; no partial output ever escapes.

### Metadata and version policy

Deterministic and minimal: `Info` is the first source document's,
copied best-effort (absent/unreadable → no `Info`, never cross-wired or
concatenated); output version is the maximum required source version
(`1.4` + `1.7` → `1.7`, `2.0` wins over `1.7`), never downgraded.

### Explicitly omitted document-level structures

Outlines/bookmarks, PageLabels, Names (so *named* destinations do not
survive — only explicit ones, which are remapped), AcroForms, structure
trees, and tagged-PDF structures are not carried over. The fresh catalog
contains only `Type`/`Pages`. Rationale, applied consistently with
Lessons 3–7: omission over partial corruption. A form-bearing input
still merges its page content; its field model is documented as dropped.

### Empty inputs

Zero-page source documents contribute zero pages without breaking the
run; if every input is empty (or the list is), the merge fails with
`InvalidInput` rather than producing a zero-page PDF. A single input is
a valid independent copy — never the original object.

### Progress / cancellation / timing

Progress reuses Lesson 0 events over the whole operation: validating
(5%) → preparing (10%) → per-page copying in the 10–95% band counted
globally (`"document 2 of 3, page 5 of 20"`, never reset per document)
→ finalizing (100%, only after success). Timing stays entirely with
`ExecutionEngine`. Capabilities: `parallel_friendly()` (sequential
today; whole source documents are the documented future unit — safe
only with deterministic destination allocation, correct progress
aggregation, and bounded memory — none of which is implemented).

### Developer tools

- `cargo run --example merge_pdf -- a.pdf b.pdf [--out merged.pdf]
  [--repeat N] [--json]` — positional paths in merge order; each file is
  parsed up front so a malformed file fails the run with its index
  before anything is constructed. Saves (default `merged.pdf`),
  re-loads the written file, prints counts and engine timing;
  `--repeat` reports min/max/mean; `--json` emits operation, inputs,
  bytes, document/page counts, and the standard report JSON.
- Merge benchmarks reuse `testing::pdf::benchmark_operation` (see
  `tests/pdf_merge.rs` smoke test); corpus validation stays manual and
  opt-in.

### Intentionally NOT handled yet

Image-to-PDF, optimization, encryption/decryption, rendering, WASM/TS,
and any parallel execution.

## 20. Lesson 9 (revised) — Developer Console on the REAL local engine

### Corrected purpose

The Developer Console (`frontend/`) is a web interface to the REAL local
Rust engine: it executes the same real operations from a browser that the
CLI/examples run, and shows real structured results, progress, timing,
errors, cancellation, and outputs. It is NOT a simulated browser
implementation of the engine (the original Lesson 9 simulator has been
demoted to a unit-test mock — see below).

```text
                    Developer Console
                         React UI
                            │
                            ▼
                     EngineAdapter (unchanged contract)
                            │
                            ▼
                 LocalDevEngineAdapter
                   (browser, `frontend/`)
                            │  localhost HTTP, protocol v1
                            │  (JSON control + raw PDF bytes, no base64)
                            ▼
                 Local Development Bridge
              (`examples/dev_bridge.rs`, dev-only)
                            │  direct library calls
                            │  (ExecutionEngine + typed Input/Options)
                            ▼
                    Real Rust Engine
                            │
                            ▼
                          lopdf
```

Later, the production browser app reuses the same `EngineAdapter`
contract with a different implementation (`WasmWorkerEngineAdapter` →
Web Worker → Rust/WASM). The console and the production UI therefore
share one engine contract with two execution paths.

### Why a localhost bridge (and why HTTP)

Evaluated options: the engine is a synchronous in-process library, so the
browser needs a local process to call into. A minimal localhost HTTP
server was chosen because browsers speak HTTP natively (`fetch`), binary
upload/download maps cleanly onto request/response bodies (no base64, no
chunking protocol to invent), and polling an events endpoint is more
than responsive enough for a developer tool — no WebSocket machinery, no
extra crates. The HTTP layer is ~100 lines of std-only code; JSON comes
from `serde_json` (a dev-dependency — see §11 amendment). No auth, no
database, no cloud, no Docker: it binds `127.0.0.1` only and holds
uploads/outputs/jobs in memory for the session. It is local process
communication, not a remote service, so the application remains 100%
local/offline.

### The bridge calls the library, never the CLI

Like the CLI/examples, the bridge is a thin consumer of the library: it
builds typed `*Input`/`*Options` values from the request, runs
`ExecutionEngine::execute_with_cancellation` on a worker thread per job
with capturing progress/event sinks and a `CancellationSource`, then
serializes the typed outcome. No process spawning, no `cargo run` in the
request path, and — critically — no scraping of human-readable CLI
output. The CLI and the bridge are sibling consumers of the same engine
behavior; the CLI is untouched and keeps working exactly as before
(verified: `inspect_pdf` still runs against the corpus).

### Protocol v1 (typed both sides)

`frontend/src/engine/devProtocol.ts` mirrors the bridge JSON exactly;
`protocol_version: 1` rides every message (explicit version, no
negotiation). Endpoints:

```text
GET  /v1/health                    status + engine name
POST /v1/documents                raw PDF bytes → {document_id, byte_length}
POST /v1/jobs                     {operation, inputs:[{document_id}], options}
                                  → 202 {job_id} (bridge routing id)
GET  /v1/jobs/{id}                terminal result or running state
GET  /v1/jobs/{id}/events?cursor=n  incremental {events, next_cursor, state}
POST /v1/jobs/{id}/cancel         cooperative cancel → CANCELLED, not FAILED
GET  /v1/outputs/{id}             raw PDF bytes (download / re-inspect)
```

Identity: bridge ids (`bridge-N`, `doc-N`, `out-N`) route
submit/poll/cancel; the REAL engine id (`job-N`, captured from the first
sink emission) travels in events and the result as `engine_job_id` and is
what the UI displays. Summaries are serialized from the typed outputs
(`PdfInspection`, counts, split parts, merge counts); output documents go
through `save_to_bytes` with page counts read off the real document.
Timestamps are wall-clock millis, durations are the engine's monotonic
millis — the bridge never invents timing. Errors are the real
`EngineError` (`code`/`message`/`details`); transport problems (bad JSON,
unknown ids) are 4xx with the same code strings, never prose.

### Lifecycle, progress, timing, errors — all real

- **Progress:** the capturing sink forwards actual `ProgressEvent`s
  (`phase/completed/total/message`); the UI polls and renders the real
  fractions (verified: 2,588 progress events streamed for a 2,585-page
  file). No fake timers anywhere.
- **Timing:** `duration_ms` is captured from `OperationResult::duration()`
  *before* `into_outcome()` consumes it — including on failure and
  cancellation paths (only pre-execution failures honestly report zero).
  The UI still shows client-elapsed separately for diagnostics.
- **Errors:** e.g. page `999999` returns the genuine `PAGE_OUT_OF_RANGE`
  with the engine's message and details. The existing full structured
  error view is reused unchanged.
- **Cancellation:** `POST …/cancel` flips the job's `CancellationSource`;
  the engine observes it at its normal checkpoints and the bridge seals
  `CANCELLED` (verified mid-flight on 20 MB and 145 MB files, plus a
  dedicated integration test).
- **Binary I/O:** real file bytes in, real generated PDFs out. Uploads are
  cached per buffer so benchmark repeats upload once; outputs download
  via object URL and re-inspect through the engine (extract → inspect
  chaining verified end to end). Binary stays in `binaryStore.ts`, outside
  React/Zustand — unchanged. Data-copy posture is documented in the
  bridge header: socket→store (1), store→op-input clone per execution
  (2), one `save_to_bytes` per output. No temp files.

### Adapters: real vs mock (never confused)

```text
EngineAdapter
  ├── LocalDevEngineAdapter  → real Rust engine (normal development)
  └── MockEngineAdapter      → deterministic protocol mock (unit tests only)
```

The former `LocalEngineAdapter` simulator is now `MockEngineAdapter`
(same faithful protocol behavior, same validation rules, `kind: 'mock'`,
`simulated: true`) and exists ONLY so `npm test` runs offline with zero
infrastructure. The store defaults to the dev adapter (bridge origin
overridable via `VITE_DEV_BRIDGE_URL`); unit tests install the mock
through an explicit `__setEngine` seam. The UI header shows a green
`● REAL LOCAL ENGINE` banner in normal use and an amber mock banner only
when the mock is active. One jsdom lesson is recorded in the adapter:
binary uploads must pass the `Uint8Array` view directly as the fetch
body — jsdom's `Blob` mangles bytes (caught by the integration test).

### Developer commands

```text
Terminal 1:  cargo run --example dev_bridge [--port 7831]
Terminal 2:  cd frontend && npm run dev        # → http://localhost:5173
```

(Fifteen-second readiness polling and ephemeral ports keep the automated
tests hermetic; see `tests/dev_bridge.rs`.)

### Test evidence (all actually run)

- Rust: `cargo fmt --check`, `cargo clippy --all-targets --all-features
  -- -D warnings`, `cargo test` — **276 passed** (270 pre-existing + 6
  new `tests/dev_bridge.rs`: inspect, extract+reinspect chaining,
  split/reorder/delete/rotate/merge with rotation-order proof,
  `PAGE_OUT_OF_RANGE`, mid-flight cancellation on a 3,000-page synthetic,
  repeated-run timing).
- Frontend: `npm test` **42 passed offline** (mock) + **4 integration
  passed live** (`FOLIO_BRIDGE_URL=…`: real inspect/extract/failure/
  unreachable-bridge); `typecheck`, `eslint`, `prettier --check`, `vite
  build` all green.
- Manual (§23/§34): real corpus PDFs through the bridge — 20.3 MB /
  72 pages (inspect 227.7 ms engine, 75 progress events; mid-flight
  cancel → CANCELLED; 3-run benchmark min 177 / mean 202 / max 223 ms)
  and 145.5 MB / 2,585 pages (inspect 27.8 s engine, 2,588 progress
  events; mid-flight cancel → CANCELLED; benchmark min 2565 / mean 2762 /
  max 2959 ms). Corpus hashes verified unchanged; no large files
  committed.
- Benchmark panel and history now record real engine durations; the Rust
  corpus/benchmark tooling remains the authoritative infrastructure (§13).

### Known limitations (explicit)

- Bridge state is in-memory per session (uploads/outputs/jobs); restart
  to clear. No persistence - by design for a dev tool.
- One execution clones input bytes out of the store (repeat runs of a
  500 MB file re-copy in RAM; localhost-fast, documented, not optimized).
- Event polling is 150 ms; sub-millisecond jobs may complete between
  polls (the terminal result is still complete - only liveness granularity
  is affected).
- The mock's deterministic page-count mapping remains synthetic; it is
  clearly labeled and never used outside unit tests.
- No WASM in this lesson: `WasmWorkerEngineAdapter` is still future work
  (the `getrandom`/`wasm_js` blocker from Lesson 9 still applies).

## 21. Lesson 10 — Production Browser Runtime (Rust/WASM + Web Worker)

### What changed and why

The Lesson 9 localhost bridge proved the browser can consume the real
engine protocol, but a localhost server must never be the application
runtime. Lesson 10 replaces it with the final architecture: the same
Rust engine compiled to WASM, executed in a dedicated Web Worker, driven
by the Developer Console through the unchanged `EngineAdapter` contract.

```text
                         Rust Engine
                              │
                ┌─────────────┴─────────────┐
                │                           │
               CLI                         WASM (`wasm/` crate)
                │                           │
            Terminal                   Web Worker (`engine.worker.ts`)
                                            │
                                            ▼
                                     WasmWorkerEngineAdapter
                                            │
                                            ▼
                                     React Developer Console
```

> The production browser runtime does not depend on the CLI or a
> localhost server. No `cargo run`, no HTTP bridge, no backend, no
> network — the engine lives inside the page.

### The two WASM blockers and their exact fixes

1. **`getrandom` (via lopdf's `rand`).** Verified with
   `cargo tree -i getrandom --target wasm32-unknown-unknown`:
   `getrandom 0.4.3 ← rand 0.10.2 ← lopdf 0.45`, whose default backend
   does not exist on `wasm32-unknown-unknown`. Fix: enable lopdf's own
   `wasm_js = ["getrandom/wasm_js"]` feature — but ONLY for the WASM
   target (`[target.'cfg(target_arch="wasm32")'.dependencies]` in
   `Cargo.toml`), so native builds keep the exact previous feature set.
2. **`std::time` panics on `wasm32-unknown-unknown`.** Verified in the
   toolchain sources (`sys/pal/wasm → unsupported/time.rs`):
   `SystemTime::now()` and `Instant::now()` panic with "time not
   implemented on this platform" — and the engine calls both on every
   execution (timestamps + authoritative durations). Fix: one small
   platform module, `core::clock::wall_now()` (native `SystemTime::now`;
   WASM `UNIX_EPOCH + Date.now()` via `js-sys`, panic-free `Duration`
   math), plus a dual-mode `observability::timing::Timer` (native
   `Instant`; WASM `performance.now()` deltas read via `Reflect` so the
   same code runs on `window` and in workers). Call sites changed:
   `error.rs` / `event.rs` / `progress.rs` / `testing::pdf` timestamps →
   `wall_now()`; `scheduler.rs` builds `Timer::start()`/`stop()` instead
   of raw `Instant`. Native behavior is bit-identical (276 tests green,
   unchanged); the only new dependency is target-gated `js-sys`.

### The thin glue crate (`wasm/`)

An independent crate (`folio-wasm`, own manifest/lockfile so root
`cargo test` is unaffected) with exactly five dependencies, each
justified: `folio-engine` (the real engine, by path), `wasm-bindgen`
+ `js-sys` (minimal JS bindings), `serde`/`serde_json` (control-plane
JSON; binary always crosses as `Uint8Array`), `console_error_panic_hook`
(readable panics in the dev console). It exposes one class,
`WasmEngine`, constructed once per worker:

```text
execute(operation, names[], blobs[], options_json, emit) -> { result_json, outputs[] }
```

Translation only — zero PDF logic: JS values become the engine's typed
`Input`/`Options`, `ExecutionEngine::execute_with_cancellation` runs
with callback-backed progress/event sinks (streaming REAL engine
events as JSON strings), and the typed outcome becomes the result
envelope (same shapes as Lesson 9: state/timing/summary/error) plus
output PDFs serialized via `save_to_bytes` into fresh `Uint8Array`s.
Engine errors are encoded INSIDE the envelope; the function throws
only for glue-level misuse. Durations are captured from
`OperationResult` before `into_outcome()` on every path. Built with
`wasm-pack build --target web --out-dir pkg` (`npm run build:wasm`
from `frontend/`); output is 18 KB glue + ~1 MB `.wasm`.

### Worker, protocol, adapter

- **Worker** (`frontend/src/engine/engine.worker.ts`): eagerly
  instantiates the WASM module + `WasmEngine` at boot, posts `ready`,
  then serves `execute` messages sequentially forever (synchronous
  execution blocking the worker is by design — the UI thread never
  blocks). Transferred `ArrayBuffer`s are wrapped as views for the glue
  (which copies them into linear memory); output views own fresh JS
  buffers (the glue copies out), so their `.buffer`s transfer back
  safely. No base64 anywhere.
- **Protocol** (`workerProtocol.ts`, v1): `execute` (inputs transferred)
  in; `ready | event | result | fatal` out. Summary shapes are shared
  with `engineResult.ts` (refactored out of the bridge code, not
  duplicated).
- **Adapter** (`WasmWorkerEngineAdapter`, `kind: 'wasm-worker'`): owns
  the worker, lazy-creates it, routes by client job id (`wasm-N`),
  replays + streams events, registers transferred outputs in the binary
  store (never React/Zustand state), seals `EngineExecution`s. It is now
  the store default; `MockEngineAdapter` stays for offline unit tests.
- **Identity:** `jobId` is the stable unique client handle (`wasm-N`,
  used for all keys); `engineJobId` is the real engine id (`job-N`,
  display-only). The split is required, not cosmetic: terminating a
  worker restarts the engine's process-unique counter, so engine ids may
  repeat across generations (this exact bug produced duplicate React
  keys before the split).

### Cancellation (documented fallback, per design)

Cooperative in-engine cancellation is IMPOSSIBLE on the worker thread:
a synchronous WASM `execute` cannot process another message until it
returns, so no JS flag can be observed mid-run. `cancel()` therefore
terminates the worker, lazily recreates it, and seals `CANCELLED` with
the real code. Engine duration for a terminated run is genuinely
unavailable and reported as 0 with an explicit event saying so — never
fabricated. (SharedArrayBuffer + Atomics could enable cooperative
cancel later, at the cost of COOP/COEP deployment constraints —
deliberately deferred.)

### Memory-copy posture (honest, not zero-copy)

`File → ArrayBuffer` (1) → per-execute `.slice()` copy whose buffer is
TRANSFERRED main→worker (move) → glue `to_vec()` into WASM linear
memory (copy) → op-owned `Vec` (move) → lopdf structures → output
`save_to_bytes` (new `Vec`) → `Uint8Array::from` copy out to JS (copy)
→ transfer worker→main (move) → binary-store reference (no copy).
Roughly four full-size copies plus parse structures; a 500 MB file
needs on the order of 2 GB peak. No arbitrary size limits are imposed.

### Verification (all actually run)

- Native: `cargo fmt --check`, `cargo clippy --all-targets
  --all-features -- -D warnings`, `cargo test` **276 green**;
  `cargo build --target wasm32-unknown-unknown` and wasm-target clippy
  clean; CLI (`inspect_pdf`, `corpus_inspect`) independent and working.
- Frontend: `typecheck`, `eslint`, `prettier --check`, `npm test`
  **52 green offline** (42 existing + 10 adapter tests over a scripted
  fake worker: ready/execute/progress/result/failure/fatal/cancel/
  recovery/malformed/unknown-job/transfer); `vite build` emits the
  worker bundle + hashed `.wasm` asset.
- Real browser (headless Chrome over CDP, DEV hook, NO bridge running):
  **14/14** — all 7 ops (incl. rotation values `[90,90,0]` proven via
  detailed re-inspect, merge counts, reorder), extract→inspect chaining,
  `PAGE_OUT_OF_RANGE`, mid-flight `CANCELLED`, 3-run benchmark on real
  engine times, 2,000-page detailed inspect (645 ms engine, 2,003
  progress events streamed), zero console/page errors.
- Baseline (same 1.2 MB / 9-page bytes both sides): native release
  detailed-inspect mean **2.1 ms** vs WASM-in-Chrome **~2–4 ms** — same
  order of magnitude (debug-native was 40 ms; profiles must match to
  compare honestly).
- Known UI limitation found by testing: the event log renders unbounded
  rows, so multi-thousand-event runs jank the main thread (2,000 pages:
  0.6 s engine vs ~65 s wall) — fixed in Lesson 10.1 by bounded
  rendering (latest 100 rows + opt-in full view; full stream retained in
  state), bringing the same run to ~5 s wall with exactly 100 DOM rows.

### Removed (Lesson 9 bridge retirement)

`examples/dev_bridge.rs`, `tests/dev_bridge.rs`,
`frontend/src/engine/{LocalDevEngineAdapter.ts,devProtocol.ts,devBridge.integration.test.ts}`
are deleted; root `serde`/`serde_json` dev-deps removed with them.
Reusable envelope/translation code was refactored into
`engineResult.ts`, not duplicated. `FOLIO_BRIDGE_URL` / `localhost:7831`
no longer exist anywhere in the normal path. The dev server needs
`server.fs.allow: ['..']` solely so the worker can load the
wasm-pack output (`../wasm/pkg`, rebuilt via `npm run build:wasm`);
production builds inline the asset into `dist/`.

## 22. Lesson 11 — `pdf.images_to_pdf` (Images → PDF)

### Purpose

Build one PDF from one or more images. `ImagesToPdfOperation`
(`"pdf.images_to_pdf"`) takes `ImagesToPdfInput { images:
Vec<ImageInput { name, bytes }>, name }` plus `ImagesToPdfOptions {
page_size: PageSizePolicy, background_rgb: [u8; 3] }` and returns
`ImagesToPdfOutput { document, page_count, image_count }` — an ordinary
engine-side document: inspectable, serializable, reloadable, usable by
later operations. Inputs are never mutated, sorted, or deduplicated.

### Why `image` + `kamadak-exif` (dependency choice)

- `image 0.25` (`default-features = false`, `jpeg` + `png` only):
  mature pure-Rust decoders (JPEG via `zune-jpeg`, PNG via `png` +
  `miniz_oxide`), no filesystem/OS/process access, no rayon threading.
  Only the two required formats are compiled in; anything else fails as
  `UNSUPPORTED_FORMAT` rather than pulling in extra codecs. Verified
  `cargo check` + `cargo clippy` clean on `wasm32-unknown-unknown`
  (14 new crates, WASM bundle 1.0 MB → 1.57 MB).
- `kamadak-exif 0.6` (lib name `exif`): pure-Rust, std-only EXIF
  orientation + resolution reader, no filesystem/network — safe on WASM.
  Used read-only on borrowed bytes; unparseable EXIF is ignored (never a
  failure).
- No new error-code variant: per-image failures reuse the stable codes
  (`INVALID_INPUT` for empty/oversized lists and dimensions,
  `UNSUPPORTED_FORMAT` for unknown magic, `INVALID_DOCUMENT` for corrupt
  decodes) with `image_index` (1-based) + `name` in both message and
  `details`. No wire-contract change was needed.

### Contract

- **Formats:** JPEG/JPG and PNG (whatever the enabled `image` decoders
  accept). Other bytes → `UNSUPPORTED_FORMAT`.
- **Pages:** 1 image → 1 page, N images → N pages, input order preserved
  exactly (verified down to first-pixel payload order in tests).
- **Layout:** aspect ratio is never distorted. Placement uses one uniform
  scale plus centering. `PageSizePolicy::FitImage` (default) sizes each
  page to the image's natural size (`px × 72 / dpi`, rounded to 0.01 pt)
  with the image filling the page; `PageSizePolicy::StandardPage` uses
  fixed A4 (595.28 × 841.89 pt) with the image scaled to fit (`contain`)
  and centered. No arbitrary page-size collection was added.
- **DPI:** detected EXIF (`XResolution` + `ResolutionUnit`) → JFIF APP0
  density (JPEG) / `pHYs` pixels-per-meter (PNG) → fallback `150`
  (`DEFAULT_DPI`). Values outside 1–1200 are treated as absent. DPI sets
  the natural size, hence `FitImage` page sizes and `StandardPage` drawn
  sizes. Generated fixtures (no DPI) therefore render at 150 DPI
  (150 px = 72 pt); this is explicit policy, not a silent `1 px = 1 pt`
  assumption.
- **EXIF orientation:** values 1–8 read from the original bytes and
  applied to decoded pixels (5–8 swap dimensions). Input bytes are never
  modified. Verified with a hand-crafted minimal APP1 orientation segment
  (orientation 6 turns 12×8 landscape into 8×12 portrait).
- **JPEG handling:** decode → raw RGB embedding (no DCT passthrough, no
  JPEG re-encode, no quality knob). Correctness first; passthrough is a
  documented future size optimization, not this lesson.
- **Transparency:** every image goes through RGBA → RGB compositing
  against `background_rgb` (default white `FFFFFF`, configurable per
  options/CLI/UI). Transparent pixels become the background — never
  silent black. Grayscale expands to RGB identically.
- **Dimensions/safety:** header probe (`ImageReader::with_guessed_format`
  → `into_dimensions`) validates before full decode; zero dimensions,
  dimensions above 30,000 px, and pixel counts above 100 MP fail as
  `INVALID_INPUT`. All size math uses checked arithmetic; untrusted input
  can never panic the operation.
- **Atomicity:** the whole list validates up front and every image
  decodes into local state before any PDF object is committed; any
  failure returns `Err` with no partial PDF.
- **PDF encoding:** fresh `1.4` document, one raw RGB `DeviceRGB`/`8`
  `Image` XObject per page (no `/Filter`, no re-compression — lossless
  and tuning-free), content `q w 0 0 h x y cm /Im1 Do Q`, flat
  `Catalog → Pages` tree, fixed `Producer` only (no timestamps, so output
  is byte-deterministic: identical inputs serialize identically on
  native and WASM — verified 331,956 bytes both sides).

### Progress / cancellation / timing

Progress reuses Lesson 0 events: validating (5%) → preparing (10%) →
per-image processing across 10–90% (`"image i of N"`) → writing (95%) →
finalizing (100%, only after success); monotonic, never premature.
Cancellation is checked before processing, between images, and before
finalization; a cancelled run returns structured `CANCELLED` with no
partial output. Timing stays entirely with `ExecutionEngine`.
Capabilities: `parallel_friendly()` (sequential today; per-image decode
is the documented future unit — no Rayon, no thread pool).

### Transports (same engine, three consumers)

- **Native CLI:** `cargo run --example images_to_pdf -- a.jpg b.png
  [--out images.pdf] [--page-size fit|standard] [--background RRGGBB]
  [--repeat N] [--json]` — reads files, runs the engine, writes +
  re-loads the output, prints engine timing.
- **WASM glue (`wasm/src/lib.rs`):** new `"pdf.images_to_pdf"` dispatch
  branch (translation only): all blobs become `ImageInput`s in order,
  `{page_size, background_rgb?}` become the typed options (unknown
  `page_size` → `INVALID_OPTIONS`), output serialized to `images.pdf`
  with a `{page_count, image_count}` summary. Multi-input gating now
  covers merge + images_to_pdf.
- **Developer Console:** `pdf.images_to_pdf` registry entry
  (`inputs: 'multi'`, `images-to-pdf` form: page-size radios + hex
  background), image file picker (`.jpg/.jpeg/.png`, multi, "order =
  page order"), typed request/adapter/mock/result plumbing. The frontend
  only reads bytes and forwards them — no canvas/PDF-library generation,
  no image encoding, no PDF object logic.

### Verification (all actually run)

- Rust: `cargo fmt --check`, `cargo clippy --all-targets
  --all-features -- -D warnings` (native + wasm32), `cargo test
  --all-targets` **310 green** (204 lib incl. 29 new unit tests +
  11-test `tests/pdf_images_to_pdf.rs` engine-path integration incl.
  benchmark smoke; all pre-existing suites unchanged).
- Native CLI: 6-file mixed set (7,821 input bytes) → 6 pages, release
  mean **1.6 ms** (min 1.44 / max 2.02 over 5 runs); output re-inspects
  to 6 pages; `UNSUPPORTED_FORMAT` with `image_index=1` on text input.
- Frontend: `npm test` **65 green** (52 pre-existing + 13 new:
  registry, adapter options/summary, mock success/failure, 3 flow
  tests); `typecheck`, `eslint`, `prettier --check`, `vite build` green.
- Real browser (local headless Chrome, dev server, NO mocks): **18/19**
  — JPEG→PDF, PNG→PDF, 5 mixed images→5 pages with monotonic progress
  to 1 and real phases, output reload via real inspect (portrait stays
  portrait, landscape stays landscape, fit math 120 px → 57.6 pt at
  150 DPI), A4 policy geometry, structured `UNSUPPORTED_FORMAT` with
  attribution, mid-flight `CANCELLED` on a 24-image run, 5-run benchmark.
  The single non-pass is a pre-existing `/favicon.ico` 404 (the app
  ships no favicon; unrelated to this lesson).
- Native vs WASM (same 6 files): native release mean **1.6 ms** vs
  WASM-in-Chrome **[12.3, 2.6, 2.9, 2.3, 2.4] ms** (first run includes
  WASM warmup; steady state ~2–3 ms, same order of magnitude), page
  counts match (6), output byte counts match exactly (331,956 both
  sides), no WASM-only failure.

### Known limitations (explicit)

- JPEGs embed as raw RGB (no DCT passthrough): correct but larger than
  the source JPEGs (7.8 KB in → 332 KB out for the 6-file set). A
  compatible-passthrough optimization is future work, not this lesson.
- Images embed uncompressed (no `/Filter`): no compression tuning was
  added, per the lesson's no-premature-compression rule.
- `StandardPage` always scales to fit (`contain`, up or down) with zero
  margin; no margin control, no page-size collection, no per-image
  policies.
- DPI sources are EXIF/JFIF/`pHYs` only; embedded ICC profiles and
  color management are out of scope (all images land in `DeviceRGB`).
- No JPEG quality, downsampling, WebP conversion, dedup, or
  optimization passes — explicitly deferred.

## 23. Lesson 12 — PDF rendering foundation (PDF.js)

### Two systems, one app

Folio has two intentionally independent PDF paths sharing only the
binary store's bytes (never code):

```text
Manipulation:  bytes -> TS Engine API -> Web Worker -> Rust/WASM -> lopdf
Rendering:     bytes -> Rendering API -> PDF.js -> PDF.js worker -> canvas
```

Rendering never calls the Rust engine (no `ExecutionEngine`, no
`OperationId`, no `engine_duration_ms`), and manipulation never calls
PDF.js. The frozen Engine/API contract (Lesson 12A) is untouched:
no `ErrorCode` was added, and no file under `src/engine/`,
`src/stores/`, `wasm/`, or `src/types/engine.ts` was modified except
`App.tsx` (RenderPanel wiring).

### Dependency: pdfjs-dist 6.3.289

One rendering library, direct (no react-pdf/wrappers). `pdfjs-dist`
ships its own types (`types/src/pdf.d.ts`), consumed as
`import * as pdfjsLib from 'pdfjs-dist'`.

### Worker strategy (local, offline)

`src/rendering/pdfjs.ts` (sole PDF.js global) sets
`GlobalWorkerOptions.workerSrc` to a Vite `?url` import of
`pdfjs-dist/build/pdf.worker.min.mjs`. Vite emits it as a same-origin
asset (`dist/assets/pdf.worker.min-*.mjs`, 1.27 MB) in dev and prod —
no CDN, no remote worker. Verified: E2E `workerSrc` is same-origin,
zero non-local requests, zero failed requests during a full session,
and the bundle contains no remote URLs. The PDF.js worker is separate
from `engine.worker.ts` (Rust/WASM); the two workloads never share a
worker.

### Asset strategy (minimal)

`cMapUrl` / `standardFontDataUrl` are deliberately unset, so PDF.js
performs no font/CMap network fetches. Standard-14 fonts resolve via
system fonts (offline-safe); documents needing Adobe CMaps (typically
CJK CID fonts) render without those glyphs until a future lesson
bundles the CMaps locally. Console verbosity is errors-only.

### Rendering API (`src/rendering/`)

- `types.ts` — public contract: `RenderDocumentInput { data, name? }`,
  `RenderingDocument { id, pageCount, name, metadata }`,
  `RenderPageOptions { scale?, rotation? }`,
  `RenderedPage { documentId, pageNumber, scale, rotation, width, height }`,
  `RenderTiming { startedAt, completedAt, durationMs }` (browser
  `performance.now()`, never engine timing), `CancellableRender<T>
  { promise, cancel }`.
- `PdfRenderEngine.ts` — interface: `loadDocument` / `getDocument` /
  `renderPage` / `closeDocument`. Components program against this, never
  `pdfjsLib.getDocument`.
- `PdfJsRenderEngine.ts` — the only implementation. Owns all
  `PDFDocumentProxy` handles in a private map (`renderdoc-N`); pages use
  Folio 1-based numbering (PDF.js `getPage` is natively 1-based).
  `page.cleanup()` after every render keeps documents reusable without
  reopening. Dimensions are deterministic `Math.floor` viewport pixels.
- `errors.ts` — the rendering-local error model (see below).

### Input and memory model

`Uint8Array | ArrayBuffer` in, caller-owned canvas out — no base64, no
JSON, no pixel copies, no Zustand bytes (the test panel reads the
binary store at action time). Two measured copies are inherent to this
PDF.js version and documented, not optimized away: (1) the engine
copies input once because PDF.js **detaches** the handed buffer
(verified: caller bytes arrive with length 0 otherwise); the copy keeps
store bytes valid (verified intact post-load, incl. 514 MB). (2) PDF.js
clones data into its worker. JS heap after rendering one page of the
490 MB corpus file measured ~497 MB — the Lesson 14 starting point.

### Error model (separate, by freeze)

Rendering errors are the local `RenderError { code, message, details?,
documentId?, pageNumber? }` (`src/rendering/errors.ts`), NOT Engine
`ErrorCode`. Codes: `RENDER_INVALID_INPUT`, `RENDER_DOCUMENT_FAILED`,
`RENDER_INVALID_PAGE` (validated before reaching PDF.js),
`RENDER_PAGE_FAILED`, `RENDER_CANCELLED`, `RENDER_CLOSED`,
`RENDER_INTERNAL`. Cancellation maps to `RENDER_CANCELLED` via an
explicit flag (never misclassified as failure), independent of PDF.js
exception naming.

### Cancellation and lifecycle

`renderPage`/`loadDocument` return `{ promise, cancel }`: cancel calls
PDF.js `task.cancel()` / `loadingTask.destroy()` and the flag maps the
rejection to `RENDER_CANCELLED`. Each handle cancels only its own call
(audit fix during E2E: an early build cancelled all sibling renders).
`closeDocument(id)` is idempotent, cancels in-flight renders of that
document first, then destroys via `PDFDocumentLoadingTask.destroy()`
— v6 removed `PDFDocumentProxy.destroy` (verified at runtime and in
types). Repeated `render 1,2,1`, interleaved documents, and
load→close→reload leave no stale handles (all covered in E2E).

### Verification (all actually run)

- `npm test` **79 green** (65 pre-existing + 14 new pure-logic
  rendering unit tests; jsdom-safe, no PDF.js runtime).
- `typecheck`, `eslint`, `prettier --check`, `vite build` green;
  pdf.js ships as a lazy chunk (`PdfJsRenderEngine-*.js`, 442 KB),
  loaded only on first render.
- Real headless Chrome (local, dev server, real PDF.js worker):
  **14/14 E2E** — load (2 pp), page-1 render 595×841 non-blank,
  page-2 reuse, invalid pages → `RENDER_INVALID_PAGE`, junk bytes →
  `RENDER_DOCUMENT_FAILED`, 1.0×/2.0× exact doubling, 90°-rotated page
  renders 841×595 landscape, cancel → `RENDER_CANCELLED` with sibling
  succeeding, load→close→reload + closed-render → `RENDER_CLOSED`,
  39-page doc 1→2→1 rerender, zero non-local/failed requests.
- RenderPanel UI smoke test through real DOM: file → Render page 2 @
  1.5× → `892×1262px` (floored viewport math confirmed).
- Corpus: 11 KB/2 pp (load 412 ms, render 64 ms @1×), 1 MB/39 pp
  (load 233 ms), rotated fixture (rotation 90 respected).
- Large-file sanity (`merged.pdf`, 514 MB, 2585 pp): fetch ~2 s, load
  860 ms, page count 2585, page 3 @1× renders 612×792 non-blank in
  87 ms, input bytes intact, close 1.6 ms, no stale state.

### Known limitations (explicit)

- No thumbnail strip, viewer, navigation, zoom UI, search, text
  selection, annotations — minimal RenderPanel only.
- No render bitmap cache (each render re-rasterizes); no
  OffscreenCanvas/ImageBitmap path yet (standard canvas baseline).
- No bundled CMaps: CJK CID-font documents render without those glyphs.
- Per-load full-size defensive copy (PDF.js detaches input buffers).
- Rotation override is absolute (intrinsic `/Rotate` respected by
  default); no combined relative-rotate API.

## 24. Lesson 13 — PDF thumbnail engine (bounded, on top of Lesson 12)

### What it is (and is not)

A reusable thumbnail-generation subsystem on top of the Lesson 12
rendering foundation — not a second renderer, viewer, cache, or
large-file optimizer. One rendering path only:

```text
Thumbnail Engine → PdfRenderEngine → PDF.js → small render → thumbnail
```

The thumbnail layer depends on `PdfRenderEngine`, never on PDF.js
directly (no `pdfjsLib.getDocument`, no proxy objects outside
`PdfJsRenderEngine`). The frozen Rust/WASM manipulation Engine/API is
untouched: no `ErrorCode` added, no file under `src/engine/`,
`src/stores/`, `wasm/`, or `src/types/engine.ts` modified except
`App.tsx` (ThumbnailPanel wiring) — same freeze discipline as
Lesson 12.

### The one rendering-abstraction extension (minimal, justified)

`renderPage()` alone cannot size a thumbnail efficiently: without
source dimensions the engine would have to render huge and shrink
(the exact anti-pattern in the brief). So `PdfRenderEngine` gains one
method, and `types.ts` gains its return type:

- `PageDimensions { documentId, pageNumber, width, height, rotation }`
  — viewport at scale 1 with the effective rotation applied.
- `getPageDimensions(documentId, pageNumber, rotation?)` — validated
  (closed → `RENDER_CLOSED`, bad page → `RENDER_INVALID_PAGE`),
  rotation normalized by the existing helper (no second rotation
  implementation), `pdfPage.cleanup()` after reading so documents stay
  reusable. Cost: one extra `getPage()` per thumbnail (dims + render);
  documented, not fused — correctness first, fusion is future work.

### Thumbnail API (`src/rendering/`)

- `thumbnailTypes.ts` — `ThumbnailSize`, `ThumbnailGenerateOptions`,
  `ThumbnailBatchOptions { concurrency?, onProgress?, onThumbnail? }`,
  `ThumbnailResult { canvas (caller-owned), width/height,
  sourcePageWidth/sourcePageHeight, scale, rotation, timing }`,
  `ThumbnailProgress { completed, total, percentage }`.
- `PdfThumbnailEngine.ts` — interface: `generateThumbnail(documentId,
  page, options?)`, `generateThumbnails(documentId, pages, options?)`,
  `generateDocumentThumbnails(documentId, options?)`; all return
  `CancellableRender<T>` (`{ promise, cancel }`). Batch failure policy:
  **atomic** — first page error aborts the batch (actives cancelled,
  queued pages never start, batch rejects with the failing page
  attributed; never silent partial success).
- `DefaultPdfThumbnailEngine.ts` — the only implementation. Per page:
  `getPageDimensions` → `scale = min(targetW/srcW, targetH/srcH)` via
  pure `thumbnailGeometry.calculateThumbnailGeometry` (fit, aspect
  preserved, never stretch/crop; `floor` dims, min 1px) → single
  `renderPage` at that small scale into a fresh canvas. Background
  follows the rendering subsystem (no thumbnail-specific knob).
- `thumbnailErrors.ts` — `ThumbnailError { code, details?,
  documentId?, pageNumber?, cause? }`; codes
  `THUMBNAIL_INVALID_INPUT / INVALID_PAGE / CLOSED / RENDER_FAILED /
  CANCELLED / INTERNAL`. `toThumbnailError` maps `RENDER_CANCELLED →
  THUMBNAIL_CANCELLED`, `RENDER_INVALID_PAGE → THUMBNAIL_INVALID_PAGE`,
  `RENDER_CLOSED → THUMBNAIL_CLOSED`, else `THUMBNAIL_RENDER_FAILED`
  (cause preserved). Raw PDF.js exceptions never escape.

### Ownership and caching (explicit)

Every `ThumbnailResult.canvas` is created by the engine but owned by
the caller; the engine keeps all batch state in closures (never on
`this`, never global) and retains nothing after settling — no hidden
cache, no retained canvas list, no IndexedDB/OPFS/Zustand bytes. A
future cache sits above (`UI/cache → ThumbnailEngine →
PdfRenderEngine`) without engine changes. `ImageBitmap` path deferred
(canvas only; close semantics documented in `thumbnailTypes.ts`).

### Concurrency: default 2, max 8

Bounded worker pool: at most `concurrency` thumbnail slots active;
queued pages never start after cancel/failure (no unbounded
`Promise.all`). Default `DEFAULT_THUMBNAIL_CONCURRENCY = 2`, hard cap
`MAX_THUMBNAIL_CONCURRENCY = 8`, target edge cap
`MAX_THUMBNAIL_EDGE = 1024`. Rationale: browser/PDF.js rendering is
worker/canvas/memory-bound, not CPU-core-scalable like the Rust
workloads — measured max-active never exceeded 2 across 39-page and
2585-page runs while throughput stayed healthy (~10 ms/thumb on the
39-page doc, ~24 ms/thumb sparse on the 2585-page doc).

### Ordering, progress, cancellation

- Order preserved exactly (`[5,1,3]` → `[thumb5,thumb1,thumb3]`,
  document-wide → `1..N`); `onThumbnail` delivers in strict input page
  order via a next-emit pointer over buffered completions (bounded by
  concurrency), so consumers can paint/release incrementally.
- Progress is one update per completed thumbnail
  (`completed/total/percentage`); consumer-callback throws never fail
  the batch (observers, documented).
- Cancellation checked before starting, between phases, and at every
  schedule point; `cancel()` flips the flag, aborts active
  `renderPage` tasks, settles the batch exactly once with
  `THUMBNAIL_CANCELLED` — never success. Verified mid-batch and
  mid-document (58–60 ms to settle on the 2585-page doc).

### Developer surface and E2E transport

- `ThumbnailPanel.tsx` (wired in `App.tsx`): first testbench file,
  width/height/pages (`all` or `1,5,2`), Generate/Cancel/Close,
  progress status, timing; mounts at most 12 canvases (larger batches
  verify via counts/ordering text). Owns and releases canvases on
  Clear/Generate/unmount.
- `devHook.ts` gains `createThumbnailEngines()` for headless-Chrome E2E.
- `e2e/thumbnail.e2e.mjs` (33 checks, puppeteer-core over system
  Chrome): test bytes travel Node → page as base64 chunks over the
  DevTools protocol — zero HTTP byte transfers, so download managers
  (e.g. IDM, which hooks browser HTTP/download APIs even with its tray
  icon dismissed) cannot intercept the harness. Bytes verified by
  length; only the dev-server page load uses HTTP.

### Verification (all actually run)

- `npm test` **119 green** (79 pre-existing + 40 new: 7 geometry, 16
  error-model, 17 mock-engine ordering/concurrency/progress/
  cancellation/atomic-failure tests; jsdom-safe, no PDF.js runtime).
- `typecheck`, `eslint`, `prettier --check`, `vite build` green
  (thumbnail ships as lazy `DefaultPdfThumbnailEngine-*.js`, 4.75 KB).
- Real headless Chrome **33/33 E2E**: portrait 141×200 @0.168
  (small-scale invariant held), rotation-90 → 200×141 landscape,
  custom 100×60 → 42×59, invalid pages → `THUMBNAIL_INVALID_PAGE`,
  `[5,1,3,10]` order + page-order delivery + `1/4…4/4` progress,
  39-page doc → 39 thumbs in order (371 ms, ~9.5 ms/thumb, max-active
  2), mid-batch cancel → `THUMBNAIL_CANCELLED`, junk bytes →
  `RENDER_DOCUMENT_FAILED`, closed-doc → `THUMBNAIL_CLOSED`,
  close→reload works, large doc (490.1 MB, 2585 pp, load ~260 ms)
  sparse `[1,500,1000,1500,2000,2585]` in order (~146 ms, ~24
  ms/thumb, max-active 2), whole-doc cancel → `THUMBNAIL_CANCELLED`
  in ~60 ms with doc still usable, close ~3–6 ms, zero failed /
  non-local requests, zero console errors (pre-existing favicon 404
  excluded by rule, cross-checked via failed-request tracking).
- Lesson 12 rendering suites still green (14/14 unit + prior E2E
  contract unchanged; `getPageDimensions` is additive only).
- Rust/WASM unchanged: no `cargo` changes needed or made.

### Known limitations (explicit, vs actual bugs: none open)

- Intentional: no persistent/global cache; batch collects the
  caller-owned array (very large docs should use sparse sets +
  `onThumbnail` streaming — demonstrated, not solved); two
  `getPage()` calls per thumbnail (dims + render); canvas-only output;
  no CMap bundling (inherited); per-load defensive copy (inherited).
- Lesson 14 seams exposed: bounded scheduler, ownership docs, heap
  snapshot after large stress (~1.8–2.1 GB JS heap with the 490 MB doc
  resident — the starting measurement, not a regression), cancellable
  whole-document jobs.
- `puppeteer-core` added as a frontend devDependency (system-Chrome
  E2E driver only; never bundled — `vite build` output unchanged in
  kind).

## 25. Lesson 14 — Large-file handling (measure, own, bound)

### Objective and philosophy

Make browser-side handling of large PDFs predictable, bounded where
practical, measurable, cancellable, and explicit about ownership —
without prematurely optimizing PDF.js internals. Order of operations
throughout: correctness → measurement → ownership clarity → remove
avoidable work → bounded usage → optimize only on evidence. No
compression, encryption, viewer, or persistent cache work (future
lessons, explicitly out of scope).

### What measurement showed (before any change)

Real headless-Chrome matrix over `merged.pdf` (490.1 MB, 2585 pp),
with `gc()` before heap snapshots (`--expose-gc` harness flag):

```text
load 2585 pp:            ~236–355 ms
render one page @1x:     ~79 ms (612×792)
5 sequential renders:    ~88 ms (one reused canvas)
sparse 6 thumbs:         ~139–152 ms (~24 ms/thumb, concurrency 2)
whole-doc cancel:        ~51–64 ms → THUMBNAIL_CANCELLED
close:                   ~0.4–6 ms, getDocument → undefined everywhere
3× load→close:           236/261/244 ms loads, no stale docs
3× full load→thumb→close: thumbs ok, no stale docs
```

Heap (main-thread JS heap via `performance.memory`, gc'd readings):

```text
medium (39 pp) lifecycle:  ~14–15 MB flat across load/renders/windows/close
large after load:          ~1833 MB
large, all later stages:   ~1811–1812 MB flat across 9 stages
H cycles (load→close ×3):  1811.4 / 1811.4 / 1811.4 MB
I cycles (full ×3):        1812.2 / 1812.3 / 1812.3 MB
```

Two conclusions, stated precisely per the lesson's reporting rule:

1. **No retained application-level references were observed.**
   Repeated identical cycles show zero heap growth trend; every close
   leaves no stale document; instrumented active renders return to 0.
2. **Heap stays elevated (~1.8 GB) after close, and DevTools evidence
   cannot distinguish browser/PDF.js allocation from retained
   application references.** `performance.memory` sees only the
   main-thread JS heap — PDF.js worker memory, GPU/canvas backing
   stores, and WASM linear memory are invisible. The elevated floor is
   therefore reported as observed behavior with that caveat, not as a
   diagnosed leak and not as a fixed one.

First-render vs cached-render is visible and healthy (medium page 1:
39 ms cold → ~4 ms warm — PDF.js page caching working for the caller).

### Binary ownership (final, audited boundary by boundary)

```text
File.arrayBuffer() → ONE Uint8Array in binaryStore (putBytes)
  → manipulation: per-execute .slice() copy, buffer TRANSFERRED
    main→worker (move) → glue to_vec() into WASM linear memory (copy,
    required: WASM cannot borrow JS memory) → op Vec (move) → lopdf
    → save_to_bytes (new Vec) → Uint8Array::from copy out (required:
    cannot hand out WASM memory) → transfer worker→main (move)
    → registerBytes (store reference, no copy)
  → rendering: loadDocument .slice() defensive copy (REQUIRED: PDF.js
    detaches/neuters the input buffer — verified Lesson 12; removing
    it corrupts the store's bytes) → PDF.js clones into its worker
    (PDF.js-internal, untouchable by design)
```

Every copy above is either a transfer (move, zero-copy) or documented
unavoidable (PDF.js detach, WASM linear-memory boundary). No
avoidable copies were found; none were removed because none existed.
`copyBytes` (download path) is one explicit caller-side copy; `getBytes`
callers (Render/Thumbnail/LargeFile panels) read by reference at
action time. Binaries never enter Zustand/React state (unit-tested).

### Demonstrated problems found and fixed (only these)

1. **Unbounded `pastExecutions` map** (`stores/testbench.ts`): history
   was capped at 25 but the views map (each holding a full event array
   — ~2,588 entries for the large doc) grew forever. Now
   `pruneExecutionHistory` caps views to the same 25-window and
   releases binary-store output bytes unreachable from every retained
   view (shared outputs are reference-checked, never double-freed).
2. **Unbounded adapter `jobs` map** (`WasmWorkerEngineAdapter.ts`):
   settled records (full event arrays) were never deleted. `settle()`
   now prunes to the last 25 settled records; in-flight records are
   never touched and recent late-`subscribe` replay still works
   (unit-tested both directions).
3. **Whole-document footgun in the dev UI** (`ThumbnailPanel.tsx`):
   "all" on 2585 pages would retain ~2585 caller-owned canvases
   (~400 MB at 200×200). The panel now refuses whole-document runs
   above 100 pages with guidance toward sparse lists. Engine API
   unchanged and unlimited by design (§11 respected — this is a UI
   rail, not an engine limit).

### Lifecycles (unchanged code, now documented with evidence)

- **Rendering** (`PdfJsRenderEngine`): `getPage` → viewport → render →
  `page.cleanup()` every call; proxies never escape; `pendingRenders`
  drained on close; `closeDocument` idempotent, destroys via the
  loading task, deletes the map entry. Caller canvas stays valid.
- **Thumbnails** (`DefaultPdfThumbnailEngine`): closure-local batch
  state only; `activeCancellers` emptied in `finally`; results array
  ownership transfers on resolve; cancel/failure paths settle exactly
  once. `onThumbnail` page-order delivery lets large batches stream
  without retaining the array.
- **Cancellation**: load cancel → `RENDER_CANCELLED`, render cancel →
  `RENDER_CANCELLED`, batch cancel → `THUMBNAIL_CANCELLED`
  (~51–64 ms on the large doc), close-during-work cancels in-flight
  renders first; documents remain reusable afterward (verified: render
  after cancel succeeds).

### Large-file strategy (measured, by size)

```text
small (≤ ~25 pp):    whole-document arrays fine (UI + engine)
medium (≤ ~100 pp):  whole-document arrays fine; windows optional
large (100+ pp):     sparse requests / page windows / onThumbnail
                     streaming; never a whole-document canvas array
very large (500+ MB / 2000+ pp):
                     load once → windowed/sparse work → release each
                     window → close; cancel early rather than queue deep
```

Window primitive: pure `pageWindows(pageCount, windowSize)`
(`rendering/pageWindows.ts`, `MAX_WINDOW_SIZE = 500`) — e.g. 2585 pp
→ 6 windows (5×500 + 85), each exactly-once coverage (unit-tested).
Each window is one `generateThumbnails` call; release between windows.
No new engine API was needed — the page-list batch call *is* the seam.

### Observability added (dev-only, dependency-free)

- `rendering/memory.ts`: feature-detected `readMemorySnapshot()`
  (`supported: false` + nulls outside Chromium; never throws) and
  `formatMB()`. States explicitly that worker/GPU/WASM memory is
  invisible — heap numbers track Folio's own retained references only.
- `LargeFilePanel.tsx` (Developer Console): first testbench file →
  Load / Render page / Sparse thumbnails / Cancel / Release+close with
  file size, pages, per-action timings, active-op count,
  created-vs-released canvas counts, and heap readings. Diagnostic
  tool, not a viewer or dashboard.

### Verification (all actually run)

- Rust: `cargo test` **310 green** (204 lib + 106 integration);
  `cargo fmt --check` + `cargo clippy --all-targets --all-features
  -- -D warnings` clean; `wasm-pack build` succeeds (pkg rebuilt).
- Frontend: `npm test` **132 green** (119 pre-existing + 13 new:
  6 pageWindows, 3 memory, 1 adapter prune, 3 store prune);
  `typecheck`, `eslint`, `prettier --check`, `vite build` green.
- Real headless Chrome: **thumbnail E2E 33/33** (Lesson 13 intact)
  and **large-file E2E 23/23** (`e2e/large-files.e2e.mjs`): load-only,
  load→close, render→release, 5 sequential renders, sparse→release,
  batch cancel, 3× render cycles, 3× load→close, 3× full cycles, load
  + render cancellation, no-stale-document after every close,
  bounded concurrency (max-active 2), L12/L13 regression spot-checks,
  zero failed/non-local requests, zero console errors. Test bytes
  travel Node→page as base64 CDP chunks (zero HTTP), so download
  managers cannot intercept the harness.

### Known limitations (explicit)

- The ~1.8 GB post-large-doc heap floor is unexplained-but-bounded:
  flat across cycles, consistent with PDF.js/worker retained
  allocation plus the harness's own resident input bytes — reported,
  not claimed.
- `performance.memory` is Chromium-only; Firefox/Safari get `n/a`
  (feature-detected, production-independent).
- No persistent thumbnail cache, no viewer, no compression,
  no encryption — all deferred; the seams (page windows,
  `onThumbnail` streaming, caller-owned canvases) are in place for
  them.
- E2E drivers (`puppeteer-core`, system Chrome) are dev-only and never
  bundled.

## 26. Lesson 15 — PDF metadata (typed read/patch/write)

### What it is (and is not)

A typed metadata subsystem for reading and editing the eight standard
PDF document-information fields — not a general PDF editor, compressor,
encryptor, viewer, or XMP editor. Two new operations over the frozen
execution model (`Input + Options -> Output`, progress, cancellation,
timing, atomicity), with Rust authoritative and TypeScript a thin
typed transport:

```text
pdf.read_metadata   bytes → DocumentMetadata (typed dates) + page_count
pdf.set_metadata    bytes + MetadataPatch → new PdfDocument (unchanged
                    pages/geometry/version, patched Info only)
```

### Model (`processing/pdf/metadata/`)

- `date.rs` — `PdfDate { year, month, day, hour, minute, second,
  tz_offset_minutes }` (fixed-offset minutes, east positive; no
  timezone database — the reason the crate avoids `chrono`). `new()`
  validates ranges (`InvalidInput`, leap-year-aware days, ±23:59
  offsets). `parse_pdf_date` is total: `D:`-optional, partial
  components defaulted (month/day→1, time→0, zone→UTC), `Z`/`±HH'mm'`/
  `±HHmm` zones; anything else → `None` (malformed dates never fail a
  read). `format_pdf_date` emits canonical full form (`…Z` for UTC),
  so every written date re-parses identically (round-trip tested).
- `model.rs` — `DocumentMetadata` (8 `Option` fields, dates typed) +
  `from_raw` conversion (malformed dates → `None`); `FieldPatch<T>
  { Unchanged, Set(T), Clear }` (a plain `Option` cannot separate
  "leave unchanged" from "set empty"); `MetadataPatch` (per-field
  patch, `is_empty()` no-op rewrite, `has_sets()` Info-creation hint).
- Field mapping is semantic-only, never PDF keys in the API:
  `title→/Title, author→/Author, subject→/Subject,
  keywords→/Keywords, creator→/Creator, producer→/Producer,
  creation_date→/CreationDate, modification_date→/ModDate`.
- Custom Info keys are intentionally unsupported (no raw-dictionary
  access in the public API) — documented, not leaked.
- Distinction from inspect (deliberate): `pdf.inspect` keeps its frozen
  raw-string summary (cheap, stable); the metadata ops own the
  authoritative editable model with typed dates.

### Write path and Info ownership (`core::PdfDocument`)

`apply_metadata_patch` mutates **only patched keys on the live Info
dictionary** — unpatched entries (including malformed values and custom
keys), pages, streams, outlines all untouched, so preservation holds by
construction rather than by copying (no `copy_pages`, which would drop
non-page structures). Missing `/Info` is created (fresh indirect dict)
only when the patch sets something; clear-only/empty patches on
Info-less documents are no-ops. Indirect Info mutates through its
reference; direct (inline-trailer) dicts mutate in place; non-dict
`/Info` fails `InvalidDocument`. `Clear` removes the key (never an
empty string); `Set("")` is rejected as `InvalidInput` (clearing is
what `Clear` is for). Values encode as UTF-16BE hex with BOM —
uniform for ASCII and non-ASCII, deterministic across runs.

### Unicode and XMP findings (measured, not assumed)

- Strings decode BOM→UTF-16, else UTF-8, else Latin-1 fallback
  (covers PDFDocEncoding's latin range, incl. the real-corpus `®`
  byte). Verified round-trip: accented Latin, Telugu, Hindi, CJK,
  emoji (surrogate pairs), `®` — all survive read→patch→write→reopen.
- XMP: 63/201 corpus files carry catalog `/Metadata` streams.
  **Preserved byte-identical** across Info edits (unit test asserts
  stream-content equality; real-corpus check confirms: 3217-byte XMP
  payload identical, only stream-framing EOL differs —
  semantically irrelevant). XMP is **not edited, not synchronized**
  with Info (divergence possible, documented); no XMP subsystem was
  built — no demonstrated requirement.
- Dates: real corpus carries `D:…+05'30'` zones and partial forms;
  malformed dates normalize to `None` without failing reads.

### Operations, errors, progress, cancellation

- `pdf.read_metadata`: validating 5 → loading 15 → reading 50 →
  complete 100. `pdf.set_metadata`: validating 5 (patch values first,
  so bad values fail before parsing) → loading 15 → applying 50 →
  finalizing 90 → complete 100. No per-page loops, no fake detail.
- Cancellation checked at every stage boundary; cancelled runs return
  `CANCELLED` with no output; inputs never mutated.
- Atomicity: full validation before mutation, in-memory mutation only,
  `Err` carries no document. Error codes reused, none added:
  `InvalidInput` (empty bytes/values), `InvalidOptions` (wire shape),
  `InvalidDocument` (bad PDF/non-dict Info), `UnsupportedFormat`
  (locked), `ProcessingFailed` (serialization), `Cancelled`.
- Preservation verified: page count, per-page dimensions, rotations,
  PDF version unchanged; round-trip (read→patch→write→reopen→read)
  is the primary guarantee (set/clear/unchanged/Unicode/dates).

### Browser path (thin, Rust-authoritative)

WASM glue adds two translation-only dispatch branches (no new worker
or protocol): read summary carries structured dates
`{year,…,tz_offset_minutes}`; set decodes the patch wire shape
(absent=unchanged, `{op:clear|set,value}`; structural→
`INVALID_OPTIONS`, semantic→`INVALID_INPUT`) and names outputs
`{stem}-metadata.pdf`. TypeScript mirrors the types
(`PdfDateWire/Data`, `MetadataPatchWire/Options`, `MetadataSummary`),
translates summaries in `engineResult.ts`, registers both ops
(read: `none` form; set: `metadata` form with per-field text +
clear-checkbox + `YYYY-MM-DD HH:MM:SS +HHMM` date inputs), mocks both
in `MockEngineAdapter`, and renders all eight fields as plain text in
`ResultPanel` (metadata is untrusted — text nodes only, no HTML
interpretation anywhere). Dev Console executes both ops end to end
(read → edit → write → re-read output), with outputs downloadable and
re-inspectable like every other producing op.

### Large-file behavior (Lesson 14 strategy, no rendering involved)

Owned-bytes pattern throughout: no PDF.js, no canvases, no thumbnails,
no React/Zustand bytes. Measured on `merged.pdf` (490.1 MB, 2585 pp):
read ~49–74 s engine (WASM; first-run warmup dominates, native
release figures below), write (parse + patch + full rewrite)
~0.9 s engine, output ~490 MB, reopen + verify ~1.1 s. Repeated-cycle
and cancellation behavior unchanged from Lesson 14 (cancel race on a
large write settles `CANCELLED` honestly; completed races re-parse
cleanly — E2E asserts both branches).

### Verification (all actually run)

- Rust: `cargo test` (204 lib incl. 33 new metadata unit tests +
  11-test `tests/pdf_metadata.rs` engine-path integration incl.
  benchmark smoke); `cargo fmt --check`, `cargo clippy
  --all-targets --all-features -- -D warnings` (native +
  wasm32); `wasm-pack build` succeeds.
- Native CLI (`examples/metadata.rs`): corpus read (80 pp, real
  `+05'30'` dates, `®` decoding), set/clear round-trip with re-read,
  `--repeat` timings.
- Frontend: `npm test` (registry, mock, flow, date-parser, form
  plumbing), `typecheck`, `eslint`, `prettier --check`, `vite build`.
- Real headless Chrome (`e2e/metadata.e2e.mjs`, CDP byte transport):
  corpus read/set/round-trip/Unicode/dates/clears, error codes
  (`INVALID_INPUT`/`INVALID_OPTIONS`), progress streaming, XMP
  survival, sparse/partial metadata shapes, large read/write/reopen,
  cancel race, zero failed/non-local requests, zero console errors.
- Regression: Lesson 12/13/14 suites re-run green (rendering unit +
  thumbnail 33/33 + large-file 23/23 E2E).

### Known limitations (explicit)

- Custom Info keys: intentionally unsupported (no API).
- XMP: preserved, never edited or synchronized with Info.
- Dates outside `year 1–9999`, leap seconds, and non-Gregorian
  calendars: unrepresentable (normalize to `None` on read, rejected
  on write).
- Empty-string metadata values: unreadable distinction from absent
  is preserved on read (`Some("")` stays `Some("")`), but *setting*
  `""` is rejected — use `Clear`.
- No IndexedDB/OPFS caching of metadata, no production metadata UI
  (dev Console surface only); future UI consumes `MetadataSummary` +
  the patch wire shape unchanged.

## 27. Phase 1B — Production UI integration (PDF Studio + Folio engine)

### What it is

The PDF Studio `dev`-branch UI/UX (hash-routed React app: Home bento,
Merge/Split/Rearrange/Rotate/Compress tools) transplanted into
`frontend/src/studio/` as the production experience, with its legacy
PDF implementation (pdf-lib ops, direct pdfjs-dist rendering, bespoke
render worker) replaced by the frozen Folio engine underneath. The
Developer Console remains at `?testbench`, strictly separate.

```text
Studio UI (tools/hooks/components, preserved)
      ↓  ids, names, progress, errors — never bytes, never PDF logic
studio/services/folio.ts (application PDF service)
      ↓  Folio TypeScript APIs
WasmWorkerEngineAdapter → Rust/WASM → lopdf      (manipulation)
PdfRenderEngine → PdfJsRenderEngine → PDF.js      (rendering)
PdfThumbnailEngine → PdfRenderEngine              (thumbnails)
```

### Source material

- Cloned `github.com/SUMANTHXT900/pdf-studio` branch `dev` (commit
  `ffa87c8`) as a pristine reference; transplanted 14 UI files
  (App→`StudioApp`, Home, About, ui, 5 tools + 2 new, 2 hooks) with
  adaptations confined to data plumbing and engine calls — layout,
  tokens (`paper/ink/brass/forest`), motion, and workflows preserved.
- Dependencies: added `framer-motion`, `lucide-react`,
  `@fontsource-variable/{inter,fraunces}`; `pdf-lib` never added
  (legacy); single `pdfjs-dist` (ours, engine-internal only); React 19
  kept (no downgrade); no broad upgrades; no PWA plugin (future).

### Legacy implementation removed

- `lib/pdf.ts` (pdf-lib merge/split/remove/reorder/rotate/compress +
  direct pdfjs-dist rendering) deleted; download/share helpers kept as
  generic browser utilities inside the service.
- `workers/pdfRender.worker.ts` deleted (Folio engines replace it).
- `usePdfFiles` rewritten: React state holds `{id,name,sizeBytes,
  pageCount}` only; bytes live in the service module store.
- `usePageThumbs` rewritten on `PdfThumbnailEngine` (bounded
  concurrency-2 windows of 24, same external contract: URL array with
  holes, initial wave + paced background fill, fillAll, cancel,
  full-res preview). Canvases released on URL encode; URLs LRU-bounded
  (6 docs) and revoked on evict/close.
- About-page copy updated where it named the old libraries; changelog
  history entries left factual.

### Tools and engine mapping

- Merge → `pdf.merge` (order preserved, real progress, added Cancel,
  same auto-download + naming).
- Split pick → `pdf.extract_pages` (kept pages); ranges →
  `pdf.split` (one part per range, multi-download preserved);
  out-of-range now surfaces structured `PAGE_OUT_OF_RANGE`.
- Rearrange → `pdf.reorder` (0-based UI order mapped to 1-based
  permutation); viewer modal renders via `PdfRenderEngine`.
- Rotate → chained `pdf.rotate` calls grouped by quarter-turns
  (per-page turns preserved exactly); added Cancel + progress.
- Compress → action disabled with an explicit future-work note
  (Phase 2 boundary; no fake backend).
- Metadata (new tool) → `pdf.read_metadata` + `pdf.set_metadata`
  (8 fields, set/clear/unchanged, date format documented in-form).
- Images (new tool) → `pdf.images_to_pdf` (fit/A4 policies).
- Errors map engine codes to friendly messages with codes preserved
  for diagnostics; cancellation settles honestly everywhere.

### Ownership and lifecycle

PDF bytes never enter React/Zustand/JSON/storage — module stores
only, passed by reference, outputs moved (not copied) into studio
ownership and released on close/evict. Rendering docs open per file
and close on remove/clear/unmount with thumb-job cancellation and URL
revocation; no stale document IDs. Large files: initial 24-thumb wave
+ on-demand fill (never whole-document canvases), single reused
preview canvas, 150 MB intake notice kept.

### Verification (all actually run)

- Engine suites unchanged and green: Rust **345**, frontend **140**
  (+4 service unit tests), metadata **27/27**, thumbnail **33/33**,
  large-file **23/23** E2E.
- Production UI E2E (`e2e/studio.e2e.mjs`, real uploads + downloads):
  **25/25** — home cards, merge, split grid/toggle/extract/error,
  rearrange, rotate, metadata round-trip, images build, compress
  disabled, large-file bounded thumbs, UI cancellation.
- `typecheck`, `eslint`, `prettier --check`, `vite build`,
  `wasm-pack build`, `cargo fmt`, `cargo clippy` all green.
- Visual check: baseline screenshots (`e2e/baseline/`) vs
  post-integration captures (`e2e/after/`) for home, merge-empty,
  and split-grid — same layout/tokens/motion.

### Known limitations (explicit)

- SplitTool's preview lightbox is pre-existing dead code (left as is).
- Compress has no backend by design (Phase 2).
- No Images reorder UI (list order = page order, documented in-tool).
- Whole-document thumbnail arrays are never built by the UI; Show-all
  streams bounded windows (Lesson 14 model).
- PWA/service-worker installability not carried over (future).
