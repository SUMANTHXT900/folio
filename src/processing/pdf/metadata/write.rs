//! `pdf.set_metadata`: patch supported Info-dictionary fields.
//!
//! Parses the input once, validates the whole patch, then mutates only
//! the patched keys on the live Info dictionary ([`PdfDocument`]) and
//! returns the output document for serialization. Unpatched keys —
//! including malformed raw values, custom keys, and every non-Info
//! structure (pages, XMP streams, outlines, …) — are never touched, so
//! unrelated content is preserved by construction rather than by copying.
//!
//! Atomicity: all validation completes before any mutation, and mutation
//! happens on the in-memory document only. Any failure returns `Err`
//! with no output document; the caller's input bytes are never modified.

use crate::core::document::{Document, DocumentData};
use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::{Operation, OperationCapabilities, OperationContext};
use crate::processing::pdf::core::{load_pdf, PdfDocument};

use super::model::{FieldPatch, MetadataPatch};

/// Input for [`SetMetadataOperation`]: owned PDF bytes plus an optional label.
#[derive(Debug, Clone)]
pub struct SetMetadataInput {
    /// Raw PDF bytes. Owned so the operation signature stays `'static`;
    /// only borrowed (`&[u8]`) by the loader — never copied again, never mutated.
    pub data: Vec<u8>,
    /// Optional human-readable label, carried through for diagnostics.
    pub name: Option<String>,
}

impl SetMetadataInput {
    /// Creates input from raw PDF bytes.
    pub fn from_bytes(data: Vec<u8>) -> Result<Self, EngineError> {
        if data.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "set_metadata input bytes must not be empty",
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
                "set_metadata requires inline document bytes, not a storage reference",
            )),
        }
    }
}

/// Options for [`SetMetadataOperation`]: the metadata patch to apply.
/// Each field is independently set, cleared, or left unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetMetadataOptions {
    /// The patch. An all-unchanged patch is a valid no-op rewrite.
    pub patch: MetadataPatch,
}

impl SetMetadataOptions {
    /// Creates options from a patch. Value validation happens during
    /// execution, before anything is mutated.
    #[must_use]
    pub fn new(patch: MetadataPatch) -> Self {
        Self { patch }
    }
}

/// Output of [`SetMetadataOperation`]: the patched document.
///
/// Holds the parsed result so it can be inspected further or serialized
/// via [`PdfDocument::save_to_bytes`] for file output / WASM transfer.
#[derive(Debug)]
pub struct SetMetadataOutput {
    /// The output document with patched metadata.
    pub document: PdfDocument,
    /// Page count of the output document (always equals the input page
    /// count — metadata edits never add or remove pages).
    pub page_count: u32,
}

/// Metadata patch operation: single engine execution, single lifecycle.
#[derive(Debug, Default)]
pub struct SetMetadataOperation;

impl Operation for SetMetadataOperation {
    type Input = SetMetadataInput;
    type Options = SetMetadataOptions;
    type Output = SetMetadataOutput;

    fn name(&self) -> &'static str {
        "pdf.set_metadata"
    }

    fn capabilities(&self) -> OperationCapabilities {
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
            Some("validating metadata patch"),
        );
        ctx.check_cancellation()?;
        validate_patch_values(&options.patch)?;

        let mut document = load_pdf(&input.data)?;
        ctx.report_progress(Some("loading"), 15, 100, Some("parsing PDF structure"));
        ctx.check_cancellation()?;

        if document.is_encrypted() {
            return Err(EngineError::new(
                ErrorCode::UnsupportedFormat,
                "PDF is encrypted and requires a password",
            )
            .with_details("password-based decryption is not supported yet"));
        }

        ctx.report_progress(Some("applying"), 50, 100, Some("applying metadata patch"));
        ctx.check_cancellation()?;
        document.apply_metadata_patch(&options.patch)?;

        ctx.check_cancellation()?;
        ctx.report_progress(Some("finalizing"), 90, 100, Some("metadata write complete"));
        let page_count = document.page_count();
        ctx.report_progress(Some("completed"), 100, 100, Some("set_metadata complete"));
        Ok(SetMetadataOutput {
            document,
            page_count,
        })
    }
}

/// Validates patch *values* before anything is mutated (atomicity: a bad
/// value fails the whole operation with no output). Empty set-values are
/// rejected — clearing is what [`FieldPatch::Clear`] is for, so `Set("")`
/// is almost certainly a caller mistake, never silently written.
fn validate_patch_values(patch: &MetadataPatch) -> Result<(), EngineError> {
    let strings: [(&str, &FieldPatch<String>); 6] = [
        ("title", &patch.title),
        ("author", &patch.author),
        ("subject", &patch.subject),
        ("keywords", &patch.keywords),
        ("creator", &patch.creator),
        ("producer", &patch.producer),
    ];
    for (field, value) in strings {
        if let FieldPatch::Set(text) = value {
            if text.is_empty() {
                return Err(EngineError::new(
                    ErrorCode::InvalidInput,
                    format!("metadata field {field} cannot be set to an empty string (use Clear)"),
                )
                .with_details(format!("field={field}")));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::super::core::fixtures;
    use super::super::date::PdfDate;
    use super::super::model::DocumentMetadata;
    use super::*;
    use crate::execution::job::JobId;
    use crate::processing::pdf::core::loader::load_pdf;

    struct NullCtx {
        id: JobId,
    }

    impl OperationContext for NullCtx {
        fn job_id(&self) -> &JobId {
            &self.id
        }
        fn operation_name(&self) -> &str {
            "pdf.set_metadata"
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

    fn input(bytes: Vec<u8>) -> SetMetadataInput {
        SetMetadataInput::from_bytes(bytes).expect("input builds")
    }

    /// Applies a patch and re-parses the serialized output, proving the
    /// result is a valid, self-contained PDF.
    fn set_and_reparse(bytes: Vec<u8>, patch: MetadataPatch) -> PdfDocument {
        let mut out = SetMetadataOperation
            .execute(&ctx(), input(bytes), SetMetadataOptions::new(patch))
            .expect("patch succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("output serializes");
        load_pdf(&serialized).expect("output re-parses")
    }

    fn read_metadata(doc: &PdfDocument) -> DocumentMetadata {
        DocumentMetadata::from_raw(&doc.metadata())
    }

    #[test]
    fn sets_fields_on_a_document_without_metadata() {
        let patch = MetadataPatch {
            title: FieldPatch::Set("New Title".to_string()),
            author: FieldPatch::Set("Ada".to_string()),
            ..MetadataPatch::default()
        };
        let reparsed = set_and_reparse(fixtures::single_page_pdf(), patch);
        let meta = read_metadata(&reparsed);
        assert_eq!(meta.title.as_deref(), Some("New Title"));
        assert_eq!(meta.author.as_deref(), Some("Ada"));
        assert_eq!(meta.subject, None);
        assert_eq!(reparsed.page_count(), 1);
        assert_eq!(reparsed.pdf_version(), "1.7");
    }

    #[test]
    fn clears_fields_without_leaving_empty_strings() {
        let patch = MetadataPatch {
            title: FieldPatch::Clear,
            author: FieldPatch::Clear,
            ..MetadataPatch::default()
        };
        let reparsed = set_and_reparse(fixtures::mixed_pages_pdf(), patch);
        let meta = read_metadata(&reparsed);
        assert_eq!(meta.title, None);
        assert_eq!(meta.author, None);
        // Raw Info dict carries no empty-string residue.
        let raw = reparsed.metadata();
        assert_eq!(raw.title, None);
        assert_eq!(raw.author, None);
    }

    #[test]
    fn mixed_set_clear_and_unchanged() {
        let patch = MetadataPatch {
            title: FieldPatch::Set("Kept Fresh".to_string()),
            author: FieldPatch::Clear,
            ..MetadataPatch::default()
        };
        let reparsed = set_and_reparse(fixtures::mixed_pages_pdf(), patch);
        let meta = read_metadata(&reparsed);
        assert_eq!(meta.title.as_deref(), Some("Kept Fresh"));
        assert_eq!(meta.author, None);
    }

    #[test]
    fn sets_and_round_trips_dates() {
        let created = PdfDate::new(2026, 1, 23, 9, 30, 0, 330).expect("valid date");
        let patch = MetadataPatch {
            creation_date: FieldPatch::Set(created),
            ..MetadataPatch::default()
        };
        let reparsed = set_and_reparse(fixtures::single_page_pdf(), patch);
        assert_eq!(read_metadata(&reparsed).creation_date, Some(created));
    }

    #[test]
    fn rejects_empty_set_values() {
        let patch = MetadataPatch {
            title: FieldPatch::Set(String::new()),
            ..MetadataPatch::default()
        };
        let err = SetMetadataOperation
            .execute(
                &ctx(),
                input(fixtures::single_page_pdf()),
                SetMetadataOptions::new(patch),
            )
            .expect_err("empty set must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
        assert!(err.message().contains("title"));
    }

    #[test]
    fn malformed_input_fails_cleanly() {
        let err = SetMetadataOperation
            .execute(
                &ctx(),
                input(b"not a pdf".to_vec()),
                SetMetadataOptions::new(MetadataPatch::default()),
            )
            .expect_err("malformed must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
    }

    #[test]
    fn locked_pdf_fails_cleanly() {
        let err = SetMetadataOperation
            .execute(
                &ctx(),
                input(fixtures::build_locked_pdf()),
                SetMetadataOptions::new(MetadataPatch::default()),
            )
            .expect_err("locked must fail");
        assert_eq!(err.code(), ErrorCode::UnsupportedFormat);
    }

    #[test]
    fn unicode_values_round_trip() {
        // Accented Latin, Telugu, Hindi, CJK, and emoji (surrogate pairs).
        let patch = MetadataPatch {
            title: FieldPatch::Set("Tést — tëst".to_string()),
            author: FieldPatch::Set("తెలుగు రచయిత".to_string()),
            subject: FieldPatch::Set("हिन्दी विषय".to_string()),
            keywords: FieldPatch::Set("中文测试, キーワード".to_string()),
            creator: FieldPatch::Set("🎉 folio-maker 📄".to_string()),
            producer: FieldPatch::Set("Café Münchner Kindl — 中文".to_string()),
            ..MetadataPatch::default()
        };
        let reparsed = set_and_reparse(fixtures::single_page_pdf(), patch);
        let meta = read_metadata(&reparsed);
        assert_eq!(meta.title.as_deref(), Some("Tést — tëst"));
        assert_eq!(meta.author.as_deref(), Some("తెలుగు రచయిత"));
        assert_eq!(meta.subject.as_deref(), Some("हिन्दी विषय"));
        assert_eq!(meta.keywords.as_deref(), Some("中文测试, キーワード"));
        assert_eq!(meta.creator.as_deref(), Some("🎉 folio-maker 📄"));
        assert_eq!(meta.producer.as_deref(), Some("Café Münchner Kindl — 中文"));
    }

    #[test]
    fn xmp_stream_survives_info_edits_byte_identical() {
        let bytes = fixtures::xmp_metadata_pdf();
        let before = fixtures::catalog_xmp_bytes(&bytes).expect("fixture carries XMP");
        let patch = MetadataPatch {
            title: FieldPatch::Set("Retitled".to_string()),
            author: FieldPatch::Set("Someone".to_string()),
            ..MetadataPatch::default()
        };
        let reparsed = set_and_reparse(bytes, patch);
        let meta = read_metadata(&reparsed);
        assert_eq!(meta.title.as_deref(), Some("Retitled"));
        assert_eq!(meta.author.as_deref(), Some("Someone"));
        // XMP is preserved without an XMP editing subsystem — and untouched.
        let mut out = SetMetadataOperation
            .execute(
                &ctx(),
                input(fixtures::xmp_metadata_pdf()),
                SetMetadataOptions::new(MetadataPatch {
                    title: FieldPatch::Set("Retitled".to_string()),
                    ..MetadataPatch::default()
                }),
            )
            .expect("patch succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("serializes");
        assert_eq!(
            fixtures::catalog_xmp_bytes(&serialized),
            Some(before),
            "XMP stream bytes must survive metadata edits"
        );
    }

    #[test]
    fn unrelated_structure_is_preserved() {
        let patch = MetadataPatch {
            title: FieldPatch::Set("T".to_string()),
            subject: FieldPatch::Set("S".to_string()),
            keywords: FieldPatch::Set("K".to_string()),
            creator: FieldPatch::Set("C".to_string()),
            producer: FieldPatch::Set("P".to_string()),
            creation_date: FieldPatch::Set(
                PdfDate::new(2026, 1, 1, 0, 0, 0, 0).expect("valid date"),
            ),
            ..MetadataPatch::default()
        };
        let source = load_pdf(&fixtures::mixed_pages_pdf()).expect("source parses");
        let reparsed = set_and_reparse(fixtures::mixed_pages_pdf(), patch);
        assert_eq!(reparsed.page_count(), source.page_count());
        assert_eq!(reparsed.pdf_version(), source.pdf_version());
        for n in 1..=source.page_count() {
            let before = source.page_geometry(n).expect("source geometry");
            let after = reparsed.page_geometry(n).expect("output geometry");
            assert!((before.width_pt - after.width_pt).abs() < f64::EPSILON);
            assert!((before.height_pt - after.height_pt).abs() < f64::EPSILON);
            assert_eq!(
                source.effective_rotation(n).expect("source rotation"),
                reparsed.effective_rotation(n).expect("output rotation")
            );
        }
    }

    #[test]
    fn empty_patch_is_a_noop_rewrite() {
        // No Info dictionary: nothing to create, output still valid.
        let reparsed = set_and_reparse(fixtures::single_page_pdf(), MetadataPatch::default());
        assert_eq!(read_metadata(&reparsed), DocumentMetadata::default());
        assert_eq!(reparsed.page_count(), 1);
        // Existing Info: nothing changes.
        let reparsed = set_and_reparse(fixtures::mixed_pages_pdf(), MetadataPatch::default());
        let meta = read_metadata(&reparsed);
        assert_eq!(meta.title.as_deref(), Some("Mixed Pages"));
        assert_eq!(meta.author.as_deref(), Some("folio-engine fixtures"));
    }

    #[test]
    fn direct_inline_info_dictionary_is_supported() {
        let bytes = fixtures::mixed_pages_pdf();
        let mut raw = lopdf::Document::load_mem(&bytes).expect("fixture parses");
        // Inline the Info dictionary directly into the trailer (no reference).
        let info_obj = raw.trailer.remove(b"Info").expect("fixture has Info");
        let (_, resolved) = raw.dereference(&info_obj).expect("Info resolves");
        let inline = resolved.clone();
        raw.trailer.set("Info", inline);
        let mut inline_bytes = Vec::new();
        raw.save_to(&mut inline_bytes)
            .expect("inline fixture serializes");

        let patch = MetadataPatch {
            title: FieldPatch::Set("Inline Updated".to_string()),
            ..MetadataPatch::default()
        };
        let reparsed = set_and_reparse(inline_bytes, patch);
        assert_eq!(
            read_metadata(&reparsed).title.as_deref(),
            Some("Inline Updated")
        );
    }

    #[test]
    fn non_dictionary_info_fails_as_invalid_document() {
        let bytes = fixtures::single_page_pdf();
        let mut raw = lopdf::Document::load_mem(&bytes).expect("fixture parses");
        raw.trailer.set("Info", lopdf::Object::Integer(42));
        let mut corrupt = Vec::new();
        raw.save_to(&mut corrupt)
            .expect("corrupt fixture serializes");

        let patch = MetadataPatch {
            title: FieldPatch::Set("T".to_string()),
            ..MetadataPatch::default()
        };
        let mut document = load_pdf(&corrupt).expect("corrupt file still parses");
        let err = document
            .apply_metadata_patch(&patch)
            .expect_err("non-dict Info must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
    }
}
