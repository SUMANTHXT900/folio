//! `pdf.inspect` through the Lesson 0 execution engine.
//!
//! Follows the standard operation-test pattern (Arrange → execute through
//! the real engine → assert outcome → assert lifecycle), using the shared
//! helpers in [`folio_engine::testing::pdf`] and the deterministic
//! fixtures in `common`. The real-world `test pdfs/` corpus is never
//! touched here.

#[path = "common/mod.rs"]
mod common;

use folio_engine::core::error::ErrorCode;
use folio_engine::core::result::CompletionStatus;
use folio_engine::execution::cancellation::CancellationSource;
use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::inspect::{
    InspectInput, InspectLevel, InspectOperation, InspectOptions, PdfInspection,
};
use folio_engine::testing::pdf::{
    assert_lifecycle_complete, assert_progress_completed, benchmark_operation, expect_error,
    expect_success, malformed_inputs, run_operation, test_engine, BenchmarkCase,
};

#[test]
fn basic_inspect_is_lightweight() {
    // Arrange: known two-page fixture with title metadata.
    let (engine, progress) = test_engine();
    let input = InspectInput::from_bytes(common::multi_page_pdf()).expect("input builds");

    // Execute through the real engine.
    let result = engine.execute(&InspectOperation, input, InspectOptions::basic());

    // Assert outcome, then lifecycle.
    assert!(result.is_success());
    assert_eq!(result.status(), CompletionStatus::Completed);
    assert_eq!(result.operation(), "pdf.inspect");
    let out = expect_success(result.clone());
    assert_eq!(out.page_count, 2);
    assert_eq!(out.pdf_version, "1.7");
    assert!(!out.encrypted);
    assert_eq!(out.metadata.title.as_deref(), Some("Integration"));
    // Basic mode produces no page-detail records.
    assert!(out.pages.is_none());

    assert_lifecycle_complete(&result);
    assert_progress_completed(&progress, &result);
}

#[test]
fn detailed_inspect_reports_exact_mixed_values() {
    let out: PdfInspection = expect_success(run_operation(
        &InspectOperation,
        InspectInput::from_bytes(common::mixed_pages_pdf()).expect("input builds"),
        InspectOptions::detailed(),
    ));

    assert_eq!(out.page_count, 3);
    assert_eq!(out.metadata.title.as_deref(), Some("Mixed Pages"));
    assert_eq!(
        out.metadata.author.as_deref(),
        Some("folio-engine fixtures")
    );
    let pages = out.pages.as_ref().expect("detailed mode has pages");
    assert_eq!(pages.len(), 3);
    for (index, page) in pages.iter().enumerate() {
        assert_eq!(page.page_number, index as u32 + 1);
    }
    assert!((pages[0].width_pt - 612.0).abs() < f64::EPSILON);
    assert!((pages[0].height_pt - 792.0).abs() < f64::EPSILON);
    assert_eq!(pages[0].rotation_deg, 0);
    assert!((pages[1].width_pt - 595.0).abs() < f64::EPSILON);
    assert!((pages[1].height_pt - 842.0).abs() < f64::EPSILON);
    assert_eq!(pages[1].rotation_deg, 90);
    assert!((pages[2].width_pt - 420.0).abs() < f64::EPSILON);
    assert!((pages[2].height_pt - 595.0).abs() < f64::EPSILON);
    assert_eq!(pages[2].rotation_deg, 270);
}

#[test]
fn default_options_are_basic() {
    assert_eq!(InspectOptions::default().level, InspectLevel::Basic);
}

#[test]
fn malformed_inputs_fail_cleanly_with_complete_lifecycle() {
    for (label, bytes) in malformed_inputs() {
        let result = run_operation(
            &InspectOperation,
            InspectInput::from_bytes(bytes).expect("input builds"),
            InspectOptions::basic(),
        );
        // The lifecycle still completes correctly on failure: terminal
        // status, ordered timestamps, operation attribution.
        assert_eq!(result.status(), CompletionStatus::Failed);
        assert_lifecycle_complete(&result);
        let err = expect_error(result, ErrorCode::InvalidDocument);
        assert_eq!(err.operation(), Some("pdf.inspect"), "case: {label}");
        assert!(err.job_id().is_some(), "case: {label}");
        assert!(err.details().is_some(), "case: {label}");
    }
}

#[test]
fn inspect_honours_cancellation() {
    let source = CancellationSource::new();
    source.cancel();

    let engine = ExecutionEngine::new();
    let input = InspectInput::from_bytes(common::multi_page_pdf()).expect("input builds");
    let result = engine.execute_with_cancellation(
        &InspectOperation,
        input,
        InspectOptions::default(),
        source.token(),
    );

    assert_eq!(result.status(), CompletionStatus::Cancelled);
    let err = expect_error(result, ErrorCode::Cancelled);
    assert_eq!(err.operation(), Some("pdf.inspect"));
}

#[test]
fn benchmark_helper_measures_fixture_twice() {
    // Smoke test for the benchmark infrastructure itself: fixture-based,
    // fast, and independent of the external corpus.
    let engine = ExecutionEngine::new();
    let bytes = common::single_page_pdf();
    let report = benchmark_operation(
        &engine,
        &InspectOperation,
        BenchmarkCase {
            input_label: "single-page-fixture".to_string(),
            file_bytes: bytes.len() as u64,
            make_input: Box::new(move || {
                InspectInput::from_bytes(bytes.clone()).expect("input builds")
            }),
            options: InspectOptions::basic(),
            repeats: 2,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.page_count),
    );

    assert_eq!(report.operation, "pdf.inspect");
    assert_eq!(report.repeats, 2);
    assert_eq!(report.failures, 0);
    assert_eq!(report.measurements.len(), 2);
    assert!(report.measurements.iter().all(|m| m.success));
    assert!(report.measurements.iter().all(|m| m.page_count == Some(1)));
    assert!(report.min_ms <= report.mean_ms && report.mean_ms <= report.max_ms);
    assert!(report.min_ms <= report.median_ms && report.median_ms <= report.max_ms);
    assert!(!report.to_json().is_empty());
}
