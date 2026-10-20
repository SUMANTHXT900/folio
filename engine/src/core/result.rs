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
    /// Enforces `started_at <= completed_at`: panics in debug builds on
    /// inverted timestamps, and saturates `completed_at` up to `started_at`
    /// in release builds so the invariant always holds.
    fn order_timestamps(
        started_at: SystemTime,
        completed_at: SystemTime,
    ) -> (SystemTime, SystemTime) {
        debug_assert!(
            started_at <= completed_at,
            "OperationResult timestamps out of order: started_at > completed_at"
        );
        if started_at > completed_at {
            (started_at, started_at)
        } else {
            (started_at, completed_at)
        }
    }

    /// Builds a successful result.
    pub fn success(
        job_id: JobId,
        operation: impl Into<String>,
        started_at: SystemTime,
        completed_at: SystemTime,
        duration: Duration,
        value: T,
    ) -> Self {
        let (started_at, completed_at) = Self::order_timestamps(started_at, completed_at);
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
        let (started_at, completed_at) = Self::order_timestamps(started_at, completed_at);
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

    #[test]
    fn success_preserves_ordered_timestamps() {
        let early = SystemTime::now();
        let late = early + Duration::from_secs(1);
        let r: OperationResult<String> = OperationResult::success(
            JobId::new(),
            "test.op",
            early,
            late,
            Duration::from_millis(1),
            "ok".into(),
        );
        assert_eq!(r.started_at(), early);
        assert_eq!(r.completed_at(), late);
    }

    #[test]
    fn failure_preserves_ordered_timestamps() {
        let early = SystemTime::now();
        let late = early + Duration::from_secs(1);
        let job = JobId::new();
        let r: OperationResult<String> = OperationResult::failure(
            job,
            "test.op",
            early,
            late,
            Duration::from_millis(1),
            EngineError::new(ErrorCode::ProcessingFailed, "boom"),
        );
        assert_eq!(r.started_at(), early);
        assert_eq!(r.completed_at(), late);
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic]
    fn inverted_timestamps_panic_in_debug() {
        let early = SystemTime::now();
        let late = early + Duration::from_secs(1);
        let _: OperationResult<String> = OperationResult::success(
            JobId::new(),
            "test.op",
            late,
            early,
            Duration::from_millis(1),
            "ok".into(),
        );
    }

    #[test]
    #[cfg(not(debug_assertions))]
    fn inverted_timestamps_saturate_in_release() {
        let early = SystemTime::now();
        let late = early + Duration::from_secs(1);
        let r: OperationResult<String> = OperationResult::success(
            JobId::new(),
            "test.op",
            late,
            early,
            Duration::from_millis(1),
            "ok".into(),
        );
        assert_eq!(r.started_at(), late);
        assert_eq!(r.completed_at(), late);
    }
}
