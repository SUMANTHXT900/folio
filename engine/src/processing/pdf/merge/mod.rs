//! `pdf.merge`: combine multiple PDFs into one PDF, in order.
//!
//! Takes already-parsed [`PdfDocument`] inputs and produces a new
//! [`PdfDocument`] containing every source page exactly once, document
//! after document. This is an orchestration operation: all page copying
//! goes through the shared cross-document primitive
//! (`core::copy::merge_documents`), never a second implementation.
//!
//! Semantics:
//!
//! * Input order is significant and preserved; nothing is sorted,
//!   deduplicated, or reordered — not even identical inputs.
//! * At least one input document is required; at least one input page
//!   across all documents is required (no zero-page output).
//! * Empty source documents contribute zero pages without breaking the
//!   merge, as long as some other input provides pages.
//! * The whole input collection is validated before anything is
//!   constructed, and the output is returned only after every document
//!   succeeds (atomicity).
//!
//! Never mutates the inputs. No range-string parsing in the core, no
//! filesystem paths in the core, no rendering, no compression, no
//! encryption — those are later lessons.

use crate::core::document::{Document, DocumentData};
use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::{Operation, OperationCapabilities, OperationContext};
use crate::processing::pdf::core::copy::merge_documents;
use crate::processing::pdf::core::PdfDocument;

/// Input for [`MergeOperation`]: already-parsed documents plus an optional
/// label.
///
/// Parsing bytes into [`PdfDocument`] happens outside the operation (via
/// the public loader), so malformed files fail before an input can even
/// be formed; the operation itself validates the collection.
#[derive(Debug)]
pub struct MergeInput {
    /// Source documents in merge order. Each entry is used read-only and
    /// never mutated, deduplicated, or reordered.
    pub documents: Vec<PdfDocument>,
    /// Optional human-readable label, carried through for diagnostics.
    pub name: Option<String>,
}

impl MergeInput {
    /// Creates input from parsed documents.
    #[must_use]
    pub fn new(documents: Vec<PdfDocument>) -> Self {
        Self {
            documents,
            name: None,
        }
    }

    /// Creates input from a core [`Document`] holding inline bytes.
    ///
    /// Only single-document input can be built this way; multi-document
    /// callers parse each file and use [`MergeInput::new`].
    pub fn from_document(document: &Document) -> Result<Self, EngineError> {
        match document.data() {
            DocumentData::Inline(bytes) => Ok(Self {
                documents: vec![load_single(bytes)?],
                name: document.name().map(str::to_string),
            }),
            DocumentData::Reference(_) => Err(EngineError::new(
                ErrorCode::InvalidInput,
                "merge requires inline document bytes, not a storage reference",
            )),
        }
    }
}

/// Options for [`MergeOperation`]. Currently no knobs exist; the struct
/// preserves the `Input + Options` operation shape for future extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MergeOptions {}

impl MergeOptions {
    /// Creates default merge options.
    #[must_use]
    pub const fn new() -> Self {
        Self {}
    }
}

/// Output of [`MergeOperation`]: the merged document plus counts.
///
/// Holds the parsed result so it can be inspected further, passed to
/// another operation, or serialized via [`PdfDocument::save_to_bytes`]
/// for file output / WASM transfer.
#[derive(Debug)]
pub struct MergeOutput {
    /// The merged document, containing every source page exactly once.
    pub document: PdfDocument,
    /// Number of input documents.
    pub input_document_count: u32,
    /// Total pages across all inputs.
    pub input_page_count: u32,
    /// Pages in the output (always equals the input total).
    pub output_page_count: u32,
}

/// Merges parsed PDFs via the shared cross-document copy primitive.
/// Single engine execution, single lifecycle.
#[derive(Debug, Default)]
pub struct MergeOperation;

impl Operation for MergeOperation {
    type Input = MergeInput;
    type Options = MergeOptions;
    type Output = MergeOutput;

    fn name(&self) -> &'static str {
        "pdf.merge"
    }

    fn capabilities(&self) -> OperationCapabilities {
        // Sequential today; whole source documents are the natural unit
        // for future bounded parallelism once baselines exist.
        OperationCapabilities::parallel_friendly()
    }

    fn execute<C: OperationContext>(
        &self,
        ctx: &C,
        input: Self::Input,
        _options: Self::Options,
    ) -> Result<Self::Output, EngineError> {
        ctx.report_progress(Some("validating"), 5, 100, Some("validating merge inputs"));
        ctx.check_cancellation()?;

        if input.documents.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "merge requires at least one input document",
            )
            .with_details("input_document_count=0"));
        }
        // Locked documents cannot contribute readable pages; fail the
        // whole merge rather than silently skipping one.
        for (doc_index, document) in input.documents.iter().enumerate() {
            if document.is_encrypted() {
                return Err(EngineError::new(
                    ErrorCode::UnsupportedFormat,
                    format!(
                        "input document {} is encrypted and requires a password",
                        doc_index + 1,
                    ),
                )
                .with_details(format!(
                    "document_index={} page_count={} \
                     password-based decryption is not supported yet",
                    doc_index,
                    document.page_count(),
                )));
            }
        }
        let input_page_count: u32 = input.documents.iter().map(PdfDocument::page_count).sum();
        if input_page_count == 0 {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "merge input documents contain no pages; at least one input page is required",
            )
            .with_details(format!(
                "input_document_count={} input_page_count=0",
                input.documents.len(),
            )));
        }

        ctx.report_progress(Some("preparing"), 10, 100, Some("preparing destination"));
        ctx.check_cancellation()?;

        // Copied pages occupy the 10–95% band, counted globally so
        // progress never resets between input documents.
        let total = u64::from(input_page_count);
        let mut done: u64 = 0;
        let sources: Vec<&PdfDocument> = input.documents.iter().collect();
        let document = merge_documents(&sources, |progress| {
            ctx.check_cancellation()?;
            done += 1;
            let completed = 10 + (done * 85) / total.max(1);
            ctx.report_progress(
                Some("merging"),
                completed.min(95),
                100,
                Some(&format!(
                    "document {} of {}, page {} of {}",
                    progress.doc_index + 1,
                    progress.doc_count,
                    progress.page_done,
                    progress.page_total,
                )),
            );
            Ok(())
        })?;

        ctx.check_cancellation()?;
        ctx.report_progress(Some("finalizing"), 100, 100, Some("merge complete"));
        let output_page_count = document.page_count();
        Ok(MergeOutput {
            document,
            input_document_count: input.documents.len() as u32,
            input_page_count,
            output_page_count,
        })
    }
}

/// Parses one document's bytes. Kept separate so input-construction
/// failures stay attributable to this operation's input layer.
fn load_single(bytes: &[u8]) -> Result<PdfDocument, EngineError> {
    crate::processing::pdf::core::loader::load_pdf(bytes)
}

#[cfg(test)]
mod tests {
    use super::super::core::fixtures;
    use super::super::core::loader::load_pdf;
    use super::*;
    use crate::execution::job::JobId;
    use lopdf::dictionary;

    struct NullCtx {
        id: JobId,
    }

    impl OperationContext for NullCtx {
        fn job_id(&self) -> &JobId {
            &self.id
        }
        fn operation_name(&self) -> &str {
            "pdf.merge"
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
            "pdf.merge"
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
            Err(EngineError::cancelled(&self.id, "pdf.merge"))
        }
    }

    fn ctx() -> NullCtx {
        NullCtx { id: JobId::new() }
    }

    fn doc(bytes: Vec<u8>) -> PdfDocument {
        load_pdf(&bytes).expect("fixture loads")
    }

    fn input(docs: Vec<PdfDocument>) -> MergeInput {
        MergeInput::new(docs)
    }

    /// Merges through the operation and re-parses the serialized output,
    /// returning the fresh document for structural assertions.
    fn merge_and_reparse(docs: Vec<PdfDocument>) -> PdfDocument {
        let mut out = MergeOperation
            .execute(&ctx(), input(docs), MergeOptions::new())
            .expect("merge succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("output serializes");
        load_pdf(&serialized).expect("output re-parses")
    }

    #[test]
    fn rejects_empty_input() {
        let err = MergeOperation
            .execute(&ctx(), input(vec![]), MergeOptions::new())
            .expect_err("empty must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
        assert!(err.message().contains("at least one input document"));
    }

    #[test]
    fn merges_single_document_as_independent_copy() {
        let bytes = fixtures::mixed_pages_pdf();
        let before = bytes.clone();
        let reparsed = merge_and_reparse(vec![doc(bytes.clone())]);
        assert_eq!(reparsed.page_count(), 3);
        assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 90);
        // Independence: rotating the output leaves the source untouched.
        let mut owned = reparsed;
        owned.set_page_rotation(1, 180).expect("rotation applies");
        assert_eq!(owned.effective_rotation(1).expect("rotation reads"), 180);
        let source = load_pdf(&before).expect("source re-parses");
        assert_eq!(source.effective_rotation(1).expect("rotation reads"), 0);
    }

    #[test]
    fn merges_two_documents_in_order() {
        let reparsed = merge_and_reparse(vec![
            doc(fixtures::single_page_pdf()),
            doc(fixtures::mixed_pages_pdf()),
        ]);
        assert_eq!(reparsed.page_count(), 4);
        // Single-page Letter first, then the mixed triple.
        assert!((reparsed.page_geometry(1).expect("p1").width_pt - 612.0).abs() < f64::EPSILON);
        assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 0);
        assert_eq!(reparsed.page_geometry(3).expect("p3").rotation_deg, 90);
        assert_eq!(reparsed.page_geometry(4).expect("p4").rotation_deg, 270);
    }

    #[test]
    fn preserves_exact_document_ordering() {
        let reparsed = merge_and_reparse(vec![
            doc(fixtures::mixed_pages_pdf()),
            doc(fixtures::single_page_pdf()),
            doc(fixtures::five_page_pdf()),
        ]);
        // 3 + 1 + 5 pages; spot-check boundaries between documents.
        assert_eq!(reparsed.page_count(), 9);
        assert!((reparsed.page_geometry(3).expect("p3").width_pt - 420.0).abs() < f64::EPSILON);
        assert!((reparsed.page_geometry(4).expect("p4").width_pt - 612.0).abs() < f64::EPSILON);
        assert!((reparsed.page_geometry(5).expect("p5").width_pt - 612.0).abs() < f64::EPSILON);
        assert!((reparsed.page_geometry(9).expect("p9").width_pt - 500.0).abs() < f64::EPSILON);
    }

    #[test]
    fn duplicate_inputs_produce_two_copies() {
        let bytes = fixtures::single_page_pdf();
        let reparsed = merge_and_reparse(vec![doc(bytes.clone()), doc(bytes)]);
        assert_eq!(reparsed.page_count(), 2);
        for n in 1..=2 {
            reparsed.page_geometry(n).expect("readable");
        }
    }

    #[test]
    fn overlapping_object_ids_stay_independent() {
        // Both fixtures allocate the same low object ids; the merge must
        // still keep every page's own geometry and content.
        let reparsed = merge_and_reparse(vec![
            doc(fixtures::single_page_pdf()),
            doc(fixtures::build_pdf(&fixtures::pdf_spec(
                "1.4",
                vec![(500.0, 700.0, Some(90))],
                None,
            ))),
        ]);
        assert_eq!(reparsed.page_count(), 2);
        assert!((reparsed.page_geometry(1).expect("p1").width_pt - 612.0).abs() < f64::EPSILON);
        assert_eq!(reparsed.page_geometry(1).expect("p1").rotation_deg, 0);
        assert!((reparsed.page_geometry(2).expect("p2").width_pt - 500.0).abs() < f64::EPSILON);
        assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 90);
    }

    #[test]
    fn content_follows_document_order() {
        let texts_a = ["A1", "A2"];
        let texts_b = ["B1", "B2", "B3"];
        let bytes_a = fixtures::text_pages_pdf(&texts_a);
        let bytes_b = fixtures::text_pages_pdf(&texts_b);
        let mut out = MergeOperation
            .execute(
                &ctx(),
                input(vec![doc(bytes_a), doc(bytes_b)]),
                MergeOptions::new(),
            )
            .expect("merge succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("output serializes");
        let raw = lopdf::Document::load_mem(&serialized).expect("output re-parses");
        assert_eq!(raw.get_pages().len(), 5);
        for (output_index, expected) in ["A1", "A2", "B1", "B2", "B3"].iter().enumerate() {
            let page_number = (output_index + 1) as u32;
            let page_id = raw.get_pages()[&page_number];
            let content = raw.get_page_content(page_id);
            let text = String::from_utf8_lossy(&content);
            assert!(
                text.contains(expected),
                "output page {page_number} shows {expected}: {text}"
            );
        }
    }

    #[test]
    fn locked_input_fails_the_whole_merge() {
        let err = MergeOperation
            .execute(
                &ctx(),
                input(vec![
                    doc(fixtures::single_page_pdf()),
                    doc(fixtures::build_locked_pdf()),
                ]),
                MergeOptions::new(),
            )
            .expect_err("locked must fail");
        assert_eq!(err.code(), ErrorCode::UnsupportedFormat);
        let details = err.details().expect("structured details");
        assert!(details.contains("document_index=1"));
    }

    #[test]
    fn malformed_copy_failure_identifies_the_document() {
        // Page 1 references a missing object: parsing succeeds, but the
        // deep copy must fail — attributed to document 2 of 2.
        let mut broken =
            lopdf::Document::load_mem(&fixtures::single_page_pdf()).expect("fixture parses");
        let pages: Vec<lopdf::ObjectId> = broken.get_pages().values().copied().collect();
        let dangling = broken.new_object_id();
        let page_dict = broken.get_dictionary_mut(pages[0]).expect("page dict");
        page_dict.set("FolioProbe", lopdf::Object::Reference(dangling));
        let mut bytes = Vec::new();
        broken.save_to(&mut bytes).expect("saves with dangling ref");
        let err = MergeOperation
            .execute(
                &ctx(),
                input(vec![doc(fixtures::single_page_pdf()), doc(bytes)]),
                MergeOptions::new(),
            )
            .expect_err("dangling ref must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
        let details = err.details().expect("structured details");
        assert!(
            details.contains("document_index=1"),
            "unexpected details: {details}"
        );
    }

    #[test]
    fn rejects_empty_and_reference_inputs() {
        assert!(MergeInput::new(vec![]).documents.is_empty());

        let reference = Document::from_reference(
            crate::core::document::DocumentId::new("doc-1").expect("id"),
            crate::core::document::MediaType::Pdf,
            None,
            128,
            "opfs://docs/abc",
        )
        .expect("reference builds");
        let err = MergeInput::from_document(&reference).expect_err("reference rejected");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn cancellation_aborts_before_construction() {
        let cancelled = CancelledCtx { id: JobId::new() };
        let err = MergeOperation
            .execute(
                &cancelled,
                input(vec![doc(fixtures::mixed_pages_pdf())]),
                MergeOptions::new(),
            )
            .expect_err("cancelled must fail");
        assert_eq!(err.code(), ErrorCode::Cancelled);
    }

    #[test]
    fn merge_is_deterministic() {
        let run = || {
            let mut out = MergeOperation
                .execute(
                    &ctx(),
                    input(vec![
                        doc(fixtures::mixed_pages_pdf()),
                        doc(fixtures::single_page_pdf()),
                    ]),
                    MergeOptions::new(),
                )
                .expect("run succeeds")
                .document;
            out.save_to_bytes().expect("serializes")
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn preserves_metadata_from_first_source() {
        // First source carries title/author; second carries different
        // metadata. Output must match the first, verbatim.
        let with_meta = fixtures::mixed_pages_pdf();
        let other = fixtures::build_pdf(&fixtures::pdf_spec(
            "1.7",
            vec![(612.0, 792.0, None)],
            Some(fixtures::InfoSpec {
                title: Some("Other".to_string()),
                ..fixtures::InfoSpec::default()
            }),
        ));
        let reparsed = merge_and_reparse(vec![doc(with_meta), doc(other)]);
        let meta = reparsed.metadata();
        assert_eq!(meta.title.as_deref(), Some("Mixed Pages"));
        assert_eq!(meta.author.as_deref(), Some("folio-engine fixtures"));
    }

    #[test]
    fn output_version_is_maximum_required() {
        let reparsed = merge_and_reparse(vec![
            doc(fixtures::build_pdf(&fixtures::pdf_spec(
                "1.4",
                vec![(612.0, 792.0, None)],
                None,
            ))),
            doc(fixtures::build_pdf(&fixtures::pdf_spec(
                "1.7",
                vec![(612.0, 792.0, None)],
                None,
            ))),
        ]);
        assert_eq!(reparsed.pdf_version(), "1.7");
    }

    /// Counts image XObjects anywhere in the document.
    fn count_images(raw: &lopdf::Document) -> usize {
        raw.objects
            .values()
            .filter(|obj| {
                let dict = match obj {
                    lopdf::Object::Dictionary(dict) => Some(dict),
                    lopdf::Object::Stream(stream) => Some(&stream.dict),
                    _ => None,
                };
                dict.is_some_and(|dict| {
                    dict.get(b"Subtype")
                        .is_ok_and(|subtype| subtype.as_name().is_ok_and(|name| name == b"Image"))
                })
            })
            .count()
    }

    #[test]
    fn images_survive_merge() {
        let reparsed = merge_and_reparse(vec![
            doc(fixtures::image_page_pdf()),
            doc(fixtures::single_page_pdf()),
        ]);
        assert_eq!(reparsed.page_count(), 2);
        // Re-parse at the lopdf level to inspect raw objects.
        let mut owned = reparsed;
        let bytes = owned.save_to_bytes().expect("serializes");
        let raw = lopdf::Document::load_mem(&bytes).expect("re-parses");
        assert_eq!(count_images(&raw), 1);
        // The image payload itself survived byte-identical.
        let payloads: Vec<Vec<u8>> = raw
            .objects
            .values()
            .filter_map(|obj| match obj {
                lopdf::Object::Stream(stream)
                    if stream
                        .dict
                        .get(b"Subtype")
                        .is_ok_and(|s| s.as_name().is_ok_and(|n| n == b"Image")) =>
                {
                    Some(stream.content.clone())
                }
                _ => None,
            })
            .collect();
        assert_eq!(payloads, vec![vec![255u8, 0, 0]]);
    }

    #[test]
    fn shared_resources_are_not_duplicated_within_a_source() {
        // Both text pages share one font object; the merge must copy it
        // exactly once per source document.
        let reparsed = merge_and_reparse(vec![doc(fixtures::text_pages_pdf(&["A", "B"]))]);
        let mut owned = reparsed;
        let bytes = owned.save_to_bytes().expect("serializes");
        let raw = lopdf::Document::load_mem(&bytes).expect("re-parses");
        let fonts = raw
            .objects
            .values()
            .filter(|obj| {
                obj.as_dict().is_ok_and(|dict| {
                    dict.get(b"Subtype")
                        .is_ok_and(|subtype| subtype.as_name().is_ok_and(|name| name == b"Type1"))
                })
            })
            .count();
        assert_eq!(fonts, 1);
    }

    /// Resolves the output page number an annotation destination points to.
    fn dest_page_number(raw: &lopdf::Document, page_number: u32) -> u32 {
        let page_id = raw.get_pages()[&page_number];
        let page = raw.get_dictionary(page_id).expect("page dict");
        let annots = page
            .get(b"Annots")
            .expect("annots")
            .as_array()
            .expect("array");
        let (_, annot) = raw.dereference(&annots[0]).expect("annot resolves");
        let dest = annot.as_dict().expect("dict").get(b"Dest").expect("dest");
        let (_, dest_array) = raw.dereference(dest).expect("dest resolves");
        let target = dest_array.as_array().expect("array")[0]
            .as_reference()
            .expect("page reference");
        raw.get_pages()
            .iter()
            .find(|(_, id)| **id == target)
            .map(|(number, _)| *number)
            .expect("destination resolves to a page")
    }

    #[test]
    fn annotations_and_destinations_follow_their_pages() {
        let reparsed = merge_and_reparse(vec![
            doc(fixtures::annotated_pdf()),
            doc(fixtures::single_page_pdf()),
        ]);
        assert_eq!(reparsed.page_count(), 3);
        // Re-parse raw: output page 1 must carry the link, pointing at
        // output page 2 (not an orphaned shadow copy).
        let mut owned = reparsed;
        let bytes = owned.save_to_bytes().expect("serializes");
        let raw = lopdf::Document::load_mem(&bytes).expect("re-parses");
        assert_eq!(dest_page_number(&raw, 1), 2);
        // No orphaned shadow pages: exactly the catalog tree's pages exist
        // as Page-typed objects... (Kids count matches instead, since
        // annotation dicts are also objects.)
        assert_eq!(raw.get_pages().len(), 3);
    }

    #[test]
    fn cyclic_references_terminate_and_stay_cyclic() {
        // Page 1 carries /FolioCycle → X, X → Y → X. The merge must
        // terminate and preserve the mutual linkage, not duplicate it.
        let mut base =
            lopdf::Document::load_mem(&fixtures::single_page_pdf()).expect("fixture parses");
        let pages: Vec<lopdf::ObjectId> = base.get_pages().values().copied().collect();
        let x = base.new_object_id();
        let y = base.new_object_id();
        base.objects.insert(
            x,
            lopdf::Object::Dictionary(lopdf::dictionary! {
                "Next" => lopdf::Object::Reference(y),
            }),
        );
        base.objects.insert(
            y,
            lopdf::Object::Dictionary(lopdf::dictionary! {
                "Prev" => lopdf::Object::Reference(x),
            }),
        );
        base.get_dictionary_mut(pages[0])
            .expect("page dict")
            .set("FolioCycle", lopdf::Object::Reference(x));
        let mut bytes = Vec::new();
        base.save_to(&mut bytes).expect("saves with cycle");

        let mut out = MergeOperation
            .execute(&ctx(), input(vec![doc(bytes)]), MergeOptions::new())
            .expect("merge succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("output serializes");
        let raw = lopdf::Document::load_mem(&serialized).expect("output re-parses");
        assert_eq!(raw.get_pages().len(), 1);

        // Follow the cycle from the copied page: X' → Y' → X'.
        let page_id = raw.get_pages()[&1];
        let page = raw.get_dictionary(page_id).expect("page dict");
        let (_, cycle) = raw
            .dereference(page.get(b"FolioCycle").expect("cycle entry"))
            .expect("resolves");
        let next_id = cycle
            .as_dict()
            .expect("dict")
            .get(b"Next")
            .expect("next")
            .as_reference()
            .expect("reference");
        let next_ref = lopdf::Object::Reference(next_id);
        let (_, next) = raw.dereference(&next_ref).expect("next resolves");
        let prev_id = next
            .as_dict()
            .expect("dict")
            .get(b"Prev")
            .expect("prev")
            .as_reference()
            .expect("reference");
        let prev_ref = lopdf::Object::Reference(prev_id);
        let (_, prev) = raw.dereference(&prev_ref).expect("resolves");
        let back = prev
            .as_dict()
            .expect("dict")
            .get(b"Next")
            .expect("next")
            .as_reference()
            .expect("reference");
        assert_eq!(back, next_id, "cycle closes back on itself");
    }

    #[test]
    fn empty_sources_contribute_nothing() {
        let empty = doc(fixtures::empty_pages_pdf());
        assert_eq!(empty.page_count(), 0);
        let reparsed = merge_and_reparse(vec![
            doc(fixtures::single_page_pdf()),
            doc(fixtures::empty_pages_pdf()),
            doc(fixtures::mixed_pages_pdf()),
        ]);
        assert_eq!(reparsed.page_count(), 4);
    }

    #[test]
    fn all_empty_sources_are_rejected() {
        let err = MergeOperation
            .execute(
                &ctx(),
                input(vec![
                    doc(fixtures::empty_pages_pdf()),
                    doc(fixtures::empty_pages_pdf()),
                ]),
                MergeOptions::new(),
            )
            .expect_err("all-empty must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
        assert!(err.message().contains("no pages"));
    }

    #[test]
    fn inherited_attributes_survive_per_source() {
        // Ancestor Rotate 90 in the first doc, plain pages in the second:
        // no leakage either way.
        let mut spec = fixtures::pdf_spec("1.4", vec![(612.0, 792.0, None)], None);
        spec.pages_rotate = Some(90);
        let rotated = fixtures::build_pdf(&spec);
        let reparsed = merge_and_reparse(vec![doc(rotated), doc(fixtures::single_page_pdf())]);
        assert_eq!(reparsed.page_count(), 2);
        assert_eq!(reparsed.effective_rotation(1).expect("rotation"), 90);
        assert_eq!(reparsed.effective_rotation(2).expect("rotation"), 0);
    }
}
