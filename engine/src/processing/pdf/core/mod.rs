//! Shared PDF primitives and the [`PdfDocument`] abstraction.
//!
//! `lopdf` is used only inside this module: `loader` (parsing),
//! `document` (structural reads), `copy` (page-copy transformation).
//! Operations in sibling modules (e.g. `inspect`, `extract`) work through
//! [`PdfDocument`] and never touch `lopdf`.

pub mod document;
pub mod loader;

pub(crate) mod copy;

#[cfg(test)]
pub(crate) mod fixtures;

pub use document::{PageGeometry, PdfDocument, PdfMetadata};
pub use loader::load_pdf;

/// A 1-based page number, as used at every public operation boundary.
///
/// Page 1 is the first page of the document. Internal `lopdf` indexing
/// details never leak past this type alias.
pub type PageNumber = u32;

/// MIME type identifying PDF documents.
pub const PDF_MIME_TYPE: &str = "application/pdf";

/// Returns `true` when the MIME string identifies a PDF.
#[must_use]
pub fn is_pdf_mime(mime: &str) -> bool {
    mime == PDF_MIME_TYPE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_pdf_mime() {
        assert!(is_pdf_mime("application/pdf"));
        assert!(!is_pdf_mime("image/png"));
    }
}
