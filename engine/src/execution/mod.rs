//! Execution layer: jobs, contexts, progress, cancellation, scheduling.
//!
//! Owns timing automatically so operations never manage timers themselves.

pub mod cancellation;
pub mod context;
pub mod job;
pub mod progress;
pub mod scheduler;

pub use cancellation::{CancellationSource, CancellationToken};
pub use context::ExecutionContext;
pub use job::{Job, JobId, JobState};
pub use progress::{ProgressEvent, ProgressSink, SubProgressMapper};
pub use scheduler::{ExecutionEngine, ExecutionStrategy, InlineScheduler, SchedulerPolicy};
