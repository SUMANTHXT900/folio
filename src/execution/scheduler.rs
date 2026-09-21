//! Scheduler boundary and the default inline execution engine.
//!
//! The future scheduler will choose strategies (inline vs. parallel chunks,
//! bounded concurrency) from [`OperationCapabilities`](crate::core::operation::OperationCapabilities).
//! Lesson 0 deliberately runs everything inline: the boundary exists, the
//! worker pool does not.

use std::sync::Arc;

use crate::core::error::EngineError;
use crate::core::operation::{Operation, OperationCapabilities};
use crate::core::result::OperationResult;
use crate::execution::cancellation::{CancellationSource, CancellationToken};
use crate::execution::context::ExecutionContext;
use crate::execution::job::JobId;
use crate::execution::progress::{NoopProgressSink, ProgressSink};
use crate::observability::event::{EngineEvent, LogLevel};
use crate::observability::logger::{EventSink, NoopEventSink};
use crate::observability::timing::{wall_now, Timer};

/// How the scheduler wants to run a unit of work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionStrategy {
    /// Run inline on the calling thread. The only Lesson 0 strategy.
    Inline,
    /// Reserved: run with bounded parallelism (worker count + chunking
    /// decided per operation and workload, never `1 page = 1 worker`).
    Parallel {
        /// Maximum concurrent workers for this execution.
        max_workers: usize,
    },
}

/// Policy that maps operation capabilities to an execution strategy.
///
/// Future implementations inspect workload size and capabilities to pick
/// chunking and concurrency limits. Lesson 0 always returns [`Inline`](ExecutionStrategy::Inline).
pub trait SchedulerPolicy: Send + Sync {
    /// Selects the strategy for the given capabilities.
    fn strategy_for(&self, capabilities: &OperationCapabilities) -> ExecutionStrategy;
}

/// Trivial policy: everything runs inline.
#[derive(Debug, Default)]
pub struct InlineScheduler;

impl SchedulerPolicy for InlineScheduler {
    fn strategy_for(&self, _capabilities: &OperationCapabilities) -> ExecutionStrategy {
        ExecutionStrategy::Inline
    }
}

/// Executes operations: assigns job ids, captures timing automatically,
/// wires progress/cancellation/events, and returns typed results.
pub struct ExecutionEngine {
    progress: Arc<dyn ProgressSink>,
    events: Arc<dyn EventSink>,
    scheduler: Arc<dyn SchedulerPolicy>,
}

impl ExecutionEngine {
    /// Creates an engine with default (no-op) observability and inline scheduling.
    #[must_use]
    pub fn new() -> Self {
        Self {
            progress: Arc::new(NoopProgressSink),
            events: Arc::new(NoopEventSink),
            scheduler: Arc::new(InlineScheduler),
        }
    }

    /// Sets the progress sink.
    #[must_use]
    pub fn with_progress(mut self, sink: Arc<dyn ProgressSink>) -> Self {
        self.progress = sink;
        self
    }

    /// Sets the event sink.
    #[must_use]
    pub fn with_events(mut self, sink: Arc<dyn EventSink>) -> Self {
        self.events = sink;
        self
    }

    /// Sets the scheduler policy.
    #[must_use]
    pub fn with_scheduler(mut self, scheduler: Arc<dyn SchedulerPolicy>) -> Self {
        self.scheduler = scheduler;
        self
    }

    /// Executes one operation with automatic timing and structured reporting.
    ///
    /// The operation never manages timers: `started_at` uses the wall clock
    /// while `duration` is measured with the monotonic clock ([`Instant`]).
    pub fn execute<O>(
        &self,
        operation: &O,
        input: O::Input,
        options: O::Options,
    ) -> OperationResult<O::Output>
    where
        O: Operation,
    {
        self.execute_with_cancellation(operation, input, options, CancellationToken::new())
    }

    /// Executes with a caller-provided cancellation token.
    pub fn execute_with_cancellation<O>(
        &self,
        operation: &O,
        input: O::Input,
        options: O::Options,
        cancellation: CancellationToken,
    ) -> OperationResult<O::Output>
    where
        O: Operation,
    {
        let _strategy = self.scheduler.strategy_for(&operation.capabilities());

        let job_id = JobId::new();
        let started_at = wall_now();
        // `Timer` (not raw `Instant`): `Instant::now()` panics on
        // `wasm32-unknown-unknown`; the timer samples `performance.now()`
        // there with identical native behavior here.
        let timer = Timer::start();

        self.events.record(
            EngineEvent::new(LogLevel::Info, format!("{} started", operation.name()))
                .with_job_id(job_id.clone())
                .with_operation(operation.name()),
        );

        let ctx = ExecutionContext::new(
            job_id.clone(),
            operation.name(),
            self.progress.clone(),
            cancellation,
        );

        let outcome: Result<O::Output, EngineError> = operation.execute(&ctx, input, options);

        let duration = timer.stop();
        let completed_at = wall_now();

        // Attach job/operation context to errors that lack it.
        let outcome = outcome.map_err(|err| {
            let with_job = if err.job_id().is_none() {
                err.with_job_id(job_id.clone())
            } else {
                err
            };
            if with_job.operation().is_none() {
                with_job.with_operation(operation.name())
            } else {
                with_job
            }
        });

        let level = if outcome.is_ok() {
            LogLevel::Info
        } else {
            LogLevel::Error
        };
        self.events.record(
            EngineEvent::new(
                level,
                format!(
                    "{} finished in {}ms",
                    operation.name(),
                    duration.as_millis()
                ),
            )
            .with_job_id(job_id.clone())
            .with_operation(operation.name()),
        );

        match outcome {
            Ok(value) => OperationResult::success(
                job_id,
                operation.name(),
                started_at,
                completed_at,
                duration,
                value,
            ),
            Err(error) => OperationResult::failure(
                job_id,
                operation.name(),
                started_at,
                completed_at,
                duration,
                error,
            ),
        }
    }
}

impl Default for ExecutionEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Creates an uncancelled [`CancellationSource`] for ad-hoc execution.
#[must_use]
pub fn cancellation_source() -> CancellationSource {
    CancellationSource::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::operation::{OperationCapabilities, OperationContext};

    struct OkOp;

    impl Operation for OkOp {
        type Input = ();
        type Options = ();
        type Output = u32;

        fn name(&self) -> &'static str {
            "test.ok"
        }

        fn capabilities(&self) -> OperationCapabilities {
            OperationCapabilities::sequential_lightweight()
        }

        fn execute<C: OperationContext>(
            &self,
            _ctx: &C,
            _input: (),
            _options: (),
        ) -> Result<u32, EngineError> {
            Ok(7)
        }
    }

    #[test]
    fn inline_scheduler_selects_inline_strategy() {
        let scheduler = InlineScheduler;
        assert_eq!(
            scheduler.strategy_for(&OperationCapabilities::parallel_friendly()),
            ExecutionStrategy::Inline
        );
    }

    #[test]
    fn engine_captures_timing_automatically() {
        let engine = ExecutionEngine::new();
        let result = engine.execute(&OkOp, (), ());
        assert!(result.is_success());
        assert!(result.completed_at() >= result.started_at());
        assert_eq!(result.into_outcome().expect("ok"), 7);
    }
}
