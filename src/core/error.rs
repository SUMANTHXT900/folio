//! Centralized typed error model.
//!
//! The public contract is [`EngineError`] with a stable [`ErrorCode`].
//! Low-level library errors must be translated into engine errors at
//! module boundaries, never leaked directly.

use std::fmt;
use std::time::SystemTime;

use crate::execution::job::JobId;

/// Stable, extensible error codes for the public API surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// Document failed validation (empty bytes, bad id, …).
    InvalidDocument,
    /// Malformed page-range expression.
    InvalidPageRange,
    /// Page number outside the document.
    PageOutOfRange,
    /// A page number appears more than once where uniqueness is required
    /// (e.g. a reorder permutation).
    DuplicatePage,
    /// Operation logic failed.
    ProcessingFailed,
    /// Execution was cancelled.
    Cancelled,
    /// Format is not supported by this operation.
    UnsupportedFormat,
    /// Underlying I/O failed (translated, never raw).
    IoError,
    /// Caller-provided input was invalid.
    InvalidInput,
    /// Caller-provided options were invalid.
    InvalidOptions,
    /// Catch-all for unexpected internal failures.
    Internal,
}

impl ErrorCode {
    /// Stable wire-friendly code string for the future TS API.
    #[must_use]
    pub const fn code_str(self) -> &'static str {
        match self {
            Self::InvalidDocument => "INVALID_DOCUMENT",
            Self::InvalidPageRange => "INVALID_PAGE_RANGE",
            Self::PageOutOfRange => "PAGE_OUT_OF_RANGE",
            Self::DuplicatePage => "DUPLICATE_PAGE",
            Self::ProcessingFailed => "PROCESSING_FAILED",
            Self::Cancelled => "CANCELLED",
            Self::UnsupportedFormat => "UNSUPPORTED_FORMAT",
            Self::IoError => "IO_ERROR",
            Self::InvalidInput => "INVALID_INPUT",
            Self::InvalidOptions => "INVALID_OPTIONS",
            Self::Internal => "INTERNAL",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code_str())
    }
}

/// A structured engine error.
#[derive(Debug, Clone)]
pub struct EngineError {
    code: ErrorCode,
    message: String,
    operation: Option<String>,
    job_id: Option<JobId>,
    timestamp: SystemTime,
    details: Option<String>,
}

impl EngineError {
    /// Creates an error with a code and human-readable message.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            operation: None,
            job_id: None,
            // Platform clock (JS-backed on WASM, where `SystemTime::now()` panics).
            timestamp: super::clock::wall_now(),
            details: None,
        }
    }

    /// Attaches the operation name.
    #[must_use]
    pub fn with_operation(mut self, operation: impl Into<String>) -> Self {
        self.operation = Some(operation.into());
        self
    }

    /// Attaches the job id.
    #[must_use]
    pub fn with_job_id(mut self, job_id: JobId) -> Self {
        self.job_id = Some(job_id);
        self
    }

    /// Attaches extra diagnostic details.
    #[must_use]
    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }

    /// Returns the stable error code.
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    /// Returns the human-readable message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Returns the operation name, if attached.
    #[must_use]
    pub fn operation(&self) -> Option<&str> {
        self.operation.as_deref()
    }

    /// Returns the job id, if attached.
    #[must_use]
    pub fn job_id(&self) -> Option<&JobId> {
        self.job_id.as_ref()
    }

    /// Returns when the error was created (wall clock).
    #[must_use]
    pub const fn timestamp(&self) -> SystemTime {
        self.timestamp
    }

    /// Returns extra diagnostic details, if attached.
    #[must_use]
    pub fn details(&self) -> Option<&str> {
        self.details.as_deref()
    }

    /// Convenience constructor for cancellations.
    #[must_use]
    pub fn cancelled(job_id: &JobId, operation: &str) -> Self {
        Self::new(ErrorCode::Cancelled, "operation was cancelled")
            .with_job_id(job_id.clone())
            .with_operation(operation)
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for EngineError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_are_stable_strings() {
        assert_eq!(ErrorCode::InvalidDocument.code_str(), "INVALID_DOCUMENT");
        assert_eq!(ErrorCode::Cancelled.code_str(), "CANCELLED");
        assert_eq!(ErrorCode::ProcessingFailed.code_str(), "PROCESSING_FAILED");
    }

    #[test]
    fn error_carries_context() {
        let job = JobId::new();
        let err = EngineError::new(ErrorCode::PageOutOfRange, "page 99 missing")
            .with_operation("pdf.extract")
            .with_job_id(job.clone())
            .with_details("document has 12 pages");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert_eq!(err.operation(), Some("pdf.extract"));
        assert_eq!(err.job_id(), Some(&job));
        assert_eq!(err.details(), Some("document has 12 pages"));
        assert!(err.to_string().contains("PAGE_OUT_OF_RANGE"));
    }
}
