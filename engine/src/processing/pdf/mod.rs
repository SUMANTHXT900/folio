//! ```text
//! processing/pdf/
//! ├── core/      shared primitives: PdfDocument, loader, page copying
//! │              (no lopdf leakage past this module)
//! ├── inspect/   pdf.inspect (read-only)
//! ├── metadata/  pdf.read_metadata + pdf.set_metadata (typed metadata)
//! ├── extract/   pdf.extract_pages (new-document transformation)
//! ├── split/     pdf.split (multi-part orchestration over the copy primitive)
//! ├── reorder/   pdf.reorder (full permutation over the copy primitive)
//! ├── delete/    pdf.delete_pages (subtractive selection over the copy primitive)
//! ├── rotate/    pdf.rotate (relative rotation over a full copy)
//! ├── merge/     pdf.merge (multi-document assembly over cross-document copy)
//! └── …
//! ```
//!
//! Each operation implements
//! [`Operation`](crate::core::operation::Operation) independently.

pub mod core;
pub mod delete;
pub mod extract;
pub mod images_to_pdf;
pub mod inspect;
pub mod merge;
pub mod metadata;
pub mod reorder;
pub mod rotate;
pub mod split;
