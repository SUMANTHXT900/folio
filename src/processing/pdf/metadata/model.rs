//! Authoritative editable metadata model (`DocumentMetadata`) and patch
//! semantics (`MetadataPatch`).
//!
//! Field mapping (application API → PDF Info dictionary key):
//!
//! ```text
//! title             → /Title
//! author            → /Author
//! subject           → /Subject
//! keywords          → /Keywords
//! creator           → /Creator
//! producer          → /Producer
//! creation_date     → /CreationDate
//! modification_date → /ModDate
//! ```
//!
//! The PDF key names never appear in the public API: callers work with
//! these semantic fields only, keeping the API PDF-library-independent.
//!
//! Relationship to `inspect`: `pdf.inspect` keeps returning the raw
//! summary model (`core::PdfMetadata`, dates as raw strings) — a frozen,
//! lightweight shape. This module's [`DocumentMetadata`] (typed dates)
//! is the authoritative model for reading and editing. The distinction
//! is deliberate: inspection stays cheap and stable, editing gets types.
//!
//! Custom Info keys are intentionally unsupported: arbitrary dictionary
//! editing is out of scope, so no raw `lopdf` dictionaries leak through
//! this API.

use super::date::{parse_pdf_date, PdfDate};
use crate::processing::pdf::core::PdfMetadata as RawMetadata;

/// Authoritative editable document metadata.
///
/// Every field is optional: absent metadata is [`None`], never an error.
/// Unlike the inspect summary, dates are typed ([`PdfDate`]) — malformed
/// raw date strings normalize to [`None`] on read (they never fail the
/// read; see [`DocumentMetadata::from_raw`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocumentMetadata {
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
    /// Creation date (`/CreationDate`), typed.
    pub creation_date: Option<PdfDate>,
    /// Modification date (`/ModDate`), typed.
    pub modification_date: Option<PdfDate>,
}

impl DocumentMetadata {
    /// Converts raw inspect-style metadata into the editable model.
    /// String fields pass through; date strings that do not parse become
    /// [`None`] (malformed dates never fail a read — they are simply
    /// unrepresentable in the typed model).
    #[must_use]
    pub fn from_raw(raw: &RawMetadata) -> Self {
        Self {
            title: raw.title.clone(),
            author: raw.author.clone(),
            subject: raw.subject.clone(),
            keywords: raw.keywords.clone(),
            creator: raw.creator.clone(),
            producer: raw.producer.clone(),
            creation_date: raw.creation_date.as_deref().and_then(parse_pdf_date),
            modification_date: raw.modification_date.as_deref().and_then(parse_pdf_date),
        }
    }
}

/// Patch state for one metadata field.
///
/// A plain `Option<String>` cannot distinguish "leave unchanged" from
/// "set empty", so the patch is explicit: [`FieldPatch::Unchanged`]
/// preserves whatever the document carries (including malformed raw
/// values, which are never touched), [`FieldPatch::Set`] writes a value,
/// [`FieldPatch::Clear`] removes the key from the Info dictionary
/// (never replaced by an empty string).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum FieldPatch<T> {
    /// Leave the field exactly as the document carries it.
    #[default]
    Unchanged,
    /// Write this value (validated before anything is mutated).
    Set(T),
    /// Remove the field from the Info dictionary.
    Clear,
}

impl<T> FieldPatch<T> {
    /// Returns `true` for [`FieldPatch::Unchanged`].
    #[must_use]
    pub const fn is_unchanged(&self) -> bool {
        matches!(self, Self::Unchanged)
    }
}

/// Patch over every supported metadata field.
///
/// Absent intent is [`FieldPatch::Unchanged`] per field, so callers send
/// only what they mean to change. [`MetadataPatch::is_empty`] reports a
/// patch that changes nothing (a valid no-op rewrite, never an error).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MetadataPatch {
    /// New title, or clear/unchanged.
    pub title: FieldPatch<String>,
    /// New author, or clear/unchanged.
    pub author: FieldPatch<String>,
    /// New subject, or clear/unchanged.
    pub subject: FieldPatch<String>,
    /// New keywords, or clear/unchanged.
    pub keywords: FieldPatch<String>,
    /// New creator, or clear/unchanged.
    pub creator: FieldPatch<String>,
    /// New producer, or clear/unchanged.
    pub producer: FieldPatch<String>,
    /// New creation date, or clear/unchanged.
    pub creation_date: FieldPatch<PdfDate>,
    /// New modification date, or clear/unchanged.
    pub modification_date: FieldPatch<PdfDate>,
}

impl MetadataPatch {
    /// Returns `true` when every field is [`FieldPatch::Unchanged`].
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.title.is_unchanged()
            && self.author.is_unchanged()
            && self.subject.is_unchanged()
            && self.keywords.is_unchanged()
            && self.creator.is_unchanged()
            && self.producer.is_unchanged()
            && self.creation_date.is_unchanged()
            && self.modification_date.is_unchanged()
    }

    /// Returns `true` when at least one field is [`FieldPatch::Set`]
    /// (i.e. applying the patch may create an Info dictionary).
    #[must_use]
    pub fn has_sets(&self) -> bool {
        matches!(self.title, FieldPatch::Set(_))
            || matches!(self.author, FieldPatch::Set(_))
            || matches!(self.subject, FieldPatch::Set(_))
            || matches!(self.keywords, FieldPatch::Set(_))
            || matches!(self.creator, FieldPatch::Set(_))
            || matches!(self.producer, FieldPatch::Set(_))
            || matches!(self.creation_date, FieldPatch::Set(_))
            || matches!(self.modification_date, FieldPatch::Set(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_raw_converts_dates_and_passes_strings() {
        let raw = RawMetadata {
            title: Some("Report".to_string()),
            author: None,
            subject: Some("S".to_string()),
            keywords: None,
            creator: None,
            producer: Some("P".to_string()),
            creation_date: Some("D:20260123093000+05'30'".to_string()),
            modification_date: Some("not a date".to_string()),
        };
        let model = DocumentMetadata::from_raw(&raw);
        assert_eq!(model.title.as_deref(), Some("Report"));
        assert_eq!(model.author, None);
        let created = model.creation_date.expect("valid date converts");
        assert_eq!(created.year, 2026);
        assert_eq!(created.tz_offset_minutes, 330);
        // Malformed dates normalize to None — the read itself succeeds.
        assert_eq!(model.modification_date, None);
    }

    #[test]
    fn patch_emptiness_and_sets() {
        assert!(MetadataPatch::default().is_empty());
        assert!(!MetadataPatch::default().has_sets());
        let patch = MetadataPatch {
            title: FieldPatch::Set("T".to_string()),
            ..MetadataPatch::default()
        };
        assert!(!patch.is_empty());
        assert!(patch.has_sets());
        let clear_only = MetadataPatch {
            author: FieldPatch::Clear,
            ..MetadataPatch::default()
        };
        assert!(!clear_only.is_empty());
        assert!(!clear_only.has_sets());
    }
}
