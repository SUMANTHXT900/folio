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

/// Minimum pages between source-side progress reports when the integer
/// percentage has not advanced. Mirrors the glue sink rule
/// (`should_forward_progress` in `wasm/src/lib.rs`: phase-first, Δ≥1 pp,
/// always 100%) at the emission site, so thousand-page loops emit tens of
/// events instead of thousands. The wire shape is unchanged — only
/// redundant in-between events are skipped. Terminal 100% events bypass
/// the throttle: callers emit their `finalizing` report directly.
pub const PROGRESS_REPORT_EVERY_N_PAGES: u64 = 64;

/// Source-side progress throttle for per-page operation loops.
///
/// Pass-through quota: the first observation always reports; afterwards an
/// observation reports when the integer percentage advanced (any change is
/// ≥ 1 pp) or when [`PROGRESS_REPORT_EVERY_N_PAGES`] pages elapsed since
/// the last report (liveness heartbeat for giant documents where one point
/// spans many pages). Cancellation stays per-page at the call site — only
/// `report_progress` calls are gated, never `check_cancellation`.
#[derive(Debug, Default)]
pub struct ProgressThrottle {
    last_completed: Option<u64>,
    last_page: u64,
}

impl ProgressThrottle {
    /// Creates a throttle that reports its first observation.
    #[must_use]
    pub fn new() -> Self {
        Self {
            last_completed: None,
            last_page: 0,
        }
    }

    /// Returns `true` when this observation should be emitted via
    /// `report_progress`. Updates the cursor on `true` only, so a dropped
    /// event never moves the baseline (identical to the sink rule).
    pub fn should_report(&mut self, completed: u64, pages_done: u64) -> bool {
        let report = match self.last_completed {
            None => true,
            Some(last) => {
                completed != last
                    || pages_done.saturating_sub(self.last_page) >= PROGRESS_REPORT_EVERY_N_PAGES
            }
        };
        if report {
            self.last_completed = Some(completed);
            self.last_page = pages_done;
        }
        report
    }
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

    #[test]
    fn throttle_reports_first_observation() {
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.should_report(10, 1));
    }

    #[test]
    fn throttle_suppresses_repeated_percentage() {
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.should_report(10, 1));
        // Same integer percentage, few pages later: redundant, drop it.
        assert!(!throttle.should_report(10, 2));
        assert!(!throttle.should_report(10, 3));
    }

    #[test]
    fn throttle_reports_any_percentage_advance() {
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.should_report(10, 1));
        assert!(!throttle.should_report(10, 2));
        // Any integer change is >= 1 pp: forward, like the sink rule.
        assert!(throttle.should_report(11, 3));
        assert!(!throttle.should_report(11, 4));
    }

    #[test]
    fn throttle_heartbeats_every_n_pages_without_advance() {
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.should_report(50, 1));
        let quiet = PROGRESS_REPORT_EVERY_N_PAGES - 1;
        assert!(!throttle.should_report(50, quiet));
        assert!(throttle.should_report(50, PROGRESS_REPORT_EVERY_N_PAGES + 1));
    }

    #[test]
    fn throttle_never_moves_baseline_on_dropped_events() {
        // A dropped event must not shift the heartbeat window: pages are
        // counted from the last *reported* page, mirroring the sink cursor.
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.should_report(50, 100));
        assert!(!throttle.should_report(50, 101));
        assert!(throttle.should_report(50, 100 + PROGRESS_REPORT_EVERY_N_PAGES));
    }
}
