//! [`PdfDocument`]: our own PDF abstraction wrapping `lopdf`.
//!
//! The rest of the engine interacts with this type, never with
//! `lopdf::Document` directly, so the underlying implementation can be
//! swapped later without touching operations.
//!
//! The source document stays read-only; transformation primitives (see
//! [`copy`](super::copy)) build new documents rather than mutating.

use lopdf::{Dictionary, Object, ObjectId};

use crate::core::error::{EngineError, ErrorCode};
use crate::processing::pdf::metadata::{format_pdf_date, FieldPatch, MetadataPatch, PdfDate};

/// Basic document metadata. Every field is optional: missing metadata is
/// represented as [`None`], never as a fatal error.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PdfMetadata {
    /// Document title (`/Title`).
    pub title: Option<String>,
    /// Document author (`/Author`).
    pub author: Option<String>,
    /// Document subject (`/Subject`).
    pub subject: Option<String>,
    /// Document keywords (`/Keywords`).
    pub keywords: Option<String>,
    /// Creating application (`/Creator`).
    pub creator: Option<String>,
    /// Producing application (`/Producer`).
    pub producer: Option<String>,
    /// Creation date as a raw PDF date string (`/CreationDate`).
    pub creation_date: Option<String>,
    /// Modification date as a raw PDF date string (`/ModDate`).
    pub modification_date: Option<String>,
}

/// Page geometry in PDF points (1/72 inch), with inheritable attributes
/// (`MediaBox`, `Rotate`) resolved along the page-tree ancestor chain.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageGeometry {
    /// Page width in points.
    pub width_pt: f64,
    /// Page height in points.
    pub height_pt: f64,
    /// Effective rotation in degrees, normalized to `0..360`.
    pub rotation_deg: i32,
}

/// Our PDF abstraction: owns the parsed document, exposes only what the
/// engine needs. Constructed via the [`loader`](super::loader) from bytes.
#[derive(Debug)]
pub struct PdfDocument {
    inner: lopdf::Document,
}

impl PdfDocument {
    /// Wraps an already-parsed document. Crate-internal: only the loader,
    /// transformation primitives, and white-box tests may construct this type.
    pub(crate) fn from_lopdf(inner: lopdf::Document) -> Self {
        Self { inner }
    }

    /// Crate-internal raw access for shared PDF transformation primitives
    /// (e.g. page copying in [`copy`](super::copy)). Operations must use
    /// [`PdfDocument`] methods and never this accessor.
    pub(crate) fn raw_document(&self) -> &lopdf::Document {
        &self.inner
    }

    /// Serializes the document to a fresh byte buffer (file output, WASM
    /// transfer, or re-parsing for validation). Takes `&mut self` because
    /// `lopdf` finalizes write-time bookkeeping during serialization.
    pub fn save_to_bytes(&mut self) -> Result<Vec<u8>, EngineError> {
        let mut bytes = Vec::new();
        self.inner.save_to(&mut bytes).map_err(|err| {
            EngineError::new(
                ErrorCode::ProcessingFailed,
                "failed to serialize PDF document",
            )
            .with_details(err.to_string())
        })?;
        Ok(bytes)
    }

    /// Returns the number of pages.
    #[must_use]
    pub fn page_count(&self) -> u32 {
        self.inner.get_pages().len() as u32
    }

    /// Returns the PDF specification version (e.g. `"1.7"`).
    #[must_use]
    pub fn pdf_version(&self) -> &str {
        &self.inner.version
    }

    /// Returns `true` while the document is still encrypted (a password
    /// would be required to read protected content).
    #[must_use]
    pub fn is_encrypted(&self) -> bool {
        self.inner.is_encrypted()
    }

    /// Returns `true` when the document was encrypted at load time, even
    /// if it has since been transparently decrypted (e.g. empty password).
    #[must_use]
    pub fn was_encrypted(&self) -> bool {
        self.inner.was_encrypted()
    }

    /// Reads document metadata best-effort. Never fails: any structural
    /// problem yields [`None`] fields rather than an error.
    #[must_use]
    pub fn metadata(&self) -> PdfMetadata {
        let mut out = PdfMetadata::default();
        let info = self
            .inner
            .trailer
            .get(b"Info")
            .ok()
            .and_then(|obj| self.inner.dereference(obj).ok())
            .and_then(|(_, obj)| obj.as_dict().ok());
        let Some(info) = info else {
            return out;
        };
        out.title = read_text_field(self, info, b"Title");
        out.author = read_text_field(self, info, b"Author");
        out.subject = read_text_field(self, info, b"Subject");
        out.keywords = read_text_field(self, info, b"Keywords");
        out.creator = read_text_field(self, info, b"Creator");
        out.producer = read_text_field(self, info, b"Producer");
        out.creation_date = read_text_field(self, info, b"CreationDate");
        out.modification_date = read_text_field(self, info, b"ModDate");
        out
    }

    /// Resolves the geometry of a 1-based page number, following
    /// inheritable attributes up the page tree.
    pub fn page_geometry(&self, page_number: u32) -> Result<PageGeometry, EngineError> {
        let page_id = self
            .inner
            .get_pages()
            .get(&page_number)
            .copied()
            .ok_or_else(|| {
                EngineError::new(
                    ErrorCode::PageOutOfRange,
                    format!("page {page_number} is outside the document"),
                )
                .with_details(format!("document has {} pages", self.page_count()))
            })?;
        self.page_geometry_by_id(page_number, page_id)
    }

    /// Returns the 1-based page numbers in document order.
    #[must_use]
    pub fn page_numbers(&self) -> Vec<u32> {
        self.inner.get_pages().keys().copied().collect()
    }

    /// Resolves the effective rotation of a 1-based page in degrees,
    /// normalized to one of `0`, `90`, `180`, `270`.
    ///
    /// Follows PDF inheritance semantics: the nearest `/Rotate` holder on
    /// the page → ancestors chain wins; absence everywhere means `0`.
    /// (Note: [`page_geometry`](Self::page_geometry) historically
    /// *accumulates* chained rotations instead; that behavior is preserved
    /// untouched, so the two agree whenever at most one `/Rotate` exists
    /// in a chain — the overwhelmingly common case.)
    pub fn effective_rotation(&self, page_number: u32) -> Result<i32, EngineError> {
        let page_id = self
            .inner
            .get_pages()
            .get(&page_number)
            .copied()
            .ok_or_else(|| {
                EngineError::new(
                    ErrorCode::PageOutOfRange,
                    format!("page {page_number} is outside the document"),
                )
                .with_details(format!("document has {} pages", self.page_count()))
            })?;
        let mut id = page_id;
        for _ in 0..super::copy::MAX_INHERITANCE_DEPTH {
            let dict = self.inner.get_dictionary(id).map_err(|err| {
                EngineError::new(
                    ErrorCode::InvalidDocument,
                    format!("page {page_number} dictionary is unreadable"),
                )
                .with_details(err.to_string())
            })?;
            if let Ok(obj) = dict.get(b"Rotate") {
                let (_, resolved) = self.inner.dereference(obj).map_err(|err| {
                    EngineError::new(
                        ErrorCode::InvalidDocument,
                        format!("page {page_number} rotation is unreadable"),
                    )
                    .with_details(err.to_string())
                })?;
                let raw = resolved.as_float().map_err(|_| {
                    EngineError::new(
                        ErrorCode::InvalidDocument,
                        format!("page {page_number} rotation is not a number"),
                    )
                })? as i32;
                return normalize_quarter_turn(raw).ok_or_else(|| {
                    EngineError::new(
                        ErrorCode::InvalidDocument,
                        format!(
                            "page {page_number} has a non-quarter-turn rotation of {raw} degrees"
                        ),
                    )
                });
            }
            let parent = match dict.get(b"Parent") {
                Ok(obj) => obj.as_reference().map_err(|err| {
                    EngineError::new(
                        ErrorCode::InvalidDocument,
                        format!("page {page_number} structure is malformed"),
                    )
                    .with_details(err.to_string())
                })?,
                Err(_) => return Ok(0),
            };
            id = parent;
        }
        Err(EngineError::new(
            ErrorCode::InvalidDocument,
            format!("page {page_number} parent chain is cyclic or too deep"),
        ))
    }

    /// Stores an explicit `/Rotate` value on a 1-based page's own
    /// dictionary, making its effective rotation independent of whatever
    /// ancestors carry. The value must be a quarter turn; it is normalized
    /// into `0..360` before storing, so callers always observe a canonical
    /// representation (normalized zero is stored explicitly as `/Rotate 0`
    /// rather than by removing the entry).
    pub fn set_page_rotation(
        &mut self,
        page_number: u32,
        rotation_deg: i32,
    ) -> Result<(), EngineError> {
        let normalized = normalize_quarter_turn(rotation_deg).ok_or_else(|| {
            EngineError::new(
                ErrorCode::InvalidDocument,
                format!("cannot store non-quarter-turn rotation of {rotation_deg} degrees"),
            )
        })?;
        let page_id = self
            .inner
            .get_pages()
            .get(&page_number)
            .copied()
            .ok_or_else(|| {
                EngineError::new(
                    ErrorCode::PageOutOfRange,
                    format!("page {page_number} is outside the document"),
                )
                .with_details(format!("document has {} pages", self.page_count()))
            })?;
        let dict = self.inner.get_dictionary_mut(page_id).map_err(|err| {
            EngineError::new(
                ErrorCode::InvalidDocument,
                format!("page {page_number} dictionary is not writable"),
            )
            .with_details(err.to_string())
        })?;
        dict.set("Rotate", Object::Integer(i64::from(normalized)));
        Ok(())
    }

    /// Applies a metadata patch to the document's Info dictionary in place.
    ///
    /// Only patched keys are touched: `Set` writes the value, `Clear`
    /// removes the key (never replaced by an empty string), `Unchanged`
    /// preserves whatever the document carries — including malformed raw
    /// values and custom keys, which this API never interprets. Pages,
    /// streams (including XMP metadata streams), outlines, and every other
    /// structure are untouched, so unrelated content is preserved by
    /// construction rather than by copying.
    ///
    /// Info-dictionary ownership: a missing trailer `/Info` is created
    /// (fresh indirect dictionary) only when the patch sets at least one
    /// value; clear-only or empty patches on an Info-less document are
    /// no-ops. An existing indirect Info dictionary is mutated through
    /// its reference; a direct (inline trailer) dictionary is mutated in
    /// place. A non-dictionary `/Info` entry fails as `InvalidDocument`.
    pub fn apply_metadata_patch(&mut self, patch: &MetadataPatch) -> Result<(), EngineError> {
        if patch.is_empty() {
            return Ok(());
        }
        // Locate the Info dictionary without mutating anything yet.
        enum Location {
            Missing,
            Indirect(ObjectId),
            Direct,
        }
        let location = match self.inner.trailer.get(b"Info") {
            Err(_) => Location::Missing,
            Ok(obj) => {
                let (id, resolved) = self.inner.dereference(obj).map_err(|err| {
                    EngineError::new(
                        ErrorCode::InvalidDocument,
                        "document Info reference is unreadable",
                    )
                    .with_details(err.to_string())
                })?;
                if resolved.as_dict().is_err() {
                    return Err(EngineError::new(
                        ErrorCode::InvalidDocument,
                        "document Info entry is not a dictionary",
                    ));
                }
                match id {
                    Some(id) => Location::Indirect(id),
                    None => Location::Direct,
                }
            }
        };
        match location {
            Location::Missing => {
                if !patch.has_sets() {
                    return Ok(());
                }
                let id = self.inner.add_object(Dictionary::new());
                self.inner.trailer.set("Info", id);
                let dict = self.inner.get_dictionary_mut(id).map_err(|err| {
                    EngineError::new(
                        ErrorCode::Internal,
                        "freshly created Info dictionary is not writable",
                    )
                    .with_details(err.to_string())
                })?;
                write_patch(dict, patch);
                Ok(())
            }
            Location::Indirect(id) => {
                let dict = self.inner.get_dictionary_mut(id).map_err(|err| {
                    EngineError::new(
                        ErrorCode::InvalidDocument,
                        "document Info dictionary is not writable",
                    )
                    .with_details(err.to_string())
                })?;
                write_patch(dict, patch);
                Ok(())
            }
            Location::Direct => {
                let entry = self.inner.trailer.get_mut(b"Info").map_err(|err| {
                    EngineError::new(
                        ErrorCode::InvalidDocument,
                        "document Info dictionary is not writable",
                    )
                    .with_details(err.to_string())
                })?;
                match entry {
                    Object::Dictionary(dict) => {
                        write_patch(dict, patch);
                        Ok(())
                    }
                    _ => Err(EngineError::new(
                        ErrorCode::InvalidDocument,
                        "document Info entry is not a dictionary",
                    )),
                }
            }
        }
    }

    fn page_geometry_by_id(
        &self,
        page_number: u32,
        page_id: ObjectId,
    ) -> Result<PageGeometry, EngineError> {
        let mut current: &Dictionary = self.inner.get_dictionary(page_id).map_err(|err| {
            EngineError::new(
                ErrorCode::InvalidDocument,
                format!("page {page_number} dictionary is unreadable"),
            )
            .with_details(err.to_string())
        })?;

        let mut media_box: Option<[f64; 4]> = None;
        let mut rotation: i64 = 0;

        // Walk the page -> ancestors chain: MediaBox is taken from the
        // nearest holder, Rotate entries accumulate (mod 360 at the end).
        loop {
            if media_box.is_none() {
                if let Ok(obj) = current.get(b"MediaBox") {
                    media_box = Some(self.parse_rect(page_number, obj)?);
                }
            }
            if let Ok(obj) = current.get(b"Rotate") {
                rotation += self.as_number(page_number, obj, "Rotate")? as i64;
            }
            let parent = match current.get(b"Parent") {
                Ok(obj) => obj
                    .as_reference()
                    .map_err(|err| invalid_page(page_number, err))?,
                Err(_) => break,
            };
            current = self.inner.get_dictionary(parent).map_err(|err| {
                EngineError::new(
                    ErrorCode::InvalidDocument,
                    format!("page {page_number} ancestor is unreadable"),
                )
                .with_details(err.to_string())
            })?;
        }

        let Some([x0, y0, x1, y1]) = media_box else {
            return Err(EngineError::new(
                ErrorCode::InvalidDocument,
                format!("page {page_number} has no MediaBox"),
            ));
        };
        let width_pt = (x1 - x0).abs();
        let height_pt = (y1 - y0).abs();
        if width_pt <= 0.0 || height_pt <= 0.0 {
            return Err(EngineError::new(
                ErrorCode::InvalidDocument,
                format!("page {page_number} has a degenerate MediaBox"),
            ));
        }
        Ok(PageGeometry {
            width_pt,
            height_pt,
            rotation_deg: rotation.rem_euclid(360) as i32,
        })
    }

    fn parse_rect(&self, page_number: u32, obj: &Object) -> Result<[f64; 4], EngineError> {
        let (_, resolved) = self
            .inner
            .dereference(obj)
            .map_err(|err| invalid_page(page_number, err))?;
        let items = resolved
            .as_array()
            .map_err(|err| invalid_page(page_number, err))?;
        if items.len() != 4 {
            return Err(EngineError::new(
                ErrorCode::InvalidDocument,
                format!("page {page_number} MediaBox must hold 4 numbers"),
            ));
        }
        let mut rect = [0.0; 4];
        for (i, item) in items.iter().enumerate() {
            rect[i] = self.as_number(page_number, item, "MediaBox")?;
        }
        Ok(rect)
    }

    fn as_number(&self, page_number: u32, obj: &Object, field: &str) -> Result<f64, EngineError> {
        let (_, resolved) = self
            .inner
            .dereference(obj)
            .map_err(|err| invalid_page(page_number, err))?;
        resolved.as_float().map(f64::from).map_err(|_| {
            EngineError::new(
                ErrorCode::InvalidDocument,
                format!("page {page_number} field {field} is not a number"),
            )
        })
    }
}

/// Writes every patched field into a resolved Info dictionary.
/// Unchanged fields are skipped; callers guarantee the dictionary exists.
fn write_patch(dict: &mut Dictionary, patch: &MetadataPatch) {
    write_string(dict, b"Title", &patch.title);
    write_string(dict, b"Author", &patch.author);
    write_string(dict, b"Subject", &patch.subject);
    write_string(dict, b"Keywords", &patch.keywords);
    write_string(dict, b"Creator", &patch.creator);
    write_string(dict, b"Producer", &patch.producer);
    write_date(dict, b"CreationDate", &patch.creation_date);
    write_date(dict, b"ModDate", &patch.modification_date);
}

fn write_string(dict: &mut Dictionary, key: &[u8], field: &FieldPatch<String>) {
    match field {
        FieldPatch::Unchanged => {}
        FieldPatch::Clear => {
            dict.remove(key);
        }
        FieldPatch::Set(value) => {
            dict.set(key, encode_text_string(value));
        }
    }
}

fn write_date(dict: &mut Dictionary, key: &[u8], field: &FieldPatch<PdfDate>) {
    match field {
        FieldPatch::Unchanged => {}
        FieldPatch::Clear => {
            dict.remove(key);
        }
        FieldPatch::Set(date) => {
            dict.set(key, encode_text_string(&format_pdf_date(date)));
        }
    }
}

/// Encodes application text as a UTF-16BE string object with BOM
/// (hexadecimal form). Uniform for ASCII and non-ASCII alike: ASCII
/// decodes back identically, and every Unicode scalar value round-trips
/// through the reader's UTF-16 path. Deterministic across runs.
fn encode_text_string(text: &str) -> Object {
    use lopdf::StringFormat;
    let mut bytes = vec![0xFE, 0xFF];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}

fn invalid_page(page_number: u32, err: impl ToString) -> EngineError {
    EngineError::new(
        ErrorCode::InvalidDocument,
        format!("page {page_number} structure is malformed"),
    )
    .with_details(err.to_string())
}

/// Normalizes an integer degree value to one of `0`, `90`, `180`, `270`
/// (integer-only arithmetic), or returns [`None`] for non-quarter-turns.
/// `360` → `0`, `450` → `90`, `-90` → `270`.
pub(crate) fn normalize_quarter_turn(degrees: i32) -> Option<i32> {
    let normalized = degrees.rem_euclid(360);
    (normalized % 90 == 0).then_some(normalized)
}

fn read_text_field(doc: &PdfDocument, info: &Dictionary, key: &[u8]) -> Option<String> {
    let obj = info.get(key).ok()?;
    let (_, resolved) = doc.inner.dereference(obj).ok()?;
    let bytes = resolved.as_str().ok()?;
    Some(decode_text_string(bytes))
}

/// Decodes a PDF text string: UTF-16BE when a BOM is present, otherwise
/// UTF-8 where valid with a Latin-1 fallback (covers PDFDocEncoding's
/// ASCII/latin range; a full encoding table is a later refinement).
fn decode_text_string(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else if let Ok(text) = std::str::from_utf8(bytes) {
        text.to_string()
    } else {
        bytes.iter().map(|byte| *byte as char).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures;
    use super::*;

    #[test]
    fn reports_page_count_and_version() {
        let bytes = fixtures::build_pdf(&fixtures::pdf_spec(
            "1.7",
            vec![(612.0, 792.0, None), (595.0, 842.0, None)],
            None,
        ));
        let doc = super::super::loader::load_pdf(&bytes).expect("fixture loads");
        assert_eq!(doc.page_count(), 2);
        assert_eq!(doc.pdf_version(), "1.7");
        assert!(!doc.is_encrypted());
        assert!(!doc.was_encrypted());
    }

    #[test]
    fn resolves_page_dimensions() {
        let bytes =
            fixtures::build_pdf(&fixtures::pdf_spec("1.4", vec![(612.0, 792.0, None)], None));
        let doc = super::super::loader::load_pdf(&bytes).expect("fixture loads");
        let geometry = doc.page_geometry(1).expect("geometry resolves");
        assert!((geometry.width_pt - 612.0).abs() < f64::EPSILON);
        assert!((geometry.height_pt - 792.0).abs() < f64::EPSILON);
        assert_eq!(geometry.rotation_deg, 0);
    }

    #[test]
    fn resolves_rotation_and_normalizes() {
        let bytes = fixtures::build_pdf(&fixtures::pdf_spec(
            "1.4",
            vec![(612.0, 792.0, Some(90)), (612.0, 792.0, Some(450))],
            None,
        ));
        let doc = super::super::loader::load_pdf(&bytes).expect("fixture loads");
        assert_eq!(doc.page_geometry(1).expect("page 1").rotation_deg, 90);
        assert_eq!(doc.page_geometry(2).expect("page 2").rotation_deg, 90);
    }

    #[test]
    fn inherits_media_box_and_rotation_from_pages_node() {
        let mut spec = fixtures::pdf_spec("1.4", vec![(0.0, 0.0, None)], None);
        spec.inherit_media_box = true;
        spec.pages_rotate = Some(180);
        let bytes = fixtures::build_pdf(&spec);
        let doc = super::super::loader::load_pdf(&bytes).expect("fixture loads");
        let geometry = doc.page_geometry(1).expect("inherited geometry");
        assert!((geometry.width_pt - 612.0).abs() < f64::EPSILON);
        assert!((geometry.height_pt - 792.0).abs() < f64::EPSILON);
        assert_eq!(geometry.rotation_deg, 180);
    }

    #[test]
    fn detects_encryption_marker() {
        use lopdf::dictionary;

        let mut doc =
            fixtures::parsed_fixture(&fixtures::pdf_spec("1.4", vec![(612.0, 792.0, None)], None));
        assert!(
            !PdfDocument::from_lopdf(fixtures::parsed_fixture(&fixtures::pdf_spec(
                "1.4",
                vec![(612.0, 792.0, None)],
                None,
            )))
            .is_encrypted()
        );
        // `is_encrypted` requires an /Encrypt reference resolving to a
        // dictionary — exactly what a real encrypted file carries.
        let enc_id = doc.add_object(dictionary! { "Filter" => "Standard" });
        doc.trailer.set("Encrypt", enc_id);
        let wrapped = PdfDocument::from_lopdf(doc);
        assert!(wrapped.is_encrypted());
        assert!(!wrapped.was_encrypted());
    }

    #[test]
    fn rejects_unknown_page_number() {
        let bytes =
            fixtures::build_pdf(&fixtures::pdf_spec("1.4", vec![(612.0, 792.0, None)], None));
        let doc = super::super::loader::load_pdf(&bytes).expect("fixture loads");
        let err = doc.page_geometry(99).expect_err("page 99 is out of range");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
    }

    #[test]
    fn reads_metadata_and_tolerates_absence() {
        let meta_in = fixtures::InfoSpec {
            title: Some("Hello".to_string()),
            author: Some("Engine".to_string()),
            ..fixtures::InfoSpec::default()
        };
        let bytes = fixtures::build_pdf(&fixtures::pdf_spec(
            "1.7",
            vec![(612.0, 792.0, None)],
            Some(meta_in),
        ));
        let doc = super::super::loader::load_pdf(&bytes).expect("fixture loads");
        let meta = doc.metadata();
        assert_eq!(meta.title.as_deref(), Some("Hello"));
        assert_eq!(meta.author.as_deref(), Some("Engine"));
        assert_eq!(meta.subject, None);

        let plain =
            fixtures::build_pdf(&fixtures::pdf_spec("1.7", vec![(612.0, 792.0, None)], None));
        let plain_doc = super::super::loader::load_pdf(&plain).expect("fixture loads");
        assert_eq!(plain_doc.metadata(), PdfMetadata::default());
    }

    #[test]
    fn decodes_utf16_metadata() {
        let bytes = fixtures::build_pdf(&fixtures::pdf_spec(
            "1.7",
            vec![(612.0, 792.0, None)],
            Some(fixtures::InfoSpec {
                subject: Some("T\u{00e9}st \u{4e2d}".to_string()),
                ..fixtures::InfoSpec::default()
            }),
        ));
        let doc = super::super::loader::load_pdf(&bytes).expect("fixture loads");
        assert_eq!(
            doc.metadata().subject.as_deref(),
            Some("T\u{00e9}st \u{4e2d}")
        );
    }
}
