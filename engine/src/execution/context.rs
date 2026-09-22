//! Per-execution context handed to operations.
//!
//! Implements [`OperationContext`](crate::core::operation::OperationContext)
//! so operations report progress and observe cancellation without knowing
//! about engines, schedulers, or sinks.

use std::sync::Arc;

use crate::core::error::EngineError;
use crate::core::operation::OperationContext;
use crate::execution::cancellation::CancellationToken;
use crate::execution::job::JobId;
use crate::execution::progress::{ProgressEvent, ProgressSink};

/// Runtime state for one operation execution.
pub struct ExecutionContext {
    job_id: JobId,
    operation_name: String,
    progress: Arc<dyn ProgressSink>,
    cancellation: CancellationToken,
}

impl ExecutionContext {
    /// Creates a context for the given job.
    pub fn new(
        job_id: JobId,
        operation_name: impl Into<String>,
        progress: Arc<dyn ProgressSink>,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            job_id,
            operation_name: operation_name.into(),
            progress,
            cancellation,
        }
    }
}

impl OperationContext for ExecutionContext {
    fn job_id(&self) -> &JobId {
        &self.job_id
    }

    fn operation_name(&self) -> &str {
        &self.operation_name
    }

    fn report_progress(
        &self,
        phase: Option<&str>,
        completed: u64,
        total: u64,
        message: Option<&str>,
    ) {
        self.progress.emit(ProgressEvent::new(
            self.job_id.clone(),
            phase,
            completed,
            total,
            message,
        ));
    }

    fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    fn check_cancellation(&self) -> Result<(), EngineError> {
        self.cancellation.check(&self.job_id, &self.operation_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::progress::ProgressEvent;
    use std::sync::Mutex;

    struct VecSink {
        events: Mutex<Vec<ProgressEvent>>,
    }

    impl ProgressSink for VecSink {
        fn emit(&self, event: ProgressEvent) {
            self.events.lock().expect("test lock").push(event);
        }
    }

    #[test]
    fn context_reports_progress_with_job_id() {
        let sink = Arc::new(VecSink {
            events: Mutex::new(Vec::new()),
        });
        let job = JobId::new();
        let ctx = ExecutionContext::new(
            job.clone(),
            "test.op",
            sink.clone(),
            CancellationToken::new(),
        );
        ctx.report_progress(Some("processing"), 1, 4, Some("step one"));

        let events = sink.events.lock().expect("test lock");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].job_id(), &job);
        assert_eq!(events[0].phase(), Some("processing"));
        assert!(!ctx.is_cancelled());
    }
}
