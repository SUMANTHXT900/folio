//! `pdf.extract_pages`: copy selected pages into a new PDF.
//!
//! Takes validated 1-based page numbers and produces a new [`PdfDocument`]
//! containing those pages in the requested order. Extraction is inherently
//! order-preserving per the caller's list, so `[5, 2, 4]` yields the input's
//! pages 5, 2, 4 in that order; duplicates (`[2, 2, 5]`) yield independent
//! copies. This is not a separate reorder operation — just the consequence
//! of copying selections in order.
//!
//! Never mutates the input. No text/model analysis, no rendering, no
//! compression, no encryption — those are later lessons.

use crate::core::document::{Document, DocumentData};
use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::{Operation, OperationCapabilities, OperationContext};
use crate::processing::pdf::core::copy::copy_pages;
use crate::processing::pdf::core::{load_pdf, PageNumber, PdfDocument};

/// Input for [`ExtractPagesOperation`]: owned PDF bytes plus an optional label.
///
/// Built from raw bytes or from a core [`Document`] with inline data.
/// Reference-handle documents are rejected: resolving storage handles is
/// an outer-layer concern, not a processing-core one.
#[derive(Debug, Clone)]
pub struct ExtractPagesInput {
    /// Raw PDF bytes. Owned so the operation signature stays `'static`;
    /// only borrowed (`&[u8]`) downstream — never copied again, never mutated.
    pub data: Vec<u8>,
    /// Optional human-readable label, carried through for diagnostics.
    pub name: Option<String>,
}

impl ExtractPagesInput {
    /// Creates input from raw PDF bytes.
    pub fn from_bytes(data: Vec<u8>) -> Result<Self, EngineError> {
        if data.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "extract input bytes must not be empty",
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
                "extract requires inline document bytes, not a storage reference",
            )),
        }
    }
}

/// Options for [`ExtractPagesOperation`]: the validated 1-based page
/// selection in output order. No range-string parsing happens here (or
/// anywhere in the core); higher layers produce this structured list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractPagesOptions {
    /// Selected pages, 1-based, in the exact order they must appear in
    /// the output. Duplicates are copied independently per entry.
    pub pages: Vec<PageNumber>,
}

impl ExtractPagesOptions {
    /// Creates options from a validated selection. Emptiness and range are
    /// checked against the actual document during execution, before any
    /// output is constructed.
    #[must_use]
    pub const fn new(pages: Vec<PageNumber>) -> Self {
        Self { pages }
    }
}

/// Output of [`ExtractPagesOperation`]: the new document.
///
/// Holds the parsed result so it can be inspected further, passed to
/// another operation, or serialized via [`PdfDocument::save_to_bytes`]
/// for file output / WASM transfer.
#[derive(Debug)]
pub struct ExtractPagesOutput {
    /// The extracted document. Page *i* of the output corresponds to
    /// selection entry *i* of the requested pages.
    pub document: PdfDocument,
}

/// Copies selected pages into a new PDF, preserving order.
#[derive(Debug, Default)]
pub struct ExtractPagesOperation;

impl Operation for ExtractPagesOperation {
    type Input = ExtractPagesInput;
    type Options = ExtractPagesOptions;
    type Output = ExtractPagesOutput;

    fn name(&self) -> &'static str {
        "pdf.extract_pages"
    }

    fn capabilities(&self) -> OperationCapabilities {
        // Sequential today; the per-page copy loop is the natural unit for
        // future sub-task parallelism once baselines exist.
        OperationCapabilities::parallel_friendly()
    }

    fn execute<C: OperationContext>(
        &self,
        ctx: &C,
        input: Self::Input,
        options: Self::Options,
    ) -> Result<Self::Output, EngineError> {
        ctx.report_progress(
            Some("validating"),
            5,
            100,
            Some("validating page selection"),
        );
        ctx.check_cancellation()?;
        if options.pages.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "page selection must not be empty; select at least one page",
            ));
        }

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

        // Full range validation happens inside `copy_pages` before anything
        // is constructed; only progress/cancellation reporting lives here.
        let total = options.pages.len() as u64;
        let document = copy_pages(&source, &options.pages, |done, _| {
            ctx.check_cancellation()?;
            // Selected pages occupy the 10–95% band.
            let completed = 10 + (done as u64 * 85) / total.max(1);
            ctx.report_progress(
                Some("extracting pages"),
                completed.min(95),
                100,
                Some(&format!("page {done} of {total}")),
            );
            Ok(())
        })?;

        ctx.report_progress(Some("finalizing"), 100, 100, Some("extraction complete"));
        Ok(ExtractPagesOutput { document })
    }
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
            "pdf.extract_pages"
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

    fn ctx() -> NullCtx {
        NullCtx { id: JobId::new() }
    }

    fn input(bytes: Vec<u8>) -> ExtractPagesInput {
        ExtractPagesInput::from_bytes(bytes).expect("input builds")
    }

    /// Runs extraction and re-parses the serialized output, returning the
    /// fresh document for structural assertions.
    fn extract_and_reparse(bytes: Vec<u8>, pages: &[PageNumber]) -> PdfDocument {
        let mut out = ExtractPagesOperation
            .execute(
                &ctx(),
                input(bytes),
                ExtractPagesOptions::new(pages.to_vec()),
            )
            .expect("extraction succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("output serializes");
        load_pdf(&serialized).expect("output re-parses")
    }

    #[test]
    fn extracts_single_page() {
        let reparsed = extract_and_reparse(fixtures::single_page_pdf(), &[1]);
        assert_eq!(reparsed.page_count(), 1);
        let geometry = reparsed.page_geometry(1).expect("page readable");
        assert!((geometry.width_pt - 612.0).abs() < f64::EPSILON);
        assert!((geometry.height_pt - 792.0).abs() < f64::EPSILON);
    }

    #[test]
    fn extracts_subset_preserving_order() {
        // Input: Letter / A4-rot90 / 420x595-rot270. Select [3, 1].
        let reparsed = extract_and_reparse(fixtures::mixed_pages_pdf(), &[3, 1]);
        assert_eq!(reparsed.page_count(), 2);
        let first = reparsed.page_geometry(1).expect("page 1");
        assert!((first.width_pt - 420.0).abs() < f64::EPSILON);
        assert_eq!(first.rotation_deg, 270);
        let second = reparsed.page_geometry(2).expect("page 2");
        assert!((second.width_pt - 612.0).abs() < f64::EPSILON);
        assert_eq!(second.rotation_deg, 0);
    }

    #[test]
    fn duplicates_yield_independent_pages() {
        let reparsed = extract_and_reparse(fixtures::mixed_pages_pdf(), &[2, 2, 1]);
        assert_eq!(reparsed.page_count(), 3);
        assert_eq!(reparsed.page_geometry(1).expect("p1").rotation_deg, 90);
        assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 90);
        assert_eq!(reparsed.page_geometry(3).expect("p3").rotation_deg, 0);
    }

    #[test]
    fn rejects_empty_selection() {
        let err = ExtractPagesOperation
            .execute(
                &ctx(),
                input(fixtures::single_page_pdf()),
                ExtractPagesOptions::new(vec![]),
            )
            .expect_err("empty must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn rejects_out_of_range_pages() {
        let err = ExtractPagesOperation
            .execute(
                &ctx(),
                input(fixtures::single_page_pdf()),
                ExtractPagesOptions::new(vec![1, 11]),
            )
            .expect_err("out of range must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert!(err.message().contains("11"));
    }

    #[test]
    fn rejects_multiple_invalid_pages() {
        let err = ExtractPagesOperation
            .execute(
                &ctx(),
                input(fixtures::mixed_pages_pdf()),
                ExtractPagesOptions::new(vec![0, 99]),
            )
            .expect_err("invalid pages must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert!(err.details().is_some());
    }

    #[test]
    fn preserves_metadata_and_version() {
        let reparsed = extract_and_reparse(fixtures::mixed_pages_pdf(), &[2]);
        assert_eq!(reparsed.pdf_version(), "1.7");
        let meta = reparsed.metadata();
        assert_eq!(meta.title.as_deref(), Some("Mixed Pages"));
        assert_eq!(meta.author.as_deref(), Some("folio-engine fixtures"));
    }

    #[test]
    fn preserves_page_content() {
        let reparsed = extract_and_reparse(fixtures::text_content_pdf(), &[2]);
        assert_eq!(reparsed.page_count(), 1);
        let raw = reparsed.raw_document();
        let page_id = raw.get_pages()[&1];
        let content = raw.get_page_content(page_id);
        let text = String::from_utf8_lossy(&content);
        assert!(text.contains("Beta page two"), "content survived: {text}");
        assert!(!text.contains("Alpha"), "unselected page leaked: {text}");
    }

    #[test]
    fn locked_pdf_fails_cleanly() {
        let err = ExtractPagesOperation
            .execute(
                &ctx(),
                input(fixtures::build_locked_pdf()),
                ExtractPagesOptions::new(vec![1]),
            )
            .expect_err("locked must fail");
        assert_eq!(err.code(), ErrorCode::UnsupportedFormat);
    }

    #[test]
    fn malformed_input_fails_cleanly() {
        let err = ExtractPagesOperation
            .execute(
                &ctx(),
                input(b"not a pdf".to_vec()),
                ExtractPagesOptions::new(vec![1]),
            )
            .expect_err("malformed must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
    }

    #[test]
    fn rejects_empty_and_reference_inputs() {
        assert!(ExtractPagesInput::from_bytes(Vec::new()).is_err());

        let reference = Document::from_reference(
            crate::core::document::DocumentId::new("doc-1").expect("id"),
            crate::core::document::MediaType::Pdf,
            None,
            128,
            "opfs://docs/abc",
        )
        .expect("reference builds");
        let err = ExtractPagesInput::from_document(&reference).expect_err("reference rejected");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn extraction_is_deterministic() {
        let bytes = fixtures::mixed_pages_pdf();
        let first = {
            let mut out = ExtractPagesOperation
                .execute(
                    &ctx(),
                    input(bytes.clone()),
                    ExtractPagesOptions::new(vec![3, 1]),
                )
                .expect("first run")
                .document;
            out.save_to_bytes().expect("serializes")
        };
        let second = {
            let mut out = ExtractPagesOperation
                .execute(&ctx(), input(bytes), ExtractPagesOptions::new(vec![3, 1]))
                .expect("second run")
                .document;
            out.save_to_bytes().expect("serializes")
        };
        assert_eq!(first, second);
    }
}
