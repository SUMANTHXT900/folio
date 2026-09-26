//! `pdf.delete_pages`: remove selected pages from a PDF.
//!
//! Takes 1-based page numbers to delete and produces a new [`PdfDocument`]
//! containing every other page in its original order. This is a
//! selection/orchestration operation: output construction uses the shared
//! deep-copy primitive from Lesson 3 (`core::copy`), never a second
//! implementation.
//!
//! Semantics:
//!
//! * Remaining pages always keep their original relative order, whatever
//!   order the deletion list arrives in.
//! * Duplicate deletion entries are rejected (`DuplicatePage`), never
//!   silently deduplicated.
//! * An empty deletion list is a valid no-op returning an independent copy
//!   of the full document (composable and predictable).
//! * Deleting every page is rejected: zero-page PDFs are not produced.
//!
//! Never mutates the input. No range-string parsing in the core, no
//! rendering, no compression, no encryption — those are later lessons.

use std::collections::HashSet;

use crate::core::document::{Document, DocumentData};
use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::{Operation, OperationCapabilities, OperationContext};
use crate::processing::pdf::core::copy::{copy_pages_with_map, find_invalid_page};
use crate::processing::pdf::core::{load_pdf, PageNumber, PdfDocument};

/// Input for [`DeletePagesOperation`]: owned PDF bytes plus an optional label.
///
/// Built from raw bytes or from a core [`Document`] with inline data.
/// Reference-handle documents are rejected: resolving storage handles is
/// an outer-layer concern, not a processing-core one.
#[derive(Debug, Clone)]
pub struct DeletePagesInput {
    /// Raw PDF bytes. Owned so the operation signature stays `'static`;
    /// only borrowed (`&[u8]`) downstream — never copied again, never mutated.
    pub data: Vec<u8>,
    /// Optional human-readable label, carried through for diagnostics.
    pub name: Option<String>,
}

impl DeletePagesInput {
    /// Creates input from raw PDF bytes.
    pub fn from_bytes(data: Vec<u8>) -> Result<Self, EngineError> {
        if data.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "delete input bytes must not be empty",
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
                "delete requires inline document bytes, not a storage reference",
            )),
        }
    }
}

/// Options for [`DeletePagesOperation`]: the 1-based pages to delete. No
/// range-string parsing happens here (or anywhere in the core); higher
/// layers produce this list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletePagesOptions {
    /// Pages to delete, 1-based. Order is irrelevant: remaining pages keep
    /// source order. Duplicates are rejected, not deduplicated. Empty
    /// means delete nothing (independent full copy).
    pub pages: Vec<PageNumber>,
}

impl DeletePagesOptions {
    /// Creates options from a deletion list. Range, duplicates, and the
    /// all-pages edge case are validated during execution before anything
    /// is constructed.
    #[must_use]
    pub const fn new(pages: Vec<PageNumber>) -> Self {
        Self { pages }
    }
}

/// Output of [`DeletePagesOperation`]: the pruned document.
///
/// Holds the parsed result so it can be inspected further, passed to
/// another operation, or serialized via [`PdfDocument::save_to_bytes`]
/// for file output / WASM transfer.
#[derive(Debug)]
pub struct DeletePagesOutput {
    /// The output document, containing the surviving pages in original order.
    pub document: PdfDocument,
    /// Page count of the input document.
    pub input_page_count: u32,
    /// Page count of the output document.
    pub output_page_count: u32,
}

/// Deletes selected pages via the shared page-copy primitive.
/// Single engine execution, single lifecycle.
#[derive(Debug, Default)]
pub struct DeletePagesOperation;

impl Operation for DeletePagesOperation {
    type Input = DeletePagesInput;
    type Options = DeletePagesOptions;
    type Output = DeletePagesOutput;

    fn name(&self) -> &'static str {
        "pdf.delete_pages"
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
        ctx.report_progress(Some("validating"), 5, 100, Some("validating deletion list"));
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

        // Validate the ENTIRE request, then derive the surviving pages,
        // before constructing anything.
        let remaining = remaining_pages(ctx, &source, &options.pages)?;

        // Surviving pages occupy the 10–95% band. The request was validated
        // against the cached page map, which the copy reuses.
        let total = remaining.len() as u64;
        let document = copy_pages_with_map(&source, source.page_map(), &remaining, |done, _| {
            ctx.check_cancellation()?;
            let completed = 10 + (done as u64 * 85) / total.max(1);
            ctx.report_progress(
                Some("deleting pages"),
                completed.min(95),
                100,
                Some(&format!("page {done} of {total}")),
            );
            Ok(())
        })?;

        ctx.check_cancellation()?;
        ctx.report_progress(Some("finalizing"), 100, 100, Some("delete complete"));
        let input_page_count = source.page_count();
        let output_page_count = document.page_count();
        Ok(DeletePagesOutput {
            document,
            input_page_count,
            output_page_count,
        })
    }
}

/// Validates the deletion list and returns the surviving 1-based pages in
/// source order. Checks run in a fixed order — range, duplicates,
/// non-empty remainder — so the reported error is deterministic.
/// Entry/position numbers in messages are 1-based for humans; details
/// carry the same fields in `key=value` form for machines.
fn remaining_pages<C: OperationContext>(
    ctx: &C,
    source: &PdfDocument,
    pages: &[PageNumber],
) -> Result<Vec<PageNumber>, EngineError> {
    let page_count = source.page_count();
    if let Some((entry_index, page_number)) = find_invalid_page(source, pages) {
        let entry_number = entry_index + 1;
        return Err(EngineError::new(
            ErrorCode::PageOutOfRange,
            format!(
                "deletion entry {entry_number} references page {page_number}, \
                 but the document contains only {page_count} pages"
            ),
        )
        .with_details(format!(
            "entry={entry_number} page={page_number} page_count={page_count}"
        )));
    }
    let mut seen = HashSet::with_capacity(pages.len());
    for (entry_index, page_number) in pages.iter().enumerate() {
        if !seen.insert(page_number) {
            let first = pages
                .iter()
                .position(|entry| entry == page_number)
                .map(|position| position + 1)
                .unwrap_or(1);
            let duplicate_number = entry_index + 1;
            return Err(EngineError::new(
                ErrorCode::DuplicatePage,
                format!("page {page_number} appears more than once in the deletion list"),
            )
            .with_details(format!(
                "page={page_number} first_position={first} \
                 duplicate_position={duplicate_number} page_count={page_count}"
            )));
        }
    }

    // Single ordered scan: every non-deleted page survives, in place.
    let mut remaining = Vec::with_capacity(page_count as usize);
    for page_number in 1..=page_count {
        // Cancellation stays observable on very large documents even
        // though this scan is cheap per page.
        if page_number % 1024 == 0 {
            ctx.check_cancellation()?;
        }
        if !seen.contains(&page_number) {
            remaining.push(page_number);
        }
    }
    if remaining.is_empty() {
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            format!(
                "deleting all {page_count} pages would produce an empty document; \
                 at least one page must remain"
            ),
        )
        .with_details(format!(
            "input_page_count={page_count} requested_delete_count={} output_page_count=0",
            pages.len(),
        )));
    }
    Ok(remaining)
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
            "pdf.delete_pages"
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
            "pdf.delete_pages"
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
            Err(EngineError::cancelled(&self.id, "pdf.delete_pages"))
        }
    }

    fn ctx() -> NullCtx {
        NullCtx { id: JobId::new() }
    }

    fn input(bytes: Vec<u8>) -> DeletePagesInput {
        DeletePagesInput::from_bytes(bytes).expect("input builds")
    }

    /// Runs a deletion and re-parses the serialized output, returning the
    /// fresh document for structural assertions.
    fn delete_and_reparse(bytes: Vec<u8>, pages: &[PageNumber]) -> PdfDocument {
        let mut out = DeletePagesOperation
            .execute(
                &ctx(),
                input(bytes),
                DeletePagesOptions::new(pages.to_vec()),
            )
            .expect("deletion succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("output serializes");
        load_pdf(&serialized).expect("output re-parses")
    }

    #[test]
    fn deletes_single_page() {
        let reparsed = delete_and_reparse(fixtures::five_page_pdf(), &[2]);
        assert_eq!(reparsed.page_count(), 4);
        // Survivors keep source order: widths 612, 420, 612, 500.
        let widths: Vec<f64> = (1..=4)
            .map(|n| reparsed.page_geometry(n).expect("readable").width_pt)
            .collect();
        for (actual, expected) in widths.iter().zip([612.0, 420.0, 612.0, 500.0]) {
            assert!((actual - expected).abs() < f64::EPSILON);
        }
    }

    #[test]
    fn deletes_first_page() {
        let reparsed = delete_and_reparse(fixtures::mixed_pages_pdf(), &[1]);
        assert_eq!(reparsed.page_count(), 2);
        assert_eq!(reparsed.page_geometry(1).expect("p1").rotation_deg, 90);
        assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 270);
    }

    #[test]
    fn deletes_last_page() {
        let reparsed = delete_and_reparse(fixtures::mixed_pages_pdf(), &[3]);
        assert_eq!(reparsed.page_count(), 2);
        assert!((reparsed.page_geometry(2).expect("p2").width_pt - 595.0).abs() < f64::EPSILON);
    }

    #[test]
    fn deletes_first_and_last() {
        let reparsed = delete_and_reparse(fixtures::five_page_pdf(), &[1, 5]);
        assert_eq!(reparsed.page_count(), 3);
        assert_eq!(reparsed.page_geometry(1).expect("p1").rotation_deg, 90);
        assert_eq!(reparsed.page_geometry(3).expect("p3").rotation_deg, 180);
    }

    #[test]
    fn unsorted_deletion_list_keeps_source_order() {
        let reparsed = delete_and_reparse(fixtures::five_page_pdf(), &[5, 2, 4]);
        assert_eq!(reparsed.page_count(), 2);
        // Survivors are source pages 1 and 3 regardless of request order.
        assert!((reparsed.page_geometry(1).expect("p1").width_pt - 612.0).abs() < f64::EPSILON);
        assert_eq!(reparsed.page_geometry(1).expect("p1").rotation_deg, 0);
        assert!((reparsed.page_geometry(2).expect("p2").width_pt - 420.0).abs() < f64::EPSILON);
        assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 270);
    }

    #[test]
    fn empty_deletion_list_copies_everything() {
        let bytes = fixtures::mixed_pages_pdf();
        let out = DeletePagesOperation
            .execute(&ctx(), input(bytes), DeletePagesOptions::new(vec![]))
            .expect("empty deletion succeeds")
            .document;
        assert_eq!(out.page_count(), 3);
        let mut reparsed = out;
        let serialized = reparsed.save_to_bytes().expect("serializes");
        let reparsed = load_pdf(&serialized).expect("re-parses");
        assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 90);
    }

    #[test]
    fn rejects_deleting_all_pages() {
        let err = DeletePagesOperation
            .execute(
                &ctx(),
                input(fixtures::mixed_pages_pdf()),
                DeletePagesOptions::new(vec![1, 2, 3]),
            )
            .expect_err("delete-all must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
        assert!(err.message().contains("empty document"));
        let details = err.details().expect("structured details");
        assert!(details.contains("input_page_count=3"));
        assert!(details.contains("output_page_count=0"));
    }

    #[test]
    fn rejects_duplicate_deletion() {
        let err = DeletePagesOperation
            .execute(
                &ctx(),
                input(fixtures::five_page_pdf()),
                DeletePagesOptions::new(vec![2, 2, 4]),
            )
            .expect_err("duplicate must fail");
        assert_eq!(err.code(), ErrorCode::DuplicatePage);
        assert_eq!(err.code().code_str(), "DUPLICATE_PAGE");
        let details = err.details().expect("structured details");
        assert!(details.contains("page=2"));
        assert!(details.contains("first_position=1"));
        assert!(details.contains("duplicate_position=2"));
    }

    #[test]
    fn rejects_page_zero() {
        let err = DeletePagesOperation
            .execute(
                &ctx(),
                input(fixtures::five_page_pdf()),
                DeletePagesOptions::new(vec![0]),
            )
            .expect_err("zero must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert!(err.message().contains("entry 1"));
    }

    #[test]
    fn rejects_out_of_range_page() {
        let err = DeletePagesOperation
            .execute(
                &ctx(),
                input(fixtures::five_page_pdf()),
                DeletePagesOptions::new(vec![2, 999]),
            )
            .expect_err("out of range must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert!(err.message().contains("999"));
        assert!(err.message().contains("entry 2"));
        let details = err.details().expect("structured details");
        assert!(details.contains("page=999"));
        assert!(details.contains("page_count=5"));
    }

    #[test]
    fn reports_first_problem_deterministically() {
        // Range is checked before duplicates: an order containing both
        // reports the range problem first, every time.
        for _ in 0..2 {
            let err = DeletePagesOperation
                .execute(
                    &ctx(),
                    input(fixtures::five_page_pdf()),
                    DeletePagesOptions::new(vec![2, 2, 999]),
                )
                .expect_err("must fail");
            assert_eq!(err.code(), ErrorCode::PageOutOfRange);
            assert!(err.message().contains("999"));
        }
    }

    #[test]
    fn content_follows_surviving_pages() {
        let texts = ["PAGE 1", "PAGE 2", "PAGE 3", "PAGE 4", "PAGE 5"];
        let bytes = fixtures::text_pages_pdf(&texts);
        let mut out = DeletePagesOperation
            .execute(&ctx(), input(bytes), DeletePagesOptions::new(vec![2, 4]))
            .expect("deletion succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("output serializes");
        let raw = lopdf::Document::load_mem(&serialized).expect("output re-parses");
        assert_eq!(raw.get_pages().len(), 3);
        for (output_index, expected) in ["PAGE 1", "PAGE 3", "PAGE 5"].iter().enumerate() {
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
    fn preserves_metadata_and_version() {
        let reparsed = delete_and_reparse(fixtures::mixed_pages_pdf(), &[2]);
        assert_eq!(reparsed.pdf_version(), "1.7");
        let meta = reparsed.metadata();
        assert_eq!(meta.title.as_deref(), Some("Mixed Pages"));
        assert_eq!(meta.author.as_deref(), Some("folio-engine fixtures"));
    }

    #[test]
    fn malformed_input_fails_cleanly() {
        let err = DeletePagesOperation
            .execute(
                &ctx(),
                input(b"not a pdf".to_vec()),
                DeletePagesOptions::new(vec![1]),
            )
            .expect_err("malformed must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
    }

    #[test]
    fn locked_pdf_fails_cleanly() {
        let err = DeletePagesOperation
            .execute(
                &ctx(),
                input(fixtures::build_locked_pdf()),
                DeletePagesOptions::new(vec![1]),
            )
            .expect_err("locked must fail");
        assert_eq!(err.code(), ErrorCode::UnsupportedFormat);
    }

    #[test]
    fn rejects_empty_and_reference_inputs() {
        assert!(DeletePagesInput::from_bytes(Vec::new()).is_err());

        let reference = Document::from_reference(
            crate::core::document::DocumentId::new("doc-1").expect("id"),
            crate::core::document::MediaType::Pdf,
            None,
            128,
            "opfs://docs/abc",
        )
        .expect("reference builds");
        let err = DeletePagesInput::from_document(&reference).expect_err("reference rejected");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn cancellation_aborts_before_construction() {
        let cancelled = CancelledCtx { id: JobId::new() };
        let err = DeletePagesOperation
            .execute(
                &cancelled,
                input(fixtures::five_page_pdf()),
                DeletePagesOptions::new(vec![2, 4]),
            )
            .expect_err("cancelled must fail");
        assert_eq!(err.code(), ErrorCode::Cancelled);
    }

    #[test]
    fn source_document_is_untouched() {
        let bytes = fixtures::mixed_pages_pdf();
        let before = bytes.clone();
        let source = load_pdf(&bytes).expect("fixture loads");
        let out = DeletePagesOperation
            .execute(
                &ctx(),
                input(bytes.clone()),
                DeletePagesOptions::new(vec![2]),
            )
            .expect("deletion succeeds");
        // Input bytes never mutated; source still has all pages.
        assert_eq!(bytes, before);
        assert_eq!(source.page_count(), 3);
        assert_eq!(out.output_page_count, 2);
        assert_eq!(out.input_page_count, 3);
    }

    #[test]
    fn deletion_is_deterministic() {
        let bytes = fixtures::five_page_pdf();
        let run = || {
            let mut out = DeletePagesOperation
                .execute(
                    &ctx(),
                    input(bytes.clone()),
                    DeletePagesOptions::new(vec![5, 2]),
                )
                .expect("run succeeds")
                .document;
            out.save_to_bytes().expect("serializes")
        };
        assert_eq!(run(), run());
    }
}
