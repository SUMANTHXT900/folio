//! `pdf.split`: divide one PDF into multiple independent PDFs.
//!
//! Takes a structured split plan — a list of parts, each a 1-based page
//! selection — and produces one [`PdfDocument`] per part. This is an
//! orchestration operation: every part is built with the shared deep-copy
//! primitive from Lesson 3 (`core::copy`), never a second implementation.
//!
//! Semantics (shared with `pdf.extract_pages`):
//!
//! * Page order inside each part is preserved exactly as requested; no
//!   sorting ever happens.
//! * Duplicates (`[2, 2, 5]`) yield independent copied pages.
//! * Parts may overlap (`[1, 2, 3]` and `[3, 4, 5]`); nothing is
//!   deduplicated globally.
//! * The whole plan is validated before anything is constructed, and
//!   outputs are only returned after every part succeeds (atomicity).
//!
//! Never mutates the input. No range-string parsing in the core, no
//! rendering, no compression, no encryption — those are later lessons.

use crate::core::document::{Document, DocumentData};
use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::{Operation, OperationCapabilities, OperationContext};
use crate::processing::pdf::core::copy::{copy_pages, find_invalid_page};
use crate::processing::pdf::core::{load_pdf, PageNumber, PdfDocument};

/// Input for [`SplitOperation`]: owned PDF bytes plus an optional label.
///
/// Built from raw bytes or from a core [`Document`] with inline data.
/// Reference-handle documents are rejected: resolving storage handles is
/// an outer-layer concern, not a processing-core one.
#[derive(Debug, Clone)]
pub struct SplitInput {
    /// Raw PDF bytes. Owned so the operation signature stays `'static`;
    /// only borrowed (`&[u8]`) downstream — never copied again, never mutated.
    pub data: Vec<u8>,
    /// Optional human-readable label, carried through for diagnostics.
    pub name: Option<String>,
}

impl SplitInput {
    /// Creates input from raw PDF bytes.
    pub fn from_bytes(data: Vec<u8>) -> Result<Self, EngineError> {
        if data.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "split input bytes must not be empty",
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
                "split requires inline document bytes, not a storage reference",
            )),
        }
    }
}

/// One part of a split plan: a 1-based page selection in output order,
/// with an optional human-readable name carried through to the output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitPart {
    /// Selected pages, 1-based, in the exact order they must appear in
    /// this part's output. Duplicates are copied independently per entry.
    pub pages: Vec<PageNumber>,
    /// Optional part name (e.g. `"cover"`). Engine-level metadata only;
    /// the core never interprets it as a filename.
    pub name: Option<String>,
}

impl SplitPart {
    /// Creates an unnamed part from a page selection. Range and emptiness
    /// are checked against the actual document during execution, before
    /// any output is constructed.
    #[must_use]
    pub const fn new(pages: Vec<PageNumber>) -> Self {
        Self { pages, name: None }
    }

    /// Creates a named part from a page selection.
    #[must_use]
    pub fn named(pages: Vec<PageNumber>, name: impl Into<String>) -> Self {
        Self {
            pages,
            name: Some(name.into()),
        }
    }
}

/// Options for [`SplitOperation`]: the structured split plan. No
/// range-string parsing happens here (or anywhere in the core); higher
/// layers produce this list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitOptions {
    /// The parts to produce, in output order. Parts are independent:
    /// overlap between parts is allowed and never deduplicated.
    pub parts: Vec<SplitPart>,
}

impl SplitOptions {
    /// Creates options from a split plan. Plan emptiness, part emptiness,
    /// and page ranges are all validated during execution before any
    /// output is constructed.
    #[must_use]
    pub const fn new(parts: Vec<SplitPart>) -> Self {
        Self { parts }
    }
}

/// One produced part: an independent, self-contained document.
#[derive(Debug)]
pub struct SplitPartOutput {
    /// The part's document. Page *i* corresponds to selection entry *i*
    /// of the part's requested pages.
    pub document: PdfDocument,
    /// The requested part name, if any.
    pub name: Option<String>,
}

/// Output of [`SplitOperation`]: one entry per requested part, in plan
/// order. Only returned after every part has been built successfully.
#[derive(Debug)]
pub struct SplitOutput {
    /// The produced parts, in the same order as the requested plan.
    pub parts: Vec<SplitPartOutput>,
    /// Page count of the input document the parts were split from.
    /// Useful context for consumers and benchmark records.
    pub input_page_count: u32,
}

/// Divides one PDF into multiple independent PDFs via the shared
/// page-copy primitive. Single engine execution, single lifecycle.
#[derive(Debug, Default)]
pub struct SplitOperation;

impl Operation for SplitOperation {
    type Input = SplitInput;
    type Options = SplitOptions;
    type Output = SplitOutput;

    fn name(&self) -> &'static str {
        "pdf.split"
    }

    fn capabilities(&self) -> OperationCapabilities {
        // Sequential today; whole parts (not individual pages) are the
        // natural unit for future bounded parallelism once baselines exist.
        OperationCapabilities::parallel_friendly()
    }

    fn execute<C: OperationContext>(
        &self,
        ctx: &C,
        input: Self::Input,
        options: Self::Options,
    ) -> Result<Self::Output, EngineError> {
        ctx.report_progress(Some("validating"), 5, 100, Some("validating split plan"));
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

        // Validate the ENTIRE plan before constructing anything.
        validate_plan(&source, &options.parts)?;

        // Pages occupy the 10–95% band, counted globally across parts so
        // progress is monotonic over the whole operation.
        let total_pages: usize = options.parts.iter().map(|part| part.pages.len()).sum();
        let mut done_pages: usize = 0;
        let mut outputs = Vec::with_capacity(options.parts.len());

        for (part_index, part) in options.parts.iter().enumerate() {
            ctx.check_cancellation()?;
            let part_number = part_index + 1;
            let part_len = part.pages.len();
            let mut done_in_part: usize = 0;
            let document = copy_pages(&source, &part.pages, |_, _| {
                ctx.check_cancellation()?;
                done_pages += 1;
                done_in_part += 1;
                let completed = 10 + (done_pages as u64 * 85) / total_pages.max(1) as u64;
                ctx.report_progress(
                    Some("splitting"),
                    completed.min(95),
                    100,
                    Some(&format!(
                        "part {part_number} of {}, page {done_in_part} of {part_len}",
                        options.parts.len(),
                    )),
                );
                Ok(())
            })?;
            outputs.push(SplitPartOutput {
                document,
                name: part.name.clone(),
            });
        }

        ctx.check_cancellation()?;
        ctx.report_progress(Some("finalizing"), 100, 100, Some("split complete"));
        Ok(SplitOutput {
            parts: outputs,
            input_page_count: source.page_count(),
        })
    }
}

/// Validates the whole split plan against the document before any output
/// is constructed. Part/entry numbers in messages are 1-based for humans;
/// details carry the same fields in `key=value` form for machines.
fn validate_plan(source: &PdfDocument, parts: &[SplitPart]) -> Result<(), EngineError> {
    if parts.is_empty() {
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            "split plan must contain at least one part",
        ));
    }
    let page_count = source.page_count();
    for (part_index, part) in parts.iter().enumerate() {
        let part_number = part_index + 1;
        if part.pages.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                format!("part {part_number} must contain at least one page"),
            )
            .with_details(format!("part={part_number} page_count={page_count}")));
        }
        if let Some((entry_index, page_number)) = find_invalid_page(source, &part.pages) {
            let entry_number = entry_index + 1;
            return Err(EngineError::new(
                ErrorCode::PageOutOfRange,
                format!(
                    "part {part_number}, page entry {entry_number} references page \
                     {page_number}, but the document contains only {page_count} pages"
                ),
            )
            .with_details(format!(
                "part={part_number} entry={entry_number} page={page_number} \
                 page_count={page_count}"
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
            "pdf.split"
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

    fn input(bytes: Vec<u8>) -> SplitInput {
        SplitInput::from_bytes(bytes).expect("input builds")
    }

    fn plan(part_pages: &[&[PageNumber]]) -> SplitOptions {
        SplitOptions::new(
            part_pages
                .iter()
                .map(|pages| SplitPart::new(pages.to_vec()))
                .collect(),
        )
    }

    /// Runs a split and re-parses every serialized part, returning the
    /// fresh documents for structural assertions.
    fn split_and_reparse(bytes: Vec<u8>, part_pages: &[&[PageNumber]]) -> Vec<PdfDocument> {
        let out = SplitOperation
            .execute(&ctx(), input(bytes), plan(part_pages))
            .expect("split succeeds");
        out.parts
            .into_iter()
            .map(|mut part| {
                let serialized = part.document.save_to_bytes().expect("part serializes");
                load_pdf(&serialized).expect("part re-parses")
            })
            .collect()
    }

    #[test]
    fn splits_into_two_parts() {
        let parts = split_and_reparse(fixtures::mixed_pages_pdf(), &[&[1, 2], &[3]]);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].page_count(), 2);
        assert_eq!(parts[1].page_count(), 1);
        assert_eq!(
            parts[1].page_geometry(1).expect("readable").rotation_deg,
            270
        );
    }

    #[test]
    fn single_part_holding_all_pages() {
        let parts = split_and_reparse(fixtures::mixed_pages_pdf(), &[&[1, 2, 3]]);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].page_count(), 3);
    }

    #[test]
    fn preserves_exact_order_without_sorting() {
        let parts = split_and_reparse(fixtures::mixed_pages_pdf(), &[&[3, 1], &[2]]);
        assert_eq!(parts.len(), 2);
        // Part 1 must be [420x595-rot270, Letter], not sorted.
        assert!((parts[0].page_geometry(1).expect("p1").width_pt - 420.0).abs() < f64::EPSILON);
        assert!((parts[0].page_geometry(2).expect("p2").width_pt - 612.0).abs() < f64::EPSILON);
        assert_eq!(parts[1].page_geometry(1).expect("p1").rotation_deg, 90);
    }

    #[test]
    fn duplicates_within_and_across_parts() {
        let parts = split_and_reparse(fixtures::mixed_pages_pdf(), &[&[2, 2, 1], &[1, 1]]);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].page_count(), 3);
        assert_eq!(parts[1].page_count(), 2);
    }

    #[test]
    fn overlapping_parts_share_source_pages() {
        let parts = split_and_reparse(fixtures::five_page_pdf(), &[&[1, 2, 3], &[3, 4, 5]]);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].page_count(), 3);
        assert_eq!(parts[1].page_count(), 3);
        // Source page 3 (420-wide, rot270) closes part 1 and opens part 2.
        assert!((parts[0].page_geometry(3).expect("p3").width_pt - 420.0).abs() < f64::EPSILON);
        assert_eq!(parts[0].page_geometry(3).expect("p3").rotation_deg, 270);
        assert!((parts[1].page_geometry(1).expect("p1").width_pt - 420.0).abs() < f64::EPSILON);
        assert_eq!(parts[1].page_geometry(1).expect("p1").rotation_deg, 270);
        // Part 2 ends with the 500-wide page 5.
        assert!((parts[1].page_geometry(3).expect("p3").width_pt - 500.0).abs() < f64::EPSILON);
        for part in &parts {
            for n in 1..=part.page_count() {
                part.page_geometry(n).expect("readable");
            }
        }
    }

    #[test]
    fn carries_part_names_through() {
        let out = SplitOperation
            .execute(
                &ctx(),
                input(fixtures::single_page_pdf()),
                SplitOptions::new(vec![
                    SplitPart::named(vec![1], "cover"),
                    SplitPart::new(vec![1]),
                ]),
            )
            .expect("split succeeds");
        assert_eq!(out.parts.len(), 2);
        assert_eq!(out.parts[0].name.as_deref(), Some("cover"));
        assert_eq!(out.parts[1].name, None);
    }

    #[test]
    fn rejects_empty_plan() {
        let err = SplitOperation
            .execute(&ctx(), input(fixtures::single_page_pdf()), plan(&[]))
            .expect_err("empty plan must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn rejects_empty_part() {
        let err = SplitOperation
            .execute(
                &ctx(),
                input(fixtures::mixed_pages_pdf()),
                plan(&[&[1, 2], &[]]),
            )
            .expect_err("empty part must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
        assert!(err.message().contains("part 2"));
    }

    #[test]
    fn rejects_page_zero() {
        let err = SplitOperation
            .execute(&ctx(), input(fixtures::single_page_pdf()), plan(&[&[0, 1]]))
            .expect_err("zero must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert!(err.message().contains("part 1"));
    }

    #[test]
    fn rejects_out_of_range_page_with_location() {
        let err = SplitOperation
            .execute(
                &ctx(),
                input(fixtures::mixed_pages_pdf()),
                plan(&[&[1], &[2, 999_999]]),
            )
            .expect_err("out of range must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert!(err.message().contains("part 2"));
        assert!(err.message().contains("999999"));
        assert!(err.message().contains("3 pages"));
        let details = err.details().expect("structured details");
        assert!(details.contains("part=2"));
        assert!(details.contains("page=999999"));
        assert!(details.contains("page_count=3"));
    }

    #[test]
    fn rejects_multiple_invalid_references() {
        let err = SplitOperation
            .execute(
                &ctx(),
                input(fixtures::single_page_pdf()),
                plan(&[&[1], &[2], &[99]]),
            )
            .expect_err("invalid refs must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        // First failure wins: part 2.
        assert!(err.message().contains("part 2"));
    }

    #[test]
    fn malformed_input_fails_cleanly() {
        let err = SplitOperation
            .execute(&ctx(), input(b"not a pdf".to_vec()), plan(&[&[1]]))
            .expect_err("malformed must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
    }

    #[test]
    fn locked_pdf_fails_cleanly() {
        let err = SplitOperation
            .execute(&ctx(), input(fixtures::build_locked_pdf()), plan(&[&[1]]))
            .expect_err("locked must fail");
        assert_eq!(err.code(), ErrorCode::UnsupportedFormat);
    }

    #[test]
    fn rejects_empty_and_reference_inputs() {
        assert!(SplitInput::from_bytes(Vec::new()).is_err());

        let reference = Document::from_reference(
            crate::core::document::DocumentId::new("doc-1").expect("id"),
            crate::core::document::MediaType::Pdf,
            None,
            128,
            "opfs://docs/abc",
        )
        .expect("reference builds");
        let err = SplitInput::from_document(&reference).expect_err("reference rejected");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn split_is_deterministic() {
        let bytes = fixtures::mixed_pages_pdf();
        let run = || {
            let out = SplitOperation
                .execute(&ctx(), input(bytes.clone()), plan(&[&[3, 1], &[2, 2]]))
                .expect("run succeeds");
            out.parts
                .into_iter()
                .map(|mut part| part.document.save_to_bytes().expect("serializes"))
                .collect::<Vec<_>>()
        };
        assert_eq!(run(), run());
    }
}
