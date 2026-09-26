//! Deep-copy page extraction primitive.
//!
//! Builds a new [`PdfDocument`](super::document::PdfDocument) containing
//! selected pages by deep-copying each page dictionary plus its reachable
//! object closure (content streams, resources, fonts, images, annotations,
//! …) into a fresh document with remapped indirect references.
//!
//! Design notes:
//!
//! * The full selection is validated before any output is constructed, so
//!   an invalid request can never yield a partial document.
//! * Each selection entry is copied independently with a fresh reference
//!   table, so duplicates (`[2, 2, 5]`) produce independent pages and the
//!   output order always matches the requested order.
//! * Inheritable page attributes (`Resources`, `MediaBox`, `CropBox`,
//!   `Rotate`) are materialized explicitly on copied pages, so pages that
//!   relied on ancestors stay correct in the flat output tree.
//! * `Parent` links are never copied; every copied page is re-parented to
//!   the new `Pages` node. Orphaned back-references to the source tree
//!   cannot occur; `/P` annotation back-references resolve to the new page.
//! * The document `Info` dictionary is carried over best-effort.
//!   Catalog-level structures tied to the original document (`Outlines`,
//!   `PageLabels`, `Names`, `AcroForm`, structure trees) are intentionally
//!   not carried over; see the `extract` operation docs.
//!
//! Crate-internal: operations use this through `PdfDocument`-level APIs,
//! never `lopdf` directly.

use std::collections::BTreeMap;

use lopdf::{dictionary, Dictionary, Object, ObjectId, Stream};

use crate::core::error::{EngineError, ErrorCode};
use crate::processing::pdf::core::document::PdfDocument;

/// Inheritable page attributes (PDF 1.7, Table 30) materialized explicitly
/// on copied pages when the source page relied on an ancestor for them.
const INHERITABLE_KEYS: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

/// Maximum ancestor hops when resolving an inherited attribute. Page trees
/// are shallow; the bound only guards against cyclic `Parent` chains in
/// malformed files. Shared with rotation resolution in `document`.
pub(crate) const MAX_INHERITANCE_DEPTH: usize = 128;

/// Checks 1-based page numbers against the document's cached page map,
/// returning the selection index and number of the first invalid entry, if
/// any. Page `0` and anything above the page count are invalid.
///
/// Shared by `copy_pages` and multi-part operations (e.g. `pdf.split`)
/// so every caller validates against the same rule.
pub(crate) fn find_invalid_page(source: &PdfDocument, pages: &[u32]) -> Option<(usize, u32)> {
    find_invalid_page_in_map(source.page_map(), pages)
}

/// [`find_invalid_page`] against an already-resolved page map, for callers
/// that hold one (e.g. `pdf.split`'s whole-plan validation).
fn find_invalid_page_in_map(
    page_map: &BTreeMap<u32, ObjectId>,
    pages: &[u32],
) -> Option<(usize, u32)> {
    pages
        .iter()
        .enumerate()
        .find(|(_, page_number)| !page_map.contains_key(page_number))
        .map(|(index, page_number)| (index, *page_number))
}

/// Copies the selected 1-based pages into a new document, in the requested
/// order (duplicates produce independent pages).
///
/// `on_page_copied(completed, total)` runs after each page is incorporated
/// and may report progress or fail (e.g. on cancellation), aborting the
/// operation without exposing a partial document.
pub(crate) fn copy_pages(
    source: &PdfDocument,
    pages: &[u32],
    on_page_copied: impl FnMut(usize, usize) -> Result<(), EngineError>,
) -> Result<PdfDocument, EngineError> {
    copy_pages_with_map(source, source.page_map(), pages, on_page_copied)
}

/// [`copy_pages`] against a caller-resolved page map. Callers that already
/// validated their selection against this exact map (e.g. `pdf.split`'s
/// whole-plan validation) skip a second page-tree resolution; the selection
/// is still checked against the map before anything is constructed, so the
/// empty-selection and out-of-range guarantees of [`copy_pages`] hold
/// identically.
///
/// `on_page_copied(completed, total)` runs after each page is incorporated
/// and may report progress or fail (e.g. on cancellation), aborting the
/// operation without exposing a partial document.
pub(crate) fn copy_pages_with_map(
    source: &PdfDocument,
    page_map: &BTreeMap<u32, ObjectId>,
    pages: &[u32],
    mut on_page_copied: impl FnMut(usize, usize) -> Result<(), EngineError>,
) -> Result<PdfDocument, EngineError> {
    if pages.is_empty() {
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            "page selection must not be empty; select at least one page",
        ));
    }

    // Validate the complete selection against the resolved map before
    // constructing anything.
    if let Some((index, page_number)) = find_invalid_page_in_map(page_map, pages) {
        return Err(EngineError::new(
            ErrorCode::PageOutOfRange,
            format!("selected page {page_number} is outside the document"),
        )
        .with_details(format!(
            "document has {} pages; invalid entry at selection index {index}",
            page_map.len()
        )));
    }

    let src = source.raw_document();
    let mut out = lopdf::Document::with_version(src.version.clone());
    let out_pages_id = out.new_object_id();
    let mut kids = Vec::with_capacity(pages.len());

    for (index, page_number) in pages.iter().enumerate() {
        // Validated above; the lookup cannot fail.
        let src_page_id = page_map[page_number];
        let new_page_id = copy_single_page(src, src_page_id, *page_number, &mut out, out_pages_id)?;
        kids.push(Object::Reference(new_page_id));
        on_page_copied(index + 1, pages.len())?;
    }

    out.objects.insert(
        out_pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(kids),
            "Count" => Object::from(pages.len() as i64),
        }),
    );

    let catalog_id = out.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => out_pages_id,
    });
    out.trailer.set("Root", catalog_id);

    // Metadata is best-effort: a structurally odd Info dict must not fail
    // an otherwise correct extraction.
    let _ = try_copy_info(src, &mut out);

    Ok(PdfDocument::from_lopdf(out))
}

/// Progress snapshot for one copied page inside [`merge_documents`].
#[derive(Debug, Clone, Copy)]
pub(crate) struct MergeProgress {
    /// 0-based index of the source document currently being copied.
    pub doc_index: usize,
    /// Total number of source documents.
    pub doc_count: usize,
    /// Pages of this source copied so far (1-based count).
    pub page_done: usize,
    /// Pages in this source document.
    pub page_total: usize,
}

/// Appends every page of every source document — in order — into one new
/// document, then returns it.
///
/// Cross-document remapping strategy: each source document gets its own
/// reference table, so identical object numbers from different documents
/// never collide, while shared objects *within* one document are copied
/// exactly once. Every source page is pre-registered before any body is
/// copied, so inter-page references (e.g. link destinations) resolve to
/// the copied pages instead of dragging in shadow copies of source trees.
/// The table doubles as the visited set, so reference cycles terminate.
///
/// `on_page_copied` runs after each incorporated page and may fail (e.g.
/// on cancellation), aborting without exposing a partial document.
///
/// Callers must validate inputs first (non-empty list, supported
/// documents, non-empty total); the checks below are unreachable-in-practice
/// backstops keeping this primitive self-consistent.
pub(crate) fn merge_documents(
    sources: &[&PdfDocument],
    mut on_page_copied: impl FnMut(MergeProgress) -> Result<(), EngineError>,
) -> Result<PdfDocument, EngineError> {
    if sources.is_empty() {
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            "merge requires at least one input document",
        ));
    }
    let total_pages: usize = sources.iter().map(|s| s.page_count() as usize).sum();
    if total_pages == 0 {
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            "merge input documents contain no pages; at least one input page is required",
        ));
    }

    let versions: Vec<&str> = sources.iter().map(|s| s.pdf_version()).collect();
    let mut out = lopdf::Document::with_version(max_version(&versions));
    let out_pages_id = out.new_object_id();
    let mut kids = Vec::with_capacity(total_pages);

    for (doc_index, source) in sources.iter().enumerate() {
        let src = source.raw_document();
        // BTreeMap iteration is page-number ordered; the cached map avoids
        // re-walking this source's page tree here and in `page_count`.
        let ordered: Vec<(u32, ObjectId)> = source
            .page_map()
            .iter()
            .map(|(page_number, page_id)| (*page_number, *page_id))
            .collect();
        // Pre-register every page up front (first registration wins, so a
        // degenerate shared page object stays a single output page).
        let mut table = BTreeMap::new();
        for (_, src_id) in &ordered {
            table.entry(*src_id).or_insert_with(|| out.new_object_id());
        }
        let page_total = ordered.len();
        for (position, (page_number, src_id)) in ordered.iter().enumerate() {
            let body = copy_page_body(
                src,
                *src_id,
                *page_number,
                &mut out,
                out_pages_id,
                &mut table,
            )
            .map_err(|err| with_document_index(err, doc_index))?;
            let new_id = table[src_id];
            out.objects.insert(new_id, Object::Dictionary(body));
            kids.push(Object::Reference(new_id));
            on_page_copied(MergeProgress {
                doc_index,
                doc_count: sources.len(),
                page_done: position + 1,
                page_total,
            })
            .map_err(|err| with_document_index(err, doc_index))?;
        }
    }

    out.objects.insert(
        out_pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(kids),
            "Count" => Object::from(total_pages as i64),
        }),
    );

    let catalog_id = out.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => out_pages_id,
    });
    out.trailer.set("Root", catalog_id);

    // Deterministic metadata policy: the first source document's Info, if
    // readable; anything else is ignored, never cross-wired or merged.
    if let Some(first) = sources.first() {
        let _ = try_copy_info(first.raw_document(), &mut out);
    }

    Ok(PdfDocument::from_lopdf(out))
}

/// Prefixes an error's details with the failing source document index,
/// preserving the original details after it.
fn with_document_index(err: EngineError, doc_index: usize) -> EngineError {
    const PREFIX: &str = "document_index=";
    let combined = match err.details() {
        Some(previous) => format!("{PREFIX}{doc_index}; {previous}"),
        None => format!("{PREFIX}{doc_index}"),
    };
    // Rebuild to keep every other field intact (`with_details` replaces).
    let rebuilt = EngineError::new(err.code(), err.message().to_string()).with_details(combined);
    let rebuilt = match err.operation() {
        Some(operation) => rebuilt.with_operation(operation),
        None => rebuilt,
    };
    match err.job_id() {
        Some(job_id) => rebuilt.with_job_id(job_id.clone()),
        None => rebuilt,
    }
}

/// Picks the output PDF version as the maximum required source version
/// (`"1.4"` + `"1.7"` → `"1.7"`), so no input is ever downgraded below
/// what its copied features may need. Unparseable versions fall back to
/// the first one, verbatim; the result is always deterministic.
fn max_version(versions: &[&str]) -> String {
    fn parse(version: &str) -> Option<(u32, u32)> {
        let (major, minor) = version.split_once('.')?;
        Some((major.parse().ok()?, minor.parse().ok()?))
    }
    versions
        .iter()
        .filter_map(|version| parse(version).map(|parsed| (parsed, *version)))
        .max_by_key(|(parsed, _)| *parsed)
        .map(|(_, version)| version.to_string())
        .unwrap_or_else(|| versions.first().copied().unwrap_or("1.7").to_string())
}

/// Copies one page plus its reachable closure. `Parent` is never copied;
/// the page is re-parented to the new `Pages` node.
fn copy_single_page(
    src: &lopdf::Document,
    src_page_id: ObjectId,
    page_number: u32,
    out: &mut lopdf::Document,
    out_pages_id: ObjectId,
) -> Result<ObjectId, EngineError> {
    let new_page_id = out.new_object_id();
    // Pre-register so back-references to the page itself (e.g. annotation
    // `/P` entries) resolve to the new page instead of dragging in the
    // source tree.
    let mut table = BTreeMap::new();
    table.insert(src_page_id, new_page_id);
    let new_dict = copy_page_body(src, src_page_id, page_number, out, out_pages_id, &mut table)?;
    out.objects
        .insert(new_page_id, Object::Dictionary(new_dict));
    Ok(new_page_id)
}

/// Builds the copied page dictionary for `src_page_id` (without allocating
/// or inserting it): copies every entry except `Parent`, re-parents to
/// `out_pages_id`, and materializes missing inheritable attributes.
/// Reference remapping flows through `table`, which must already map
/// `src_page_id` itself so self-references resolve to the new page.
///
/// Shared by single-document extraction (fresh table per entry, hence
/// independent duplicate copies) and multi-document merge (one table per
/// source document, hence shared objects stay shared within a document).
fn copy_page_body(
    src: &lopdf::Document,
    src_page_id: ObjectId,
    page_number: u32,
    out: &mut lopdf::Document,
    out_pages_id: ObjectId,
    table: &mut BTreeMap<ObjectId, ObjectId>,
) -> Result<Dictionary, EngineError> {
    let context = format!("page {page_number}");
    let src_dict = src.get_dictionary(src_page_id).map_err(|err| {
        EngineError::new(
            ErrorCode::InvalidDocument,
            format!("{context} dictionary is unreadable"),
        )
        .with_details(err.to_string())
    })?;

    let mut new_dict = Dictionary::new();
    for (key, value) in src_dict.iter() {
        if key == b"Parent" {
            continue;
        }
        let copied = copy_object(src, value, out, table, &context)?;
        new_dict.set(key.clone(), copied);
    }
    new_dict.set("Parent", Object::Reference(out_pages_id));

    // Pages that inherited attributes from ancestors would break in the
    // flat output tree; materialize whatever the page itself lacks.
    for key in INHERITABLE_KEYS {
        if new_dict.get(key).is_ok() {
            continue;
        }
        if let Some(resolved) = resolve_inherited(src, src_page_id, key) {
            let copied = copy_object(src, &resolved, out, table, &context)?;
            new_dict.set(key.to_vec(), copied);
        }
    }
    Ok(new_dict)
}

/// Deep-copies one object, remapping indirect references through `table`
/// (which also serves as the visited set against reference cycles).
fn copy_object(
    src: &lopdf::Document,
    obj: &Object,
    out: &mut lopdf::Document,
    table: &mut BTreeMap<ObjectId, ObjectId>,
    context: &str,
) -> Result<Object, EngineError> {
    match obj {
        Object::Reference(id) => {
            if let Some(mapped) = table.get(id) {
                return Ok(Object::Reference(*mapped));
            }
            let new_id = out.new_object_id();
            table.insert(*id, new_id);
            let target = src.get_object(*id).map_err(|_| {
                EngineError::new(
                    ErrorCode::InvalidDocument,
                    format!("copying {context} failed: reference to missing object"),
                )
                .with_details(format!("dangling reference to object {id:?}"))
            })?;
            let copied = copy_object(src, target, out, table, context)?;
            out.objects.insert(new_id, copied);
            Ok(Object::Reference(new_id))
        }
        Object::Array(items) => {
            let mut copied = Vec::with_capacity(items.len());
            for item in items {
                copied.push(copy_object(src, item, out, table, context)?);
            }
            Ok(Object::Array(copied))
        }
        Object::Dictionary(dict) => {
            let mut new_dict = Dictionary::new();
            for (key, value) in dict.iter() {
                let copied = copy_object(src, value, out, table, context)?;
                new_dict.set(key.clone(), copied);
            }
            Ok(Object::Dictionary(new_dict))
        }
        Object::Stream(stream) => {
            let mut new_dict = Dictionary::new();
            for (key, value) in stream.dict.iter() {
                let copied = copy_object(src, value, out, table, context)?;
                new_dict.set(key.clone(), copied);
            }
            Ok(Object::Stream(Stream {
                dict: new_dict,
                content: stream.content.clone(),
                allows_compression: stream.allows_compression,
                start_position: None,
            }))
        }
        scalar => Ok(scalar.clone()),
    }
}

/// Resolves an inheritable attribute along the page → ancestors chain,
/// nearest holder wins. Returns the raw (possibly indirect) object.
fn resolve_inherited(src: &lopdf::Document, mut id: ObjectId, key: &[u8]) -> Option<Object> {
    for _ in 0..MAX_INHERITANCE_DEPTH {
        let dict = src.get_dictionary(id).ok()?;
        if let Ok(value) = dict.get(key) {
            return Some(value.clone());
        }
        id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

/// Copies the document `Info` dictionary best-effort. Any structural
/// problem is reported to the caller, which deliberately ignores it.
fn try_copy_info(src: &lopdf::Document, out: &mut lopdf::Document) -> Result<(), EngineError> {
    let info_obj = src.trailer.get(b"Info").map_err(invalid_info)?;
    let (_, resolved) = src.dereference(info_obj).map_err(invalid_info)?;
    let dict = resolved.as_dict().map_err(invalid_info)?;
    let mut table = BTreeMap::new();
    let mut new_dict = Dictionary::new();
    for (key, value) in dict.iter() {
        let copied =
            copy_object(src, value, out, &mut table, "document info").map_err(invalid_info)?;
        new_dict.set(key.clone(), copied);
    }
    let info_id = out.add_object(Object::Dictionary(new_dict));
    out.trailer.set("Info", info_id);
    Ok(())
}

fn invalid_info(err: impl ToString) -> EngineError {
    EngineError::new(
        ErrorCode::InvalidDocument,
        "document info dictionary is unreadable",
    )
    .with_details(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::fixtures;
    use super::super::loader::load_pdf;
    use super::*;

    fn copy_fixture(spec: &fixtures::PdfSpec, pages: &[u32]) -> PdfDocument {
        let bytes = fixtures::build_pdf(spec);
        let doc = load_pdf(&bytes).expect("fixture loads");
        copy_pages(&doc, pages, |_, _| Ok(())).expect("copy succeeds")
    }

    fn reparse(doc: &mut PdfDocument) -> PdfDocument {
        let bytes = doc.save_to_bytes().expect("output serializes");
        load_pdf(&bytes).expect("output re-parses")
    }

    #[test]
    fn rejects_empty_selection() {
        let bytes = fixtures::single_page_pdf();
        let doc = load_pdf(&bytes).expect("fixture loads");
        let err = copy_pages(&doc, &[], |_, _| Ok(())).expect_err("empty must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn rejects_out_of_range_before_constructing() {
        let bytes = fixtures::single_page_pdf();
        let doc = load_pdf(&bytes).expect("fixture loads");
        let err = copy_pages(&doc, &[1, 999_999], |_, _| Ok(())).expect_err("must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert!(err.message().contains("999999"));
        let details = err.details().expect("details explain the failure");
        assert!(details.contains("1 pages")); // page count reported
        assert!(details.contains("index 1")); // position of first bad entry
    }

    #[test]
    fn rejects_page_zero() {
        let bytes = fixtures::single_page_pdf();
        let doc = load_pdf(&bytes).expect("fixture loads");
        let err = copy_pages(&doc, &[0], |_, _| Ok(())).expect_err("zero must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
    }

    #[test]
    fn copies_subset_in_requested_order() {
        let mut out = copy_fixture(
            &fixtures::pdf_spec(
                "1.7",
                vec![
                    (612.0, 792.0, None),
                    (595.0, 842.0, Some(90)),
                    (420.0, 595.0, Some(180)),
                ],
                None,
            ),
            &[3, 1],
        );
        let reparsed = reparse(&mut out);
        assert_eq!(reparsed.page_count(), 2);
        let first = reparsed.page_geometry(1).expect("page 1");
        assert!((first.width_pt - 420.0).abs() < f64::EPSILON);
        assert_eq!(first.rotation_deg, 180);
        let second = reparsed.page_geometry(2).expect("page 2");
        assert!((second.width_pt - 612.0).abs() < f64::EPSILON);
        assert_eq!(second.rotation_deg, 0);
    }

    #[test]
    fn duplicates_produce_independent_pages() {
        let mut out = copy_fixture(
            &fixtures::pdf_spec(
                "1.7",
                vec![(612.0, 792.0, None), (595.0, 842.0, Some(90))],
                None,
            ),
            &[2, 2, 1],
        );
        let reparsed = reparse(&mut out);
        assert_eq!(reparsed.page_count(), 3);
        for n in 1..=3 {
            reparsed.page_geometry(n).expect("page readable");
        }
        assert_eq!(reparsed.page_geometry(1).expect("p1").rotation_deg, 90);
        assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 90);
        assert_eq!(reparsed.page_geometry(3).expect("p3").rotation_deg, 0);
    }

    #[test]
    fn materializes_inherited_attributes() {
        let mut spec = fixtures::pdf_spec("1.4", vec![(0.0, 0.0, None)], None);
        spec.inherit_media_box = true;
        spec.pages_rotate = Some(180);
        let bytes = fixtures::build_pdf(&spec);
        let doc = load_pdf(&bytes).expect("fixture loads");
        let mut out = copy_pages(&doc, &[1], |_, _| Ok(())).expect("copy succeeds");

        // The copied page must stand alone: explicit MediaBox/Rotate.
        let raw = out.raw_document();
        let page_id = raw.get_pages()[&1];
        let dict = raw.get_dictionary(page_id).expect("page dict");
        assert!(dict.get(b"MediaBox").is_ok());
        assert!(dict.get(b"Rotate").is_ok());

        let reparsed = reparse(&mut out);
        let geometry = reparsed.page_geometry(1).expect("geometry");
        assert!((geometry.width_pt - 612.0).abs() < f64::EPSILON);
        assert_eq!(geometry.rotation_deg, 180);
    }

    #[test]
    fn preserves_metadata() {
        let bytes = fixtures::mixed_pages_pdf();
        let doc = load_pdf(&bytes).expect("fixture loads");
        let mut out = copy_pages(&doc, &[1], |_, _| Ok(())).expect("copy succeeds");
        let reparsed = reparse(&mut out);
        let meta = reparsed.metadata();
        assert_eq!(meta.title.as_deref(), Some("Mixed Pages"));
        assert_eq!(meta.author.as_deref(), Some("folio-engine fixtures"));
    }

    #[test]
    fn preserves_version() {
        let bytes =
            fixtures::build_pdf(&fixtures::pdf_spec("1.4", vec![(612.0, 792.0, None)], None));
        let doc = load_pdf(&bytes).expect("fixture loads");
        let out = copy_pages(&doc, &[1], |_, _| Ok(())).expect("copy succeeds");
        assert_eq!(out.pdf_version(), "1.4");
    }

    #[test]
    fn callback_failure_aborts_without_partial_output() {
        let bytes = fixtures::mixed_pages_pdf();
        let doc = load_pdf(&bytes).expect("fixture loads");
        let err = copy_pages(&doc, &[1, 2, 3], |done, _| {
            if done >= 1 {
                return Err(EngineError::new(ErrorCode::Cancelled, "stop"));
            }
            Ok(())
        })
        .expect_err("callback failure must abort");
        assert_eq!(err.code(), ErrorCode::Cancelled);
    }

    #[test]
    fn does_not_mutate_source_bytes() {
        let bytes = fixtures::mixed_pages_pdf();
        let before = bytes.clone();
        let doc = load_pdf(&bytes).expect("fixture loads");
        let _ = copy_pages(&doc, &[3, 1, 2], |_, _| Ok(())).expect("copy succeeds");
        assert_eq!(bytes, before);
        // The source document itself is unchanged too.
        assert_eq!(doc.page_count(), 3);
    }

    #[test]
    fn max_version_picks_highest_required() {
        assert_eq!(max_version(&["1.4", "1.7"]), "1.7");
        assert_eq!(max_version(&["1.7", "1.4", "1.5"]), "1.7");
        assert_eq!(max_version(&["1.7", "2.0"]), "2.0");
        assert_eq!(max_version(&["1.4"]), "1.4");
        // Unparseable versions fall back deterministically, verbatim.
        assert_eq!(max_version(&["bogus"]), "bogus");
        assert_eq!(max_version(&["bogus", "1.5"]), "1.5");
    }
}
