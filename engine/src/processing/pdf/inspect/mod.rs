//! `pdf.inspect`: read-only structural inspection of a PDF.
//!
//! Two explicit levels via [`InspectOptions`]: `Basic` returns cheap
//! document-level data (page count, version, encryption, metadata) without
//! touching per-page geometry; `Detailed` adds [`PdfPageInspection`]
//! records. Never modifies the input. No text extraction, no rendering,
//! no image extraction — those are later lessons.

use crate::core::document::{Document, DocumentData};
use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::{Operation, OperationCapabilities, OperationContext};
use crate::processing::pdf::core::{load_pdf, PdfMetadata};

/// Input for [`InspectOperation`]: owned PDF bytes plus an optional label.
///
/// Built from raw bytes or from a core [`Document`] with inline data.
/// Reference-handle documents are rejected: resolving storage handles is
/// an outer-layer concern, not a processing-core one.
#[derive(Debug, Clone)]
pub struct InspectInput {
    /// Raw PDF bytes. Owned so the operation signature stays `'static`;
    /// only borrowed (`&[u8]`) by the loader — never copied again.
    pub data: Vec<u8>,
    /// Optional human-readable label, carried through for diagnostics.
    pub name: Option<String>,
}

impl InspectInput {
    /// Creates input from raw PDF bytes.
    pub fn from_bytes(data: Vec<u8>) -> Result<Self, EngineError> {
        if data.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "inspect input bytes must not be empty",
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
                "inspect requires inline document bytes, not a storage reference",
            )),
        }
    }
}

/// Inspection depth requested by the caller.
///
/// `Basic` is cheap document-level inspection only; `Detailed` adds an
/// explicit per-page sweep. Separate variants (rather than a bool) keep
/// the call site self-describing and leave room for future levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InspectLevel {
    /// Document-level information only: page count, version, encryption
    /// state, metadata. Never iterates pages for geometry.
    #[default]
    Basic,
    /// Everything from [`InspectLevel::Basic`] plus per-page dimensions.
    Detailed,
}

/// Knobs for [`InspectOperation`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InspectOptions {
    /// How deep the inspection goes. Defaults to [`InspectLevel::Basic`]
    /// so a normal request stays lightweight.
    pub level: InspectLevel,
}

impl InspectOptions {
    /// Lightweight document-level inspection (the default).
    #[must_use]
    pub const fn basic() -> Self {
        Self {
            level: InspectLevel::Basic,
        }
    }

    /// Document-level inspection plus per-page geometry.
    #[must_use]
    pub const fn detailed() -> Self {
        Self {
            level: InspectLevel::Detailed,
        }
    }
}

impl Default for InspectOptions {
    fn default() -> Self {
        Self::basic()
    }
}

/// One page's structural information, in explicit PDF points.
#[derive(Debug, Clone, PartialEq)]
pub struct PdfPageInspection {
    /// 1-based page number.
    pub page_number: u32,
    /// Page width in PDF points (1/72 inch).
    pub width_pt: f64,
    /// Page height in PDF points.
    pub height_pt: f64,
    /// Effective rotation in degrees, normalized to `0..360`.
    pub rotation_deg: i32,
}

/// Structured document-level result of `pdf.inspect`.
///
/// Pure data — no formatted text. Presentation (CLI, future TS/WASM) is
/// the caller's job. New document-level fields can be added here without
/// touching the execution engine.
#[derive(Debug, Clone, PartialEq)]
pub struct PdfInspection {
    /// Number of pages.
    pub page_count: u32,
    /// PDF specification version (e.g. `"1.7"`).
    pub pdf_version: String,
    /// `true` when the document was encrypted at load (even if lopdf
    /// transparently decrypted an empty-password file).
    pub encrypted: bool,
    /// Document metadata; absent entries are [`None`], never an error.
    pub metadata: PdfMetadata,
    /// Per-page geometry in document order. Present only for
    /// [`InspectLevel::Detailed`]; [`None`] in basic mode so a normal
    /// request never builds page-detail records.
    pub pages: Option<Vec<PdfPageInspection>>,
}

/// Read-only PDF inspection operation.
#[derive(Debug, Default)]
pub struct InspectOperation;

impl Operation for InspectOperation {
    type Input = InspectInput;
    type Options = InspectOptions;
    type Output = PdfInspection;

    fn name(&self) -> &'static str {
        "pdf.inspect"
    }

    fn capabilities(&self) -> OperationCapabilities {
        // Sequential today; the per-page loop is the natural unit for
        // future sub-task parallelism once baselines exist.
        OperationCapabilities::parallel_friendly()
    }

    fn execute<C: OperationContext>(
        &self,
        ctx: &C,
        input: Self::Input,
        options: Self::Options,
    ) -> Result<Self::Output, EngineError> {
        ctx.report_progress(Some("loading"), 5, 100, Some("loading PDF"));
        ctx.check_cancellation()?;

        let document = load_pdf(&input.data)?;
        ctx.report_progress(Some("parsing"), 15, 100, Some("parsing PDF structure"));
        ctx.check_cancellation()?;

        // Still-encrypted documents need a password, which is a later
        // lesson: fail cleanly instead of returning partial data.
        if document.is_encrypted() {
            return Err(EngineError::new(
                ErrorCode::UnsupportedFormat,
                "PDF is encrypted and requires a password",
            )
            .with_details("password-based decryption is not supported yet"));
        }

        let page_count = document.page_count();
        let pdf_version = document.pdf_version().to_string();
        let encrypted = document.was_encrypted();
        let metadata = document.metadata();

        // Basic mode stops here: no page iteration, no page-detail records.
        let pages = if options.level == InspectLevel::Detailed {
            let mut details = Vec::with_capacity(page_count as usize);
            for (index, page_number) in document.page_numbers().iter().enumerate() {
                ctx.check_cancellation()?;
                let geometry = document.page_geometry(*page_number)?;
                details.push(PdfPageInspection {
                    page_number: *page_number,
                    width_pt: geometry.width_pt,
                    height_pt: geometry.height_pt,
                    rotation_deg: geometry.rotation_deg,
                });
                // Pages occupy the 15–95% band; header work took 0–15%.
                let completed = 15 + ((index + 1) as u64 * 80) / page_count.max(1) as u64;
                ctx.report_progress(
                    Some("inspecting pages"),
                    completed.min(95),
                    100,
                    Some(&format!("page {} of {page_count}", index + 1)),
                );
            }
            Some(details)
        } else {
            None
        };

        ctx.report_progress(Some("completed"), 100, 100, Some("inspection complete"));
        Ok(PdfInspection {
            page_count,
            pdf_version,
            encrypted,
            metadata,
            pages,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::core::fixtures;
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
            "pdf.inspect"
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

    fn input(spec: &fixtures::PdfSpec) -> InspectInput {
        InspectInput::from_bytes(fixtures::build_pdf(spec)).expect("input builds")
    }

    #[test]
    fn detailed_inspection_reports_pages() {
        let spec = fixtures::pdf_spec(
            "1.7",
            vec![
                (612.0, 792.0, None),
                (595.28, 841.89, Some(90)),
                (420.0, 595.0, None),
            ],
            Some(fixtures::InfoSpec {
                title: Some("Report".to_string()),
                producer: Some("folio-test".to_string()),
                ..fixtures::InfoSpec::default()
            }),
        );
        let out = InspectOperation
            .execute(&ctx(), input(&spec), InspectOptions::detailed())
            .expect("inspection succeeds");

        assert_eq!(out.page_count, 3);
        assert_eq!(out.pdf_version, "1.7");
        assert!(!out.encrypted);
        assert_eq!(out.metadata.title.as_deref(), Some("Report"));
        assert_eq!(out.metadata.producer.as_deref(), Some("folio-test"));
        let pages = out.pages.as_ref().expect("detailed mode has pages");
        assert_eq!(pages.len(), 3);
        assert_eq!(pages[0].page_number, 1);
        assert!((pages[0].width_pt - 612.0).abs() < f64::EPSILON);
        assert_eq!(pages[1].rotation_deg, 90);
        assert!((pages[2].height_pt - 595.0).abs() < f64::EPSILON);
        // Page numbers are sequential in document order.
        for (index, page) in pages.iter().enumerate() {
            assert_eq!(page.page_number, index as u32 + 1);
        }
    }

    #[test]
    fn named_single_page_fixture_has_known_dimensions() {
        let out = InspectOperation
            .execute(
                &ctx(),
                InspectInput::from_bytes(fixtures::single_page_pdf()).expect("input builds"),
                InspectOptions::detailed(),
            )
            .expect("inspection succeeds");
        assert_eq!(out.page_count, 1);
        assert_eq!(out.pdf_version, "1.7");
        assert!(!out.encrypted);
        let pages = out.pages.as_ref().expect("detailed mode has pages");
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].page_number, 1);
        assert!((pages[0].width_pt - 612.0).abs() < f64::EPSILON);
        assert!((pages[0].height_pt - 792.0).abs() < f64::EPSILON);
        assert_eq!(pages[0].rotation_deg, 0);
    }

    #[test]
    fn named_mixed_pages_fixture_reports_exact_values() {
        let out = InspectOperation
            .execute(
                &ctx(),
                InspectInput::from_bytes(fixtures::mixed_pages_pdf()).expect("input builds"),
                InspectOptions::detailed(),
            )
            .expect("inspection succeeds");
        assert_eq!(out.page_count, 3);
        assert_eq!(out.metadata.title.as_deref(), Some("Mixed Pages"));
        assert_eq!(
            out.metadata.author.as_deref(),
            Some("folio-engine fixtures")
        );
        let pages = out.pages.as_ref().expect("detailed mode has pages");
        assert_eq!(pages.len(), 3);
        assert!((pages[1].width_pt - 595.0).abs() < f64::EPSILON);
        assert!((pages[1].height_pt - 842.0).abs() < f64::EPSILON);
        assert_eq!(pages[1].rotation_deg, 90);
        assert!((pages[2].width_pt - 420.0).abs() < f64::EPSILON);
        assert!((pages[2].height_pt - 595.0).abs() < f64::EPSILON);
        assert_eq!(pages[2].rotation_deg, 270);
    }

    #[test]
    fn basic_mode_returns_no_page_details() {
        let spec = fixtures::pdf_spec(
            "1.4",
            vec![(612.0, 792.0, None), (595.0, 842.0, None)],
            None,
        );
        // Default options are basic.
        assert_eq!(InspectOptions::default().level, InspectLevel::Basic);
        let out = InspectOperation
            .execute(&ctx(), input(&spec), InspectOptions::default())
            .expect("inspection succeeds");
        assert_eq!(out.page_count, 2);
        assert_eq!(out.pdf_version, "1.4");
        assert!(out.pages.is_none());
    }

    #[test]
    fn locked_pdf_fails_cleanly_with_unsupported_format() {
        let err = InspectOperation
            .execute(
                &ctx(),
                InspectInput::from_bytes(fixtures::build_locked_pdf()).expect("input builds"),
                InspectOptions::default(),
            )
            .expect_err("locked PDF must fail without a password");
        assert_eq!(err.code(), ErrorCode::UnsupportedFormat);
    }

    #[test]
    fn malformed_input_becomes_structured_error() {
        let err = InspectOperation
            .execute(
                &ctx(),
                InspectInput::from_bytes(b"not a pdf".to_vec()).expect("input builds"),
                InspectOptions::default(),
            )
            .expect_err("malformed input must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
    }

    #[test]
    fn rejects_empty_and_reference_inputs() {
        assert!(InspectInput::from_bytes(Vec::new()).is_err());

        let reference = Document::from_reference(
            crate::core::document::DocumentId::new("doc-1").expect("id"),
            crate::core::document::MediaType::Pdf,
            None,
            128,
            "opfs://docs/abc",
        )
        .expect("reference builds");
        let err = InspectInput::from_document(&reference).expect_err("reference rejected");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn accepts_inline_document() {
        let bytes =
            fixtures::build_pdf(&fixtures::pdf_spec("1.4", vec![(612.0, 792.0, None)], None));
        let document = Document::from_bytes(
            crate::core::document::DocumentId::new("doc-1").expect("id"),
            crate::core::document::MediaType::Pdf,
            Some("sample.pdf".to_string()),
            bytes,
        )
        .expect("document builds");
        let input = InspectInput::from_document(&document).expect("inline accepted");
        assert_eq!(input.name.as_deref(), Some("sample.pdf"));
        let out = InspectOperation
            .execute(&ctx(), input, InspectOptions::default())
            .expect("inspection succeeds");
        assert_eq!(out.page_count, 1);
    }

    #[test]
    fn inspection_is_deterministic_and_read_only() {
        let spec = fixtures::pdf_spec("1.5", vec![(612.0, 792.0, Some(270))], None);
        let bytes = fixtures::build_pdf(&spec);
        let options = InspectOptions::detailed();
        let first = InspectOperation
            .execute(&ctx(), input(&spec), options)
            .expect("first run");
        let second = InspectOperation
            .execute(
                &ctx(),
                InspectInput::from_bytes(bytes).expect("input builds"),
                options,
            )
            .expect("second run");
        assert_eq!(first, second);
        assert_eq!(
            first.pages.as_ref().expect("detailed pages")[0].rotation_deg,
            270
        );
    }
}
