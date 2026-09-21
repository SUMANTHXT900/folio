//! ```text
//! processing/pdf/metadata/
//! ├── date.rs    PdfDate: typed PDF dates (parse/format/validate)
//! ├── model.rs   DocumentMetadata + MetadataPatch (patch semantics)
//! ├── read.rs    pdf.read_metadata (read-only inspection)
//! └── write.rs   pdf.set_metadata (patch application)
//! ```
//!
//! Typed metadata subsystem (Lesson 15). The sibling `inspect` operation
//! keeps its frozen raw-string summary; this module owns the authoritative
//! editable model. `lopdf` never leaves `core` — sibling operations work
//! through [`PdfDocument`](super::core::PdfDocument) methods.

pub mod date;
pub mod model;
pub mod read;
pub mod write;

pub use date::{format_pdf_date, parse_pdf_date, PdfDate};
pub use model::{DocumentMetadata, FieldPatch, MetadataPatch};
pub use read::{ReadMetadataInput, ReadMetadataOperation, ReadMetadataOptions, ReadMetadataOutput};
pub use write::{SetMetadataInput, SetMetadataOperation, SetMetadataOptions, SetMetadataOutput};
