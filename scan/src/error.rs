//! Scan error model: small, structured, never panics on untrusted input.

use std::fmt;

/// Machine-readable failure classes for the scan pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanErrorKind {
    /// Input bytes are empty or undecodable as JPEG/PNG.
    InvalidInput,
    /// Image dimensions are zero or absurd (overflow-safe guards).
    UnsupportedDimensions,
    /// Detection ran but found no usable quadrilateral.
    NoDocument,
    /// A validated quad still failed to warp (numerical degeneracy).
    WarpFailed,
    /// JPEG re-encoding failed.
    EncodeFailed,
}

/// Structured scan error with a message plus optional details.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanError {
    kind: ScanErrorKind,
    message: String,
    details: Option<String>,
}

impl ScanError {
    #[must_use]
    pub fn new(kind: ScanErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }

    #[must_use]
    pub const fn kind(&self) -> ScanErrorKind {
        self.kind
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    #[must_use]
    pub fn details(&self) -> Option<&str> {
        self.details.as_deref()
    }
}

impl fmt::Display for ScanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.details {
            Some(d) => write!(f, "{} ({})", self.message, d),
            None => write!(f, "{}", self.message),
        }
    }
}

impl std::error::Error for ScanError {}
