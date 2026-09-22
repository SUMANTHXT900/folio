//! Generic operation model: `Input + Options -> Operation -> Result`.
//!
//! Strongly typed per operation: no untyped `HashMap<String, Value>`
//! plumbing inside the core.

use crate::core::error::EngineError;
use crate::execution::job::JobId;

/// Describes how an operation may be executed.
///
/// The scheduler reads this metadata; operations never schedule themselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParallelismHint {
    /// Must run sequentially (e.g. structural rewrites like reorder).
    Sequential,
    /// Sequential orchestration, but sub-work may run in parallel
    /// (e.g. page analysis or rendering inside an otherwise ordered op).
    SubTaskParallel,
    /// Work items are independent (e.g. per-page rendering).
    FullyParallel,
}

/// Execution characteristics declared by an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OperationCapabilities {
    /// Whether and how the work can be parallelized.
    pub parallelism: ParallelismHint,
    /// Whether the operation emits progress events.
    pub supports_progress: bool,
    /// Whether the operation observes cancellation.
    pub supports_cancellation: bool,
    /// Whether the operation can stream partial output.
    pub supports_streaming: bool,
}

impl OperationCapabilities {
    /// Lightweight metadata-style operation: sequential, no progress needed.
    #[must_use]
    pub const fn sequential_lightweight() -> Self {
        Self {
            parallelism: ParallelismHint::Sequential,
            supports_progress: false,
            supports_cancellation: false,
            supports_streaming: false,
        }
    }

    /// Page-oriented operation that may parallelize sub-work later.
    #[must_use]
    pub const fn parallel_friendly() -> Self {
        Self {
            parallelism: ParallelismHint::SubTaskParallel,
            supports_progress: true,
            supports_cancellation: true,
            supports_streaming: false,
        }
    }
}

/// Minimal context an operation may use while running.
///
/// Defined in the core so the dependency points the right way:
/// execution implements this trait; operations only observe it.
/// Operations must not know about engines, schedulers, or storage.
pub trait OperationContext {
    /// Identifier of the job this execution belongs to.
    fn job_id(&self) -> &JobId;
    /// Human-readable operation name for diagnostics.
    fn operation_name(&self) -> &str;
    /// Emits a structured progress event for this job.
    fn report_progress(
        &self,
        phase: Option<&str>,
        completed: u64,
        total: u64,
        message: Option<&str>,
    );
    /// Returns `true` when cancellation has been requested.
    fn is_cancelled(&self) -> bool;
    /// Returns a [`EngineError`] when cancellation was requested.
    fn check_cancellation(&self) -> Result<(), EngineError>;
}

/// A single processing operation with strongly typed I/O.
///
/// Each PDF capability (inspect, split, merge, …) will implement this
/// trait in its own module without touching unrelated operations.
pub trait Operation {
    /// Validated input document(s) and data for this operation.
    type Input;
    /// Validated knobs for this operation.
    type Options;
    /// Typed success value produced by this operation.
    type Output;

    /// Stable operation name (e.g. `"pdf.inspect"`).
    fn name(&self) -> &'static str;
    /// Execution characteristics consumed by the scheduler.
    fn capabilities(&self) -> OperationCapabilities;
    /// Runs the operation, reporting progress/cancellation via `ctx`.
    ///
    /// Implementations must not manage timers: the execution layer
    /// records timestamps and durations automatically.
    fn execute<C: OperationContext>(
        &self,
        ctx: &C,
        input: Self::Input,
        options: Self::Options,
    ) -> Result<Self::Output, EngineError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Ctx {
        id: JobId,
    }

    impl OperationContext for Ctx {
        fn job_id(&self) -> &JobId {
            &self.id
        }
        fn operation_name(&self) -> &str {
            "test.op"
        }
        fn report_progress(
            &self,
            _phase: Option<&str>,
            _completed: u64,
            _total: u64,
            _message: Option<&str>,
        ) {
        }
        fn is_cancelled(&self) -> bool {
            false
        }
        fn check_cancellation(&self) -> Result<(), EngineError> {
            Ok(())
        }
    }

    struct Echo;

    impl Operation for Echo {
        type Input = String;
        type Options = ();
        type Output = String;

        fn name(&self) -> &'static str {
            "test.echo"
        }

        fn capabilities(&self) -> OperationCapabilities {
            OperationCapabilities::sequential_lightweight()
        }

        fn execute<C: OperationContext>(
            &self,
            _ctx: &C,
            input: String,
            _options: (),
        ) -> Result<String, EngineError> {
            Ok(input)
        }
    }

    #[test]
    fn operation_keeps_strong_typing() {
        let ctx = Ctx { id: JobId::new() };
        let out = Echo
            .execute(&ctx, "hello".to_string(), ())
            .expect("echo works");
        assert_eq!(out, "hello");
        assert_eq!(
            Echo.capabilities(),
            OperationCapabilities::sequential_lightweight()
        );
    }
}
