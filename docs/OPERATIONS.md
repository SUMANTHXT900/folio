# Folio — PDF Operation Contracts

Documentation only — the engine is frozen for Phase 1. Every contract below is verified against `src/processing/pdf/*/mod.rs` module docs and `frontend/src/types/engine.ts`. Operation IDs are the stable wire names; page numbers are **1-based** throughout.

Global rules for all operations: inputs arrive as bytes (never paths); validation runs before mutation; failures return structured `ErrorCode`s (see `docs/ARCHITECTURE.md`); all ten operations declare `parallel_friendly()` capabilities (progress + cancellation supported); results carry an authoritative `engineDurationMs` and a typed summary.

## `pdf.inspect` — read-only structural inspection

- **Purpose.** Cheap document facts without modification.
- **Input.** One PDF. **Options.** `level: 'basic' | 'detailed'`.
- **Output.** `InspectSummary`: page count, PDF version, encryption flag, metadata (title/author/producer), plus per-page geometry (`pageNumber`, `widthPt`, `heightPt`, `rotationDeg`) only at `detailed` level.
- **Semantics.** Never modifies input. No text extraction, rendering, or image extraction (explicit non-scope).
- **Errors.** `INVALID_DOCUMENT` for unreadable input; encrypted files surface via the `encrypted` flag.
- **Testing.** `tests/pdf_inspect.rs` + unit tests.

## `pdf.extract_pages` — copy selected pages into a new PDF

- **Purpose.** Build a new document from an explicit page list.
- **Input.** One PDF. **Options.** `pages: number[]` (1-based, validated).
- **Output.** New PDF with the requested pages **in the requested order** — `[5, 2, 4]` yields pages 5, 2, 4 in that order. Duplicates yield independent copies (`[2, 2, 5]` → three pages). Never mutates the input.
- **Errors.** `INVALID_PAGE_RANGE` / `PAGE_OUT_OF_RANGE` for bad selections.
- **Testing.** `tests/pdf_extract.rs` + unit tests.

## `pdf.split` — carve one PDF into named parts

- **Purpose.** Visual pick mode (keep/drop per page) and range-based parts (one file per range).
- **Input.** One PDF. **Options.** `parts: [{pages, name?}]` (1-based page lists).
- **Output.** `SplitSummary` (`inputPageCount`, per-part `name` + `pageCount`) plus one output document per part.
- **Atomicity.** Outputs return only after **every** part succeeds — no partial results on failure.
- **Errors.** Structured range errors (asserted in E2E: invalid ranges are rejected with actionable messages, nothing is produced).
- **Testing.** `tests/pdf_split.rs` + unit tests + E2E (pick mode download, range error, 21/22 toggle).

## `pdf.reorder` — exact permutation

- **Purpose.** Drag-to-reorder pages (Rearrange tool).
- **Input.** One PDF. **Options.** `order: number[]` (1-based).
- **Output.** New PDF with pages in the given order.
- **Semantics.** Every page `1..=N` must appear **exactly once**: no duplicates, nothing missing, nothing pre-sorted. Checks run in fixed order: emptiness → length → range → duplication (per `reorder/mod.rs` docs).
- **Errors.** `INVALID_OPTIONS` / `DUPLICATE_PAGE` for non-permutations.
- **Testing.** `tests/pdf_reorder.rs` + unit tests + E2E (reordered save).

## `pdf.delete_pages` — remove selected pages

- **Purpose.** Delete pages, keep everything else in original order.
- **Input.** One PDF. **Options.** `pages: number[]` (1-based pages to delete).
- **Output.** New PDF with every other page in original order (orchestration over the shared Lesson-3 deep-copy primitive; never mutates input).
- **Errors.** `INVALID_PAGE_RANGE` / `PAGE_OUT_OF_RANGE`.
- **Testing.** `tests/pdf_delete.rs` + unit tests. (No dedicated Studio tool surface yet — engine contract preserved regardless.)

## `pdf.rotate` — relative quarter-turn rotation

- **Purpose.** Rotate individual pages or the whole document.
- **Input.** One PDF. **Options.** `pages: number[]` (1-based, need not cover the document; order irrelevant; duplicates rejected) + `angleDeg: number`.
- **Output.** New PDF with each selected page's rotation advanced by the angle.
- **Semantics.** Relative: a page showing 90° rotated by +90° shows 180°. Results normalize to 0/90/180/270. Any integer equivalent to a multiple of 90° is accepted (`360`→`0`, `450`→`90`, `-90`→`270`); anything else is rejected. Empty selection or 0° is valid (no-op success).
- **Errors.** `INVALID_OPTIONS` for non-quarter-turn angles or duplicates.
- **Testing.** `tests/pdf_rotate.rs` + unit tests + E2E (rotated download).

## `pdf.merge` — ordered concatenation

- **Purpose.** Combine multiple PDFs into one, in caller order.
- **Input.** One or more PDFs (at least one document; at least one page across all inputs — no zero-page output). **Options.** None (`{}`).
- **Output.** `MergeSummary` (`inputDocumentCount`, `inputPageCount`, `outputPageCount`) plus the merged PDF.
- **Semantics.** Input order is significant and preserved; nothing sorted, deduplicated, or reordered — not even identical inputs. All page copying goes through the shared cross-document primitive (`core::copy::merge_documents`).
- **Progress/cancellation.** Real engine progress (stage + percentage) and honest cancellation, both asserted in E2E.
- **Testing.** `tests/pdf_merge.rs` + unit tests + E2E (page counts, real download, `%PDF-` magic, cancellation).

## `pdf.images_to_pdf` — build a PDF from images

- **Purpose.** One PDF from JPEG/PNG images, one page per image, input order preserved.
- **Input.** One or more image byte blobs (staged without a rendering document). **Options.** `pageSize: 'fit' | 'standard'`, `backgroundRgb: [r, g, b]`.
- **Output.** New PDF, N images → N pages. `FitImage` (default) sizes each page to the image's natural size (`px * 72 / dpi`); `StandardPage` uses fixed A4 (595.28 × 841.89 pt). Aspect ratio never distorted. EXIF orientation and DPI handled in-engine so native and WASM share one implementation.
- **Errors.** Non-JPEG/PNG input fails as `UNSUPPORTED_FORMAT`.
- **Testing.** `tests/pdf_images_to_pdf.rs` + unit tests + E2E (built PDF download).

## `pdf.read_metadata` — read document properties

- **Purpose.** Authoritative metadata + page count for the Metadata tool.
- **Input.** One PDF. **Options.** None.
- **Output.** `MetadataSummary`: page count + `DocumentMetadata` (title, author, subject, keywords, creator, producer, creation/modification dates as `PdfDate`).
- **Testing.** `tests/pdf_metadata.rs` + unit tests + E2E (reads real properties).

## `pdf.set_metadata` — patch document properties

- **Purpose.** Edit metadata with explicit per-field intent.
- **Input.** One PDF. **Options.** `patch: MetadataPatchWire` — per field: `{"op":"set","value"}` writes, `{"op":"clear"}` removes the key, **absent field leaves it unchanged**.
- **Output.** New PDF with patched metadata + `MetadataSummary`.
- **Semantics.** String values are UTF-8 text; dates are 7-field `PdfDate` objects (snake_case on the wire, camelCase in app state). Setting `""` is rejected — use `Clear`. Read preserves `Some("")` distinctly from absent.
- **Errors.** `INVALID_OPTIONS` for malformed patches.
- **Testing.** `tests/pdf_metadata.rs` + unit tests + E2E (patch round-trips in UI).
