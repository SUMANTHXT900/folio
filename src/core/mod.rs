//! Core domain types: documents, operations, errors, results.
//!
//! This layer knows nothing about scheduling, storage, UI, or runtimes.

pub mod clock;
pub mod document;
pub mod error;
pub mod operation;
pub mod result;

pub use document::{Document, DocumentData, DocumentId, MediaType};
pub use error::{EngineError, ErrorCode};
pub use operation::{Operation, OperationCapabilities, OperationContext, ParallelismHint};
pub use result::{CompletionStatus, OperationResult};
