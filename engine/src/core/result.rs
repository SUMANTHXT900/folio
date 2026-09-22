//! Consistent result abstraction for successful and failed executions.

use std::time::{Duration, SystemTime};

use crate::core::error::EngineError;
use crate::execution::job::JobId;

/// Terminal status of an execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionStatus {
    /// Operation produced its typed output.
    Completed,
    /// Operation returned a structured [`EngineError`].
    Failed,
    /// Operation observed cancellation and stopped safely.
    Cancelled,
}

/// The complete record of one operation execution.
///
/// Built by the execution layer (never by operations themselves) so that
/// timestamps and durations are always captured automatically.
#[derive(Debug, Clone)]
pub struct OperationResult<T> {
    job_id: JobId,
    operation: String,
    status: CompletionStatus,
    started_at: SystemTime,
    completed_at: SystemTime,
    duration: Duration,
    outcome: Result<T, EngineError>,
}

impl<T> OperationResult<T> {
    /// Builds a successful result.
    pub fn success(
        job_id: JobId,
        operation: impl Into<String>,
        started_at: SystemTime,
        completed_at: SystemTime,
        duration: Duration,
        value: T,
    ) -> Self {
        Self {
            job_id,
            operation: operation.into(),
            status: CompletionStatus::Completed,
            started_at,
            completed_at,
            duration,
            outcome: Ok(value),
        }
    }

    /// Builds a failed (or cancelled) result from a structured error.
    pub fn failure(
        job_id: JobId,
        operation: impl Into<String>,
        started_at: SystemTime,
        completed_at: SystemTime,
        duration: Duration,
        error: EngineError,
    ) -> Self {
        let status = if error.code() == crate::core::error::ErrorCode::Cancelled {
            CompletionStatus::Cancelled
        } else {
            CompletionStatus::Failed
        };
        Self {
            job_id,
            operation: operation.into(),
            status,
            started_at,
            completed_at,
            duration,
            outcome: Err(error),
        }
    }

    /// Returns the job identifier.
    #[must_use]
    pub fn job_id(&self) -> &JobId {
        &self.job_id
    }

    /// Returns the operation name.
    #[must_use]
    pub fn operation(&self) -> &str {
        &self.operation
    }

    /// Returns the terminal status.
    #[must_use]
    pub const fn status(&self) -> CompletionStatus {
        self.status
    }

    /// Returns `true` for successful executions.
    #[must_use]
    pub const fn is_success(&self) -> bool {
        matches!(self.status, CompletionStatus::Completed)
    }

    /// Returns the wall-clock start time.
    #[must_use]
    pub const fn started_at(&self) -> SystemTime {
        self.started_at
    }

    /// Returns the wall-clock completion time.
    #[must_use]
    pub const fn completed_at(&self) -> SystemTime {
        self.completed_at
    }

    /// Returns the monotonically measured duration.
    #[must_use]
    pub const fn duration(&self) -> Duration {
        self.duration
    }

    /// Borrows the typed outcome.
    pub const fn outcome(&self) -> &Result<T, EngineError> {
        &self.outcome
    }

    /// Converts into the typed outcome.
    pub fn into_outcome(self) -> Result<T, EngineError> {
        self.outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::error::ErrorCode;

    fn sample_times() -> (SystemTime, SystemTime, Duration) {
        let start = SystemTime::now();
        (start, start, Duration::from_millis(5))
    }

    #[test]
    fn success_result_reports_completed() {
        let (s, c, d) = sample_times();
        let r: OperationResult<String> =
            OperationResult::success(JobId::new(), "test.op", s, c, d, "ok".into());
        assert!(r.is_success());
        assert_eq!(r.status(), CompletionStatus::Completed);
        assert_eq!(r.duration(), d);
    }

    #[test]
    fn cancelled_error_maps_to_cancelled_status() {
        let (s, c, d) = sample_times();
        let job = JobId::new();
        let err = EngineError::cancelled(&job, "test.op");
        let r: OperationResult<String> = OperationResult::failure(job, "test.op", s, c, d, err);
        assert_eq!(r.status(), CompletionStatus::Cancelled);
        assert_eq!(
            r.outcome().as_ref().expect_err("must be err").code(),
            ErrorCode::Cancelled
        );
    }
}
