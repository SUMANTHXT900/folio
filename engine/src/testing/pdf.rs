//! Reusable PDF test helpers.
//!
//! Small, engine-typed utilities shared by unit tests, integration tests,
//! and developer tools (examples, future CLI, future WASM harness):
//!
//! * run operations through the real [`ExecutionEngine`] (never bypass it
//!   except when a unit test targets an internal helper directly),
//! * assert success / expected errors / lifecycle completeness,
//! * collect progress for assertions,
//! * record benchmark measurements with engine-authoritative timing.
//!
//! These helpers only speak engine types (`Operation`, `OperationResult`,
//! `EngineError`, …) — they never touch `lopdf` or any operation's
//! internals, so every future operation can reuse them unchanged.

use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::Operation;
use crate::core::result::{CompletionStatus, OperationResult};
use crate::execution::progress::{ProgressEvent, ProgressSink};
use crate::execution::scheduler::ExecutionEngine;

// ---------------------------------------------------------------------------
// Engine-path execution
// ---------------------------------------------------------------------------

/// Progress collector usable as an engine sink in tests and tools.
#[derive(Debug, Default)]
pub struct CollectingSink {
    events: Mutex<Vec<ProgressEvent>>,
}

impl CollectingSink {
    /// Creates a shared collector.
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::new(Vec::new()),
        })
    }

    /// Returns a snapshot of the events collected so far.
    pub fn snapshot(&self) -> Vec<ProgressEvent> {
        self.events.lock().expect("progress lock").clone()
    }
}

impl ProgressSink for CollectingSink {
    fn emit(&self, event: ProgressEvent) {
        self.events.lock().expect("progress lock").push(event);
    }
}

/// Builds a default engine wired to a fresh [`CollectingSink`].
pub fn test_engine() -> (ExecutionEngine, Arc<CollectingSink>) {
    let sink = CollectingSink::new();
    let engine = ExecutionEngine::new().with_progress(sink.clone());
    (engine, sink)
}

/// Runs an operation through a default engine (the Arrange → Execute step
/// of the standard operation-test pattern).
pub fn run_operation<O>(op: &O, input: O::Input, options: O::Options) -> OperationResult<O::Output>
where
    O: Operation,
{
    ExecutionEngine::new().execute(op, input, options)
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/// Unwraps a successful outcome, panicking with the structured error otherwise.
#[track_caller]
pub fn expect_success<T: std::fmt::Debug>(result: OperationResult<T>) -> T {
    match result.into_outcome() {
        Ok(value) => value,
        Err(err) => panic!("expected success, got [{}] {}", err.code(), err.message(),),
    }
}

/// Expects a failed outcome with the given error code and returns the error.
#[track_caller]
pub fn expect_error<T: std::fmt::Debug>(
    result: OperationResult<T>,
    expected: ErrorCode,
) -> EngineError {
    assert!(
        !result.is_success(),
        "expected [{expected}] failure, got success"
    );
    let err = result
        .into_outcome()
        .expect_err("failure outcome holds an error");
    assert_eq!(
        err.code(),
        expected,
        "expected [{expected}], got [{}] {}",
        err.code(),
        err.message()
    );
    err
}

/// Asserts the execution lifecycle completed correctly: a terminal status,
/// ordered timestamps, and job/operation attribution.
#[track_caller]
pub fn assert_lifecycle_complete<T>(result: &OperationResult<T>) {
    // `CompletionStatus` only has terminal variants; matching exhaustively
    // documents that every status is an acceptable completed lifecycle.
    match result.status() {
        CompletionStatus::Completed | CompletionStatus::Failed | CompletionStatus::Cancelled => {}
    }
    assert!(
        result.completed_at() >= result.started_at(),
        "completion must not precede start"
    );
    assert!(
        !result.operation().is_empty(),
        "result must name its operation"
    );
}

/// Asserts collected progress reached 100% monotonically for this job.
#[track_caller]
pub fn assert_progress_completed<T>(sink: &CollectingSink, result: &OperationResult<T>) {
    let events = sink.snapshot();
    assert!(!events.is_empty(), "expected progress events");
    assert!(
        events.iter().all(|e| e.job_id() == result.job_id()),
        "all progress events must belong to this job"
    );
    assert!(
        events.windows(2).all(|pair| {
            pair[0].percentage().unwrap_or(0.0) <= pair[1].percentage().unwrap_or(0.0)
        }),
        "progress percentages must be non-decreasing"
    );
    let last = events.last().expect("progress events are non-empty");
    assert_eq!(last.percentage(), Some(100.0), "progress must reach 100%");
}

// ---------------------------------------------------------------------------
// Fixture inputs that need no corpus
// ---------------------------------------------------------------------------

/// Intentionally invalid inputs `(label, bytes)` for error-path tests.
/// No external corpus required.
pub fn malformed_inputs() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("plain text", b"definitely not a pdf".to_vec()),
        ("truncated header", b"%PDF-1.7 truncated".to_vec()),
        ("binary garbage", vec![0, 1, 2, 3, 255, 254]),
        ("empty object", b"%PDF-1.4\n%%EOF\n".to_vec()),
    ]
}

/// Returns a unique temporary output path for operations that produce
/// files (used by future operations such as extract/split; the caller —
/// never the engine — owns filesystem access).
pub fn temp_output_path(prefix: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "folio-engine-{prefix}-{}-{n}.pdf",
        std::process::id()
    ))
}

// ---------------------------------------------------------------------------
// Benchmark records (engine timing is authoritative)
// ---------------------------------------------------------------------------

/// Current wall-clock time as milliseconds since the Unix epoch.
fn unix_millis_now() -> u64 {
    crate::core::clock::wall_now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// Escapes a string for embedding in JSON output.
fn escape_json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// One benchmark measurement. `engine_duration_ms` comes from the
/// [`ExecutionEngine`]'s monotonic clock — never from harness stopwatches.
#[derive(Debug, Clone)]
pub struct BenchmarkMeasurement {
    /// Operation name, e.g. `"pdf.inspect"`.
    pub operation: String,
    /// Input identifier (file name or fixture label, never raw bytes).
    pub input_label: String,
    /// Input size in bytes when known.
    pub file_bytes: u64,
    /// Page count when the operation reported one.
    pub page_count: Option<u32>,
    /// Whether the run succeeded.
    pub success: bool,
    /// Authoritative engine duration in milliseconds.
    pub engine_duration_ms: f64,
    /// When the run finished (wall clock, ms since Unix epoch).
    pub timestamp_unix_ms: u64,
    /// Stable error code when the run failed.
    pub error_code: Option<String>,
    /// Human-readable error message when the run failed.
    pub error_message: Option<String>,
}

impl BenchmarkMeasurement {
    /// Serializes this measurement as a single JSON object.
    pub fn to_json(&self) -> String {
        let page_count = self
            .page_count
            .map_or("null".to_string(), |n| n.to_string());
        let error_code = self.error_code.as_deref().map_or("null".to_string(), |c| {
            format!("\"{}\"", escape_json_string(c))
        });
        let error_message = self
            .error_message
            .as_deref()
            .map_or("null".to_string(), |m| {
                format!("\"{}\"", escape_json_string(m))
            });
        format!(
            "{{\
             \"operation\":\"{}\",\
             \"input_label\":\"{}\",\
             \"file_bytes\":{},\
             \"page_count\":{},\
             \"success\":{},\
             \"engine_duration_ms\":{:.3},\
             \"timestamp_unix_ms\":{},\
             \"error_code\":{},\
             \"error_message\":{} \
             }}",
            escape_json_string(&self.operation),
            escape_json_string(&self.input_label),
            self.file_bytes,
            page_count,
            self.success,
            self.engine_duration_ms,
            self.timestamp_unix_ms,
            error_code,
            error_message,
        )
    }
}

/// Repeated runs of one benchmark case plus summary statistics over the
/// authoritative engine durations.
#[derive(Debug, Clone)]
pub struct BenchmarkReport {
    /// Operation name, e.g. `"pdf.inspect"`.
    pub operation: String,
    /// Input identifier shared by all repeats.
    pub input_label: String,
    /// Number of repeated runs performed.
    pub repeats: usize,
    /// One measurement per repeat, in run order.
    pub measurements: Vec<BenchmarkMeasurement>,
    /// Number of failed runs.
    pub failures: usize,
    /// Minimum engine duration in milliseconds.
    pub min_ms: f64,
    /// Maximum engine duration in milliseconds.
    pub max_ms: f64,
    /// Mean engine duration in milliseconds.
    pub mean_ms: f64,
    /// Median engine duration in milliseconds.
    pub median_ms: f64,
}

impl BenchmarkReport {
    /// Serializes the full report (measurements +summary) as JSON.
    pub fn to_json(&self) -> String {
        let measurements = self
            .measurements
            .iter()
            .map(BenchmarkMeasurement::to_json)
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\
             \"operation\":\"{}\",\
             \"input_label\":\"{}\",\
             \"repeats\":{},\
             \"failures\":{},\
             \"min_ms\":{:.3},\
             \"max_ms\":{:.3},\
             \"mean_ms\":{:.3},\
             \"median_ms\":{:.3},\
             \"measurements\":[{}] \
             }}",
            escape_json_string(&self.operation),
            escape_json_string(&self.input_label),
            self.repeats,
            self.failures,
            self.min_ms,
            self.max_ms,
            self.mean_ms,
            self.median_ms,
            measurements,
        )
    }
}

/// One benchmark case: how to build fresh inputs plus run configuration.
/// `page_count_of` stays a separate closure on [`benchmark_operation`]
/// because it depends on the operation's output type.
pub struct BenchmarkCase<Input, Options> {
    /// Input identifier (file name or fixture label, never raw bytes).
    pub input_label: String,
    /// Input size in bytes when known.
    pub file_bytes: u64,
    /// Produces a fresh input per repeat (inputs are owned per run).
    pub make_input: Box<dyn Fn() -> Input>,
    /// Operation options, cloned per repeat.
    pub options: Options,
    /// Number of repeated runs.
    pub repeats: usize,
}

/// Runs one benchmark case through the engine and collects structured
/// measurements. `page_count_of` extracts the page count from an outcome,
/// if the operation reports one.
pub fn benchmark_operation<O>(
    engine: &ExecutionEngine,
    op: &O,
    case: BenchmarkCase<O::Input, O::Options>,
    page_count_of: impl Fn(&Result<O::Output, EngineError>) -> Option<u32>,
) -> BenchmarkReport
where
    O: Operation,
    O::Options: Clone,
{
    let repeats = case.repeats.max(1);
    let mut measurements = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let result = engine.execute(op, (case.make_input)(), case.options.clone());
        measurements.push(measure_result(
            &result,
            &case.input_label,
            case.file_bytes,
            &page_count_of,
        ));
    }
    let operation = measurements
        .first()
        .map(|m| m.operation.clone())
        .unwrap_or_default();
    summarize_measurements(&operation, &case.input_label, measurements)
}

/// Builds a [`BenchmarkReport`] from already-collected measurements.
#[must_use]
pub fn summarize_measurements(
    operation: &str,
    input_label: &str,
    measurements: Vec<BenchmarkMeasurement>,
) -> BenchmarkReport {
    let repeats = measurements.len();
    let failures = measurements.iter().filter(|m| !m.success).count();
    let mut durations: Vec<f64> = measurements.iter().map(|m| m.engine_duration_ms).collect();
    durations.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let (min_ms, max_ms, mean_ms, median_ms) = if durations.is_empty() {
        (0.0, 0.0, 0.0, 0.0)
    } else {
        let min_ms = durations[0];
        let max_ms = durations[durations.len() - 1];
        let mean_ms = durations.iter().sum::<f64>() / durations.len() as f64;
        let mid = durations.len() / 2;
        let median_ms = if durations.len() % 2 == 1 {
            durations[mid]
        } else {
            (durations[mid - 1] + durations[mid]) / 2.0
        };
        (min_ms, max_ms, mean_ms, median_ms)
    };
    BenchmarkReport {
        operation: operation.to_string(),
        input_label: input_label.to_string(),
        repeats,
        measurements,
        failures,
        min_ms,
        max_ms,
        mean_ms,
        median_ms,
    }
}

/// Records a single [`BenchmarkMeasurement`] from an [`OperationResult`].
/// Timing is taken from the result's engine-measured duration.
pub fn measure_result<T>(
    result: &OperationResult<T>,
    input_label: &str,
    file_bytes: u64,
    page_count_of: impl FnOnce(&Result<T, EngineError>) -> Option<u32>,
) -> BenchmarkMeasurement {
    let (success, error_code, error_message) = match result.outcome() {
        Ok(_) => (true, None, None),
        Err(err) => (
            false,
            Some(err.code().code_str().to_string()),
            Some(err.message().to_string()),
        ),
    };
    BenchmarkMeasurement {
        operation: result.operation().to_string(),
        input_label: input_label.to_string(),
        file_bytes,
        page_count: page_count_of(result.outcome()),
        success,
        engine_duration_ms: result.duration().as_secs_f64() * 1000.0,
        timestamp_unix_ms: unix_millis_now(),
        error_code,
        error_message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_inputs_are_non_empty_and_varied() {
        let inputs = malformed_inputs();
        assert!(inputs.len() >= 3);
        for (_, bytes) in &inputs {
            assert!(!bytes.is_empty());
        }
    }

    #[test]
    fn temp_output_paths_are_unique() {
        assert_ne!(temp_output_path("x"), temp_output_path("x"));
    }

    #[test]
    fn measurement_json_round_trips_shape() {
        let m = BenchmarkMeasurement {
            operation: "pdf.inspect".to_string(),
            input_label: "a\"b\nc".to_string(),
            file_bytes: 12,
            page_count: Some(3),
            success: true,
            engine_duration_ms: 1.5,
            timestamp_unix_ms: 1_700_000_000_000,
            error_code: None,
            error_message: None,
        };
        let json = m.to_json();
        assert!(json.contains("\"operation\":\"pdf.inspect\""));
        assert!(json.contains("\\\""));
        assert!(json.contains("\\n"));
        assert!(json.contains("\"page_count\":3"));
    }

    #[test]
    fn summary_computes_basic_statistics() {
        let mk = |ms: f64| BenchmarkMeasurement {
            operation: "op".to_string(),
            input_label: "in".to_string(),
            file_bytes: 0,
            page_count: None,
            success: true,
            engine_duration_ms: ms,
            timestamp_unix_ms: 0,
            error_code: None,
            error_message: None,
        };
        let report = summarize_measurements("op", "in", vec![mk(1.0), mk(2.0), mk(3.0)]);
        assert_eq!(report.repeats, 3);
        assert_eq!(report.failures, 0);
        assert_eq!(report.min_ms, 1.0);
        assert_eq!(report.max_ms, 3.0);
        assert_eq!(report.mean_ms, 2.0);
        assert_eq!(report.median_ms, 2.0);
        assert!(report.to_json().contains("\"measurements\":["));
    }
}
