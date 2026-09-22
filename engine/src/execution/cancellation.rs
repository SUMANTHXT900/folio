//! Cooperative cancellation abstraction.
//!
//! Flow: job -> cancellation requested -> operation observes via the
//! context -> stops safely -> engine reports a `Cancelled` result.
//! No global state; tokens are cheap to clone and thread-safe.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::core::error::EngineError;
use crate::execution::job::JobId;

/// Thread-safe flag an operation polls while running.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    /// Creates an uncancelled token.
    #[must_use]
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Requests cancellation.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// Returns `true` once cancellation has been requested.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Returns a [`EngineError`] of code `CANCELLED` when requested.
    pub fn check(&self, job_id: &JobId, operation: &str) -> Result<(), EngineError> {
        if self.is_cancelled() {
            Err(EngineError::cancelled(job_id, operation))
        } else {
            Ok(())
        }
    }
}

/// Creates and owns the cancellation token for one execution.
#[derive(Debug, Default)]
pub struct CancellationSource {
    token: CancellationToken,
}

impl CancellationSource {
    /// Creates a fresh source with an uncancelled token.
    #[must_use]
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
        }
    }

    /// Returns a clone of the token to hand to the execution context.
    #[must_use]
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    /// Requests cancellation for the associated execution.
    pub fn cancel(&self) {
        self.token.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_starts_uncancelled() {
        let source = CancellationSource::new();
        assert!(!source.token().is_cancelled());
    }

    #[test]
    fn cancellation_propagates_to_cloned_tokens() {
        let source = CancellationSource::new();
        let token = source.token();
        source.cancel();
        assert!(token.is_cancelled());
        let err = token
            .check(&JobId::new(), "test.op")
            .expect_err("cancelled token must error");
        assert_eq!(err.code(), crate::core::error::ErrorCode::Cancelled);
    }
}
