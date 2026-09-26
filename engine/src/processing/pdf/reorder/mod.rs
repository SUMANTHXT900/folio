//! `pdf.reorder`: reorder all pages of a PDF into a new PDF.
//!
//! Takes a permutation of the complete 1-based page set and produces a new
//! [`PdfDocument`] with the same pages in the requested order. This is an
//! orchestration operation: output construction uses the shared deep-copy
//! primitive from Lesson 3 (`core::copy`), never a second implementation.
//!
//! Semantics (deliberately stricter than `pdf.extract_pages`):
//!
//! * For an N-page document the order must contain exactly N entries.
//! * Every page `1..=N` must appear exactly once: no duplicates, nothing
//!   missing, nothing out of range. The request is never normalized,
//!   deduplicated, completed, or sorted.
//! * The identity order (`[1, 2, …, N]`) is valid and produces an
//!   independent copy, like any other order — there is no special case.
//!
//! Never mutates the input. No range-string parsing in the core, no
//! rendering, no compression, no encryption — those are later lessons.

use std::collections::HashSet;

use crate::core::document::{Document, DocumentData};
use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::{Operation, OperationCapabilities, OperationContext};
use crate::processing::pdf::core::copy::{copy_pages_with_map, find_invalid_page};
use crate::processing::pdf::core::{load_pdf, PageNumber, PdfDocument};

/// Input for [`ReorderOperation`]: owned PDF bytes plus an optional label.
///
/// Built from raw bytes or from a core [`Document`] with inline data.
/// Reference-handle documents are rejected: resolving storage handles is
/// an outer-layer concern, not a processing-core one.
#[derive(Debug, Clone)]
pub struct ReorderInput {
    /// Raw PDF bytes. Owned so the operation signature stays `'static`;
    /// only borrowed (`&[u8]`) downstream — never copied again, never mutated.
    pub data: Vec<u8>,
    /// Optional human-readable label, carried through for diagnostics.
    pub name: Option<String>,
}

impl ReorderInput {
    /// Creates input from raw PDF bytes.
    pub fn from_bytes(data: Vec<u8>) -> Result<Self, EngineError> {
        if data.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "reorder input bytes must not be empty",
            ));
        }
        Ok(Self { data, name: None })
    }

    /// Creates input from a core [`Document`].
    pub fn from_document(document: &Document) -> Result<Self, EngineError> {
        match document.data() {
            DocumentData::Inline(bytes) => Ok(Self {
                data: bytes.clone(),
                name: document.name().map(str::to_string),
            }),
            DocumentData::Reference(_) => Err(EngineError::new(
                ErrorCode::InvalidInput,
                "reorder requires inline document bytes, not a storage reference",
            )),
        }
    }
}

/// Options for [`ReorderOperation`]: the requested permutation. No
/// range-string parsing happens here (or anywhere in the core); higher
/// layers produce this list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReorderOptions {
    /// The new page order: a permutation of `1..=N` for an N-page
    /// document. Validated during execution before anything is constructed.
    pub order: Vec<PageNumber>,
}

impl ReorderOptions {
    /// Creates options from a requested order. Length, coverage,
    /// uniqueness, and range are all validated during execution.
    #[must_use]
    pub const fn new(order: Vec<PageNumber>) -> Self {
        Self { order }
    }
}

/// Output of [`ReorderOperation`]: the reordered document.
///
/// Holds the parsed result so it can be inspected further, passed to
/// another operation, or serialized via [`PdfDocument::save_to_bytes`]
/// for file output / WASM transfer.
#[derive(Debug)]
pub struct ReorderOutput {
    /// The reordered document. Page *i* of the output corresponds to order
    /// entry *i* of the requested permutation.
    pub document: PdfDocument,
    /// Page count of the reordered document (always equals the input page
    /// count, since a reorder is a permutation).
    pub page_count: u32,
}

/// Reorders every page of a PDF via the shared page-copy primitive.
/// Single engine execution, single lifecycle.
#[derive(Debug, Default)]
pub struct ReorderOperation;

impl Operation for ReorderOperation {
    type Input = ReorderInput;
    type Options = ReorderOptions;
    type Output = ReorderOutput;

    fn name(&self) -> &'static str {
        "pdf.reorder"
    }

    fn capabilities(&self) -> OperationCapabilities {
        // Sequential today; the per-page copy loop is the natural unit for
        // future bounded parallelism once baselines exist.
        OperationCapabilities::parallel_friendly()
    }

    fn execute<C: OperationContext>(
        &self,
        ctx: &C,
        input: Self::Input,
        options: Self::Options,
    ) -> Result<Self::Output, EngineError> {
        ctx.report_progress(Some("validating"), 5, 100, Some("validating page order"));
        ctx.check_cancellation()?;

        let source = load_pdf(&input.data)?;
        ctx.report_progress(Some("preparing"), 10, 100, Some("parsing PDF structure"));
        ctx.check_cancellation()?;

        // Still-encrypted documents need a password, which is a later
        // lesson: fail cleanly instead of returning partial data.
        if source.is_encrypted() {
            return Err(EngineError::new(
                ErrorCode::UnsupportedFormat,
                "PDF is encrypted and requires a password",
            )
            .with_details("password-based decryption is not supported yet"));
        }

        // Validate the ENTIRE order before constructing anything.
        validate_order(&source, &options.order)?;

        // Copied pages occupy the 10–95% band. The order was validated
        // against the cached page map, which the copy reuses.
        let total = options.order.len() as u64;
        let document =
            copy_pages_with_map(&source, source.page_map(), &options.order, |done, _| {
                ctx.check_cancellation()?;
                let completed = 10 + (done as u64 * 85) / total.max(1);
                ctx.report_progress(
                    Some("reordering pages"),
                    completed.min(95),
                    100,
                    Some(&format!("page {done} of {total}")),
                );
                Ok(())
            })?;

        ctx.check_cancellation()?;
        ctx.report_progress(Some("finalizing"), 100, 100, Some("reorder complete"));
        let page_count = document.page_count();
        Ok(ReorderOutput {
            document,
            page_count,
        })
    }
}

/// Validates that `order` is a permutation of `1..=N` for the N-page
/// document. Checks run in a fixed order — emptiness, length, range,
/// uniqueness — so the reported error is deterministic. Entry/position
/// numbers in messages are 1-based for humans; details carry the same
/// fields in `key=value` form for machines.
fn validate_order(source: &PdfDocument, order: &[PageNumber]) -> Result<(), EngineError> {
    let page_count = source.page_count();
    if order.is_empty() {
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            "reorder order must not be empty; provide one entry per document page",
        )
        .with_details(format!("page_count={page_count}")));
    }
    if order.len() as u32 != page_count {
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            format!(
                "reorder order has {} entries but the document has {page_count} pages; \
                 every page must appear exactly once",
                order.len(),
            ),
        )
        .with_details(format!("entries={} page_count={page_count}", order.len(),)));
    }
    if let Some((entry_index, page_number)) = find_invalid_page(source, order) {
        let entry_number = entry_index + 1;
        return Err(EngineError::new(
            ErrorCode::PageOutOfRange,
            format!(
                "order entry {entry_number} references page {page_number}, \
                 but the document contains only {page_count} pages"
            ),
        )
        .with_details(format!(
            "entry={entry_number} page={page_number} page_count={page_count}"
        )));
    }
    let mut seen = HashSet::with_capacity(order.len());
    for (entry_index, page_number) in order.iter().enumerate() {
        if !seen.insert(page_number) {
            let first = order
                .iter()
                .position(|entry| entry == page_number)
                .map(|position| position + 1)
                .unwrap_or(1);
            let duplicate_number = entry_index + 1;
            return Err(EngineError::new(
                ErrorCode::DuplicatePage,
                format!("page {page_number} appears more than once in the reorder order"),
            )
            .with_details(format!(
                "page={page_number} first_position={first} \
                 duplicate_position={duplicate_number} page_count={page_count}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::core::fixtures;
    use super::super::core::loader::load_pdf;
    use super::*;
    use crate::execution::job::JobId;

    struct NullCtx {
        id: JobId,
    }

    impl OperationContext for NullCtx {
        fn job_id(&self) -> &JobId {
            &self.id
        }
        fn operation_name(&self) -> &str {
            "pdf.reorder"
        }
        fn report_progress(
            &self,
            _phase: Option<&str>,
            _completed: u64,
            _total: u64,
            _message: Option<&str>,
        ) {
        }
        fn is_cancelled(&self) -> bool {
            false
        }
        fn check_cancellation(&self) -> Result<(), EngineError> {
            Ok(())
        }
    }

    /// Context that reports cancellation immediately, for unit-level
    /// cancellation coverage without an engine.
    struct CancelledCtx {
        id: JobId,
    }

    impl OperationContext for CancelledCtx {
        fn job_id(&self) -> &JobId {
            &self.id
        }
        fn operation_name(&self) -> &str {
            "pdf.reorder"
        }
        fn report_progress(
            &self,
            _phase: Option<&str>,
            _completed: u64,
            _total: u64,
            _message: Option<&str>,
        ) {
        }
        fn is_cancelled(&self) -> bool {
            true
        }
        fn check_cancellation(&self) -> Result<(), EngineError> {
            Err(EngineError::cancelled(&self.id, "pdf.reorder"))
        }
    }

    fn ctx() -> NullCtx {
        NullCtx { id: JobId::new() }
    }

    fn input(bytes: Vec<u8>) -> ReorderInput {
        ReorderInput::from_bytes(bytes).expect("input builds")
    }

    /// Runs a reorder and re-parses the serialized output, returning the
    /// fresh document for structural assertions.
    fn reorder_and_reparse(bytes: Vec<u8>, order: &[PageNumber]) -> PdfDocument {
        let mut out = ReorderOperation
            .execute(&ctx(), input(bytes), ReorderOptions::new(order.to_vec()))
            .expect("reorder succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("output serializes");
        load_pdf(&serialized).expect("output re-parses")
    }

    #[test]
    fn identity_order_produces_independent_copy() {
        let reparsed = reorder_and_reparse(fixtures::mixed_pages_pdf(), &[1, 2, 3]);
        assert_eq!(reparsed.page_count(), 3);
        assert_eq!(reparsed.page_geometry(1).expect("p1").rotation_deg, 0);
        assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 90);
        assert_eq!(reparsed.page_geometry(3).expect("p3").rotation_deg, 270);
    }

    #[test]
    fn full_reverse_order() {
        let reparsed = reorder_and_reparse(fixtures::mixed_pages_pdf(), &[3, 2, 1]);
        assert_eq!(reparsed.page_count(), 3);
        // Output page 1 is source page 3 (420-wide, rot270), etc.
        assert!((reparsed.page_geometry(1).expect("p1").width_pt - 420.0).abs() < f64::EPSILON);
        assert_eq!(reparsed.page_geometry(1).expect("p1").rotation_deg, 270);
        assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 90);
        assert!((reparsed.page_geometry(3).expect("p3").width_pt - 612.0).abs() < f64::EPSILON);
        assert_eq!(reparsed.page_geometry(3).expect("p3").rotation_deg, 0);
    }

    #[test]
    fn arbitrary_permutation() {
        let reparsed = reorder_and_reparse(fixtures::five_page_pdf(), &[3, 1, 5, 2, 4]);
        assert_eq!(reparsed.page_count(), 5);
        let widths: Vec<f64> = (1..=5)
            .map(|n| reparsed.page_geometry(n).expect("readable").width_pt)
            .collect();
        // Source widths in requested order: 420, 612, 500, 595, 612.
        for (actual, expected) in widths.iter().zip([420.0, 612.0, 500.0, 595.0, 612.0]) {
            assert!((actual - expected).abs() < f64::EPSILON);
        }
        assert_eq!(reparsed.page_geometry(4).expect("p4").rotation_deg, 90);
        assert_eq!(reparsed.page_geometry(5).expect("p5").rotation_deg, 180);
    }

    #[test]
    fn content_follows_reordered_pages() {
        let texts = ["PAGE 1", "PAGE 2", "PAGE 3", "PAGE 4", "PAGE 5"];
        let bytes = fixtures::text_pages_pdf(&texts);
        let mut out = ReorderOperation
            .execute(
                &ctx(),
                input(bytes),
                ReorderOptions::new(vec![5, 2, 4, 1, 3]),
            )
            .expect("reorder succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("output serializes");
        let raw = lopdf::Document::load_mem(&serialized).expect("output re-parses");
        assert_eq!(raw.get_pages().len(), 5);
        // Output page i must show the source page named by order[i].
        for (output_index, expected) in ["PAGE 5", "PAGE 2", "PAGE 4", "PAGE 1", "PAGE 3"]
            .iter()
            .enumerate()
        {
            let page_number = (output_index + 1) as u32;
            let page_id = raw.get_pages()[&page_number];
            let content = raw.get_page_content(page_id);
            let text = String::from_utf8_lossy(&content);
            assert!(
                text.contains(expected),
                "output page {page_number} shows {expected}: {text}"
            );
            for other in texts {
                if other != *expected {
                    assert!(
                        !text.contains(other),
                        "output page {page_number} leaked {other}: {text}"
                    );
                }
            }
        }
    }

    #[test]
    fn rejects_empty_order() {
        let err = ReorderOperation
            .execute(
                &ctx(),
                input(fixtures::single_page_pdf()),
                ReorderOptions::new(vec![]),
            )
            .expect_err("empty must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn rejects_too_few_entries() {
        let err = ReorderOperation
            .execute(
                &ctx(),
                input(fixtures::five_page_pdf()),
                ReorderOptions::new(vec![1, 2, 3, 4]),
            )
            .expect_err("short order must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
        assert!(err.message().contains('4'));
        assert!(err.message().contains("5 pages"));
    }

    #[test]
    fn rejects_too_many_entries() {
        let err = ReorderOperation
            .execute(
                &ctx(),
                input(fixtures::five_page_pdf()),
                ReorderOptions::new(vec![1, 2, 3, 4, 5, 1]),
            )
            .expect_err("long order must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
        assert!(err.message().contains('6'));
    }

    #[test]
    fn rejects_duplicate_pages() {
        let err = ReorderOperation
            .execute(
                &ctx(),
                input(fixtures::five_page_pdf()),
                ReorderOptions::new(vec![1, 2, 2, 4, 5]),
            )
            .expect_err("duplicate must fail");
        assert_eq!(err.code(), ErrorCode::DuplicatePage);
        assert_eq!(err.code().code_str(), "DUPLICATE_PAGE");
        assert!(err.message().contains('2'));
        let details = err.details().expect("structured details");
        assert!(details.contains("page=2"));
        assert!(details.contains("first_position=2"));
        assert!(details.contains("duplicate_position=3"));
        assert!(details.contains("page_count=5"));
    }

    #[test]
    fn rejects_page_zero() {
        let err = ReorderOperation
            .execute(
                &ctx(),
                input(fixtures::five_page_pdf()),
                ReorderOptions::new(vec![0, 2, 3, 4, 5]),
            )
            .expect_err("zero must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert!(err.message().contains("entry 1"));
    }

    #[test]
    fn rejects_out_of_range_page() {
        let err = ReorderOperation
            .execute(
                &ctx(),
                input(fixtures::five_page_pdf()),
                ReorderOptions::new(vec![1, 2, 3, 4, 999]),
            )
            .expect_err("out of range must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert!(err.message().contains("999"));
        assert!(err.message().contains("entry 5"));
        let details = err.details().expect("structured details");
        assert!(details.contains("page=999"));
        assert!(details.contains("page_count=5"));
    }

    #[test]
    fn reports_first_problem_deterministically() {
        // Length is checked before range: a short order containing junk
        // still reports the length problem first, every time.
        for _ in 0..2 {
            let err = ReorderOperation
                .execute(
                    &ctx(),
                    input(fixtures::five_page_pdf()),
                    ReorderOptions::new(vec![1, 999]),
                )
                .expect_err("must fail");
            assert_eq!(err.code(), ErrorCode::InvalidInput);
            assert!(err.message().contains("2 entries"));
        }
    }

    #[test]
    fn malformed_input_fails_cleanly() {
        let err = ReorderOperation
            .execute(
                &ctx(),
                input(b"not a pdf".to_vec()),
                ReorderOptions::new(vec![1]),
            )
            .expect_err("malformed must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
    }

    #[test]
    fn locked_pdf_fails_cleanly() {
        let err = ReorderOperation
            .execute(
                &ctx(),
                input(fixtures::build_locked_pdf()),
                ReorderOptions::new(vec![1]),
            )
            .expect_err("locked must fail");
        assert_eq!(err.code(), ErrorCode::UnsupportedFormat);
    }

    #[test]
    fn rejects_empty_and_reference_inputs() {
        assert!(ReorderInput::from_bytes(Vec::new()).is_err());

        let reference = Document::from_reference(
            crate::core::document::DocumentId::new("doc-1").expect("id"),
            crate::core::document::MediaType::Pdf,
            None,
            128,
            "opfs://docs/abc",
        )
        .expect("reference builds");
        let err = ReorderInput::from_document(&reference).expect_err("reference rejected");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn cancellation_aborts_before_construction() {
        let cancelled = CancelledCtx { id: JobId::new() };
        let err = ReorderOperation
            .execute(
                &cancelled,
                input(fixtures::five_page_pdf()),
                ReorderOptions::new(vec![5, 4, 3, 2, 1]),
            )
            .expect_err("cancelled must fail");
        assert_eq!(err.code(), ErrorCode::Cancelled);
    }

    #[test]
    fn reorder_is_deterministic() {
        let bytes = fixtures::five_page_pdf();
        let run = || {
            let mut out = ReorderOperation
                .execute(
                    &ctx(),
                    input(bytes.clone()),
                    ReorderOptions::new(vec![3, 1, 5, 2, 4]),
                )
                .expect("run succeeds")
                .document;
            out.save_to_bytes().expect("serializes")
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn preserves_metadata_and_version() {
        let reparsed = reorder_and_reparse(fixtures::mixed_pages_pdf(), &[3, 1, 2]);
        assert_eq!(reparsed.pdf_version(), "1.7");
        let meta = reparsed.metadata();
        assert_eq!(meta.title.as_deref(), Some("Mixed Pages"));
        assert_eq!(meta.author.as_deref(), Some("folio-engine fixtures"));
    }
}
