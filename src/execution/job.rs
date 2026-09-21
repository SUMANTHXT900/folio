//! Job identity and lifecycle states.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

/// Process-unique counter backing [`JobId`].
///
/// Zero-dependency and portable (including future WASM): uniqueness is
/// guaranteed within a process, which is the scope the engine schedules.
/// The WASM/TS boundary may map ids to strings; see `ARCHITECTURE.md`.
static JOB_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Unique identifier for one operation execution.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct JobId(String);

impl JobId {
    /// Creates a new unique job id.
    #[must_use]
    pub fn new() -> Self {
        let n = JOB_COUNTER.fetch_add(1, Ordering::Relaxed);
        Self(format!("job-{n}"))
    }

    /// Returns the identifier as a string slice.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for JobId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for JobId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Lifecycle state of a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    /// Created but not yet running.
    Pending,
    /// Currently executing.
    Running,
    /// Finished with a typed result.
    Completed,
    /// Finished with a structured error.
    Failed,
    /// Stopped via the cancellation abstraction.
    Cancelled,
}

impl JobState {
    /// Returns `true` for terminal states.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// A job: one operation execution with an observable lifecycle.
///
/// State transitions are validated: `Pending -> Running -> terminal`.
/// Extensible: future fields (priority, retry policy) attach here,
// not inside operations.
#[derive(Debug, Clone)]
pub struct Job {
    id: JobId,
    operation: String,
    state: JobState,
}

impl Job {
    /// Creates a job in [`JobState::Pending`].
    #[must_use]
    pub fn new(operation: impl Into<String>) -> Self {
        Self {
            id: JobId::new(),
            operation: operation.into(),
            state: JobState::Pending,
        }
    }

    /// Returns the job id.
    #[must_use]
    pub fn id(&self) -> &JobId {
        &self.id
    }

    /// Returns the operation name.
    #[must_use]
    pub fn operation(&self) -> &str {
        &self.operation
    }

    /// Returns the current state.
    #[must_use]
    pub const fn state(&self) -> JobState {
        self.state
    }

    /// Marks the job running. Only valid from [`JobState::Pending`].
    pub fn mark_running(&mut self) -> bool {
        if self.state == JobState::Pending {
            self.state = JobState::Running;
            true
        } else {
            false
        }
    }

    /// Moves to a terminal state. Only valid from [`JobState::Running`].
    pub fn mark_terminal(&mut self, state: JobState) -> bool {
        if self.state == JobState::Running && state.is_terminal() {
            self.state = state;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn job_ids_are_unique() {
        let ids: HashSet<String> = (0..100).map(|_| JobId::new().to_string()).collect();
        assert_eq!(ids.len(), 100);
    }

    #[test]
    fn job_lifecycle_transitions_are_validated() {
        let mut job = Job::new("test.op");
        assert_eq!(job.state(), JobState::Pending);
        assert!(!job.state().is_terminal());

        assert!(job.mark_running());
        assert_eq!(job.state(), JobState::Running);

        // Second transition to running is rejected.
        assert!(!job.mark_running());

        assert!(job.mark_terminal(JobState::Completed));
        assert!(job.state().is_terminal());
    }

    #[test]
    fn terminal_transition_requires_running() {
        let mut job = Job::new("test.op");
        assert!(!job.mark_terminal(JobState::Completed));
        assert_eq!(job.state(), JobState::Pending);
    }
}
