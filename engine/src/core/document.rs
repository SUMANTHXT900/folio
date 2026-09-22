//! Generic document abstraction, independent of storage and UI.
//!
//! The core never touches a filesystem, OPFS, IndexedDB, or browser API.
//! Storage lives outside this crate; it hands the core a [`Document`] whose
//! data is either inline bytes or an opaque reference the outer layer can
//! resolve.

use std::fmt;

use crate::core::error::{EngineError, ErrorCode};

/// Opaque document identifier.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DocumentId(String);

impl DocumentId {
    /// Creates an identifier from a caller-provided unique string.
    pub fn new(id: impl Into<String>) -> Result<Self, EngineError> {
        let id = id.into();
        if id.trim().is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidDocument,
                "document id must not be empty",
            ));
        }
        Ok(Self(id))
    }

    /// Returns the identifier as a string slice.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DocumentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Document media type / format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaType {
    /// Portable Document Format.
    Pdf,
    /// A format the core does not model yet. Carries the MIME string.
    Other(String),
}

impl MediaType {
    /// MIME string for this media type.
    #[must_use]
    pub fn mime(&self) -> &str {
        match self {
            Self::Pdf => "application/pdf",
            Self::Other(mime) => mime.as_str(),
        }
    }
}

/// How the document bytes reach the engine.
///
/// `Inline` carries bytes directly (e.g. handed over from a future
/// WASM/TS boundary). `Reference` carries an opaque handle that only the
/// outer storage layer understands; the core must treat it as opaque.
#[derive(Debug, Clone)]
pub enum DocumentData {
    /// Bytes provided directly to the engine.
    Inline(Vec<u8>),
    /// Opaque handle resolved by the outer storage layer, not by the core.
    Reference(String),
}

/// A document, independent of UI, filesystem, or browser storage.
#[derive(Debug, Clone)]
pub struct Document {
    id: DocumentId,
    media_type: MediaType,
    size_bytes: u64,
    name: Option<String>,
    data: DocumentData,
}

impl Document {
    /// Creates a document from inline bytes.
    pub fn from_bytes(
        id: DocumentId,
        media_type: MediaType,
        name: Option<String>,
        bytes: Vec<u8>,
    ) -> Result<Self, EngineError> {
        if bytes.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidDocument,
                "document bytes must not be empty",
            ));
        }
        let size_bytes = bytes.len() as u64;
        Ok(Self {
            id,
            media_type,
            size_bytes,
            name,
            data: DocumentData::Inline(bytes),
        })
    }

    /// Creates a document handle whose bytes stay with the outer storage layer.
    pub fn from_reference(
        id: DocumentId,
        media_type: MediaType,
        name: Option<String>,
        size_bytes: u64,
        reference: impl Into<String>,
    ) -> Result<Self, EngineError> {
        let reference = reference.into();
        if reference.trim().is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidDocument,
                "document reference must not be empty",
            ));
        }
        Ok(Self {
            id,
            media_type,
            size_bytes,
            name,
            data: DocumentData::Reference(reference),
        })
    }

    /// Returns the document identifier.
    #[must_use]
    pub fn id(&self) -> &DocumentId {
        &self.id
    }

    /// Returns the media type / format.
    #[must_use]
    pub fn media_type(&self) -> &MediaType {
        &self.media_type
    }

    /// Returns the declared size in bytes.
    #[must_use]
    pub fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    /// Returns the optional human-readable name.
    #[must_use]
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// Returns the document data or reference.
    #[must_use]
    pub fn data(&self) -> &DocumentData {
        &self.data
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_id() -> DocumentId {
        DocumentId::new("doc-1").expect("test id")
    }

    #[test]
    fn rejects_empty_document_id() {
        assert!(DocumentId::new("   ").is_err());
    }

    #[test]
    fn rejects_empty_bytes() {
        let err = Document::from_bytes(test_id(), MediaType::Pdf, None, Vec::new())
            .expect_err("empty bytes must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
    }

    #[test]
    fn creates_inline_document_with_size() {
        let doc = Document::from_bytes(
            test_id(),
            MediaType::Pdf,
            Some("a.pdf".into()),
            vec![1, 2, 3],
        )
        .expect("valid document");
        assert_eq!(doc.size_bytes(), 3);
        assert!(matches!(doc.data(), DocumentData::Inline(_)));
    }

    #[test]
    fn creates_reference_document_without_reading_storage() {
        let doc =
            Document::from_reference(test_id(), MediaType::Pdf, None, 1024, "opfs://docs/abc")
                .expect("valid reference");
        assert_eq!(doc.size_bytes(), 1024);
        assert!(matches!(doc.data(), DocumentData::Reference(_)));
    }

    #[test]
    fn rejects_empty_reference() {
        assert!(Document::from_reference(test_id(), MediaType::Pdf, None, 10, "  ").is_err());
    }
}
