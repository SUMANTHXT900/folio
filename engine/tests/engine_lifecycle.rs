//! End-to-end lifecycle tests proving the Lesson 0 architecture.
//!
//! Uses only the dummy [`folio_engine::testing`] operations: no real PDF
//! logic, no storage, no browser APIs.

use std::sync::Arc;
use std::sync::Mutex;

use folio_engine::core::error::ErrorCode;
use folio_engine::core::result::CompletionStatus;
use folio_engine::execution::cancellation::CancellationSource;
use folio_engine::execution::progress::{ProgressEvent, ProgressSink};
use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::observability::logger::VecEventSink;
use folio_engine::testing::{EchoInput, EchoOperation, EchoOptions, FailingOperation};

#[derive(Debug, Default)]
struct CollectingSink {
    events: Mutex<Vec<ProgressEvent>>,
}

impl CollectingSink {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::new(Vec::new()),
        })
    }

    fn snapshot(&self) -> Vec<ProgressEvent> {
        self.events.lock().expect("test lock").clone()
    }
}

impl ProgressSink for CollectingSink {
    fn emit(&self, event: ProgressEvent) {
        self.events.lock().expect("test lock").push(event);
    }
}

#[test]
fn success_path_records_full_lifecycle() {
    let progress = CollectingSink::new();
    let events = Arc::new(VecEventSink::new());
    let engine = ExecutionEngine::new()
        .with_progress(progress.clone())
        .with_events(events.clone());

    let result = engine.execute(
        &EchoOperation,
        EchoInput {
            payload: "hello".to_string(),
        },
        EchoOptions { steps: 4 },
    );

    assert!(result.is_success());
    assert_eq!(result.status(), CompletionStatus::Completed);
    assert!(result.completed_at() >= result.started_at());
    assert_eq!(
        result.clone().into_outcome().expect("success outcome"),
        "hello".to_string()
    );

    // Progress: one event per step, same job, ordered, percentages grow.
    let progress_events = progress.snapshot();
    assert_eq!(progress_events.len(), 4);
    let mut last_pct = 0.0;
    for event in &progress_events {
        assert_eq!(event.job_id(), result.job_id());
        let pct = event.percentage().expect("determinate progress");
        assert!(pct >= last_pct);
        last_pct = pct;
    }
    assert_eq!(last_pct, 100.0);

    // Structured events: start + finish were recorded for this job.
    let logged = events.snapshot();
    assert!(logged.len() >= 2);
    assert!(logged.iter().all(|e| e.job_id() == Some(result.job_id())));
}

#[test]
fn failure_path_returns_structured_error_with_timing() {
    let engine = ExecutionEngine::new();
    let result = engine.execute(&FailingOperation, (), ());

    assert!(!result.is_success());
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert!(result.completed_at() >= result.started_at());

    let err = result.into_outcome().expect_err("must be an error");
    assert_eq!(err.code(), ErrorCode::ProcessingFailed);
    assert_eq!(err.operation(), Some("test.failing"));
    assert!(err.job_id().is_some());
}

#[test]
fn every_execution_receives_a_unique_job_id() {
    let engine = ExecutionEngine::new();
    let first = engine.execute(
        &EchoOperation,
        EchoInput {
            payload: "a".to_string(),
        },
        EchoOptions::default(),
    );
    let second = engine.execute(
        &EchoOperation,
        EchoInput {
            payload: "b".to_string(),
        },
        EchoOptions::default(),
    );
    assert_ne!(first.job_id(), second.job_id());
}

#[test]
fn cancellation_produces_cancelled_result() {
    let source = CancellationSource::new();
    source.cancel();

    let engine = ExecutionEngine::new();
    let result = engine.execute_with_cancellation(
        &EchoOperation,
        EchoInput {
            payload: "x".to_string(),
        },
        EchoOptions::default(),
        source.token(),
    );

    assert_eq!(result.status(), CompletionStatus::Cancelled);
    let err = result.into_outcome().expect_err("cancelled is an error");
    assert_eq!(err.code(), ErrorCode::Cancelled);
}
