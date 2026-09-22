//! `pdf.read_metadata`: read-only metadata inspection.
//!
//! Returns the authoritative editable [`DocumentMetadata`] (typed dates)
//! plus the page count, following the standard operation pattern
//! (`Input + Options -> Output` through [`Operation`]). Still-encrypted
//! documents fail as `UnsupportedFormat`, exactly like `pdf.inspect`.
//! Malformed metadata never fails the read: unrepresentable values
//! normalize to [`None`] fields (see [`DocumentMetadata::from_raw`]).

use crate::core::document::{Document, DocumentData};
use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::{Operation, OperationCapabilities, OperationContext};
use crate::processing::pdf::core::load_pdf;

use super::model::DocumentMetadata;

/// Input for [`ReadMetadataOperation`]: owned PDF bytes plus an optional label.
#[derive(Debug, Clone)]
pub struct ReadMetadataInput {
    /// Raw PDF bytes. Owned so the operation signature stays `'static`;
    /// only borrowed (`&[u8]`) by the loader — never copied again.
    pub data: Vec<u8>,
    /// Optional human-readable label, carried through for diagnostics.
    pub name: Option<String>,
}

impl ReadMetadataInput {
    /// Creates input from raw PDF bytes.
    pub fn from_bytes(data: Vec<u8>) -> Result<Self, EngineError> {
        if data.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "read_metadata input bytes must not be empty",
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
                "read_metadata requires inline document bytes, not a storage reference",
            )),
        }
    }
}

/// Knobs for [`ReadMetadataOperation`]. Empty today (the read is total —
/// every supported field is always returned); a struct so future knobs
/// extend without signature churn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReadMetadataOptions;

impl ReadMetadataOptions {
    /// Creates the (only) read configuration.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

/// Output of [`ReadMetadataOperation`]: the normalized metadata plus the
/// page count (handy for callers verifying the document they read).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadMetadataOutput {
    /// Authoritative editable metadata (typed dates).
    pub metadata: DocumentMetadata,
    /// Number of pages in the inspected document.
    pub page_count: u32,
}

/// Read-only metadata inspection operation.
#[derive(Debug, Default)]
pub struct ReadMetadataOperation;

impl Operation for ReadMetadataOperation {
    type Input = ReadMetadataInput;
    type Options = ReadMetadataOptions;
    type Output = ReadMetadataOutput;

    fn name(&self) -> &'static str {
        "pdf.read_metadata"
    }

    fn capabilities(&self) -> OperationCapabilities {
        OperationCapabilities::parallel_friendly()
    }

    fn execute<C: OperationContext>(
        &self,
        ctx: &C,
        input: Self::Input,
        _options: Self::Options,
    ) -> Result<Self::Output, EngineError> {
        ctx.report_progress(Some("validating"), 5, 100, Some("validating request"));
        ctx.check_cancellation()?;

        let document = load_pdf(&input.data)?;
        ctx.report_progress(Some("loading"), 15, 100, Some("parsing PDF structure"));
        ctx.check_cancellation()?;

        if document.is_encrypted() {
            return Err(EngineError::new(
                ErrorCode::UnsupportedFormat,
                "PDF is encrypted and requires a password",
            )
            .with_details("password-based decryption is not supported yet"));
        }

        let metadata = DocumentMetadata::from_raw(&document.metadata());
        let page_count = document.page_count();
        ctx.report_progress(Some("reading"), 50, 100, Some("reading metadata"));
        ctx.check_cancellation()?;

        ctx.report_progress(Some("completed"), 100, 100, Some("metadata read complete"));
        Ok(ReadMetadataOutput {
            metadata,
            page_count,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::core::fixtures;
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
            "pdf.read_metadata"
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

    #[test]
    fn reads_full_metadata_with_typed_dates() {
        let bytes = fixtures::build_pdf(&fixtures::pdf_spec(
            "1.7",
            vec![(612.0, 792.0, None)],
            Some(fixtures::InfoSpec {
                title: Some("Report".to_string()),
                author: Some("Engine".to_string()),
                subject: Some("S".to_string()),
                keywords: Some("k1, k2".to_string()),
                creator: Some("CreateApp".to_string()),
                producer: Some("MakeApp".to_string()),
                creation_date: Some("D:20260123093000+05'30'".to_string()),
                modification_date: Some("D:20200101000000Z".to_string()),
            }),
        ));
        let out = ReadMetadataOperation
            .execute(
                &ctx(),
                ReadMetadataInput::from_bytes(bytes).expect("input builds"),
                ReadMetadataOptions::new(),
            )
            .expect("read succeeds");
        assert_eq!(out.page_count, 1);
        assert_eq!(out.metadata.title.as_deref(), Some("Report"));
        assert_eq!(out.metadata.keywords.as_deref(), Some("k1, k2"));
        assert_eq!(out.metadata.creator.as_deref(), Some("CreateApp"));
        let created = out.metadata.creation_date.expect("typed creation date");
        assert_eq!((created.year, created.month, created.day), (2026, 1, 23));
        assert_eq!(created.tz_offset_minutes, 330);
        let modified = out.metadata.modification_date.expect("typed mod date");
        assert_eq!(modified.tz_offset_minutes, 0);
    }

    #[test]
    fn missing_metadata_reads_as_none() {
        let out = ReadMetadataOperation
            .execute(
                &ctx(),
                ReadMetadataInput::from_bytes(fixtures::single_page_pdf()).expect("input builds"),
                ReadMetadataOptions::new(),
            )
            .expect("read succeeds");
        assert_eq!(out.metadata, DocumentMetadata::default());
    }

    #[test]
    fn malformed_input_fails_cleanly() {
        let err = ReadMetadataOperation
            .execute(
                &ctx(),
                ReadMetadataInput::from_bytes(b"not a pdf".to_vec()).expect("input builds"),
                ReadMetadataOptions::new(),
            )
            .expect_err("malformed input must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
    }

    #[test]
    fn locked_pdf_fails_cleanly() {
        let err = ReadMetadataOperation
            .execute(
                &ctx(),
                ReadMetadataInput::from_bytes(fixtures::build_locked_pdf()).expect("input builds"),
                ReadMetadataOptions::new(),
            )
            .expect_err("locked PDF must fail without a password");
        assert_eq!(err.code(), ErrorCode::UnsupportedFormat);
    }
}
