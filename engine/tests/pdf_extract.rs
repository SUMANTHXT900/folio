//! `pdf.extract_pages` through the Lesson 0 execution engine.
//!
//! Follows the standard operation-test pattern (Arrange → execute through
//! the real engine → assert outcome → assert lifecycle → validate the
//! produced PDF by re-parsing it). Fixtures come from `common`; the
//! real-world `test pdfs/` corpus is never touched here.

#[path = "common/mod.rs"]
mod common;

use folio_engine::core::error::ErrorCode;
use folio_engine::core::result::CompletionStatus;
use folio_engine::execution::cancellation::CancellationSource;
use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::loader::load_pdf;
use folio_engine::processing::pdf::core::PageNumber;
use folio_engine::processing::pdf::extract::{
    ExtractPagesInput, ExtractPagesOperation, ExtractPagesOptions,
};
use folio_engine::testing::pdf::{
    assert_lifecycle_complete, assert_progress_completed, benchmark_operation, expect_error,
    expect_success, malformed_inputs, run_operation, test_engine, BenchmarkCase,
};

fn input(bytes: Vec<u8>) -> ExtractPagesInput {
    ExtractPagesInput::from_bytes(bytes).expect("input builds")
}

/// Extracts through the engine and returns the serialized output bytes.
fn extract_bytes(bytes: Vec<u8>, pages: &[PageNumber]) -> Vec<u8> {
    let mut output = expect_success(run_operation(
        &ExtractPagesOperation,
        input(bytes),
        ExtractPagesOptions::new(pages.to_vec()),
    ))
    .document;
    output.save_to_bytes().expect("output serializes")
}

/// Extracts through the engine and returns the re-parsed output document,
/// proving the result is a valid, self-contained PDF.
fn extract_output(
    bytes: Vec<u8>,
    pages: &[PageNumber],
) -> folio_engine::processing::pdf::core::PdfDocument {
    let serialized = extract_bytes(bytes, pages);
    load_pdf(&serialized).expect("output re-parses")
}

#[test]
fn extracts_single_page() {
    let reparsed = extract_output(common::single_page_pdf(), &[1]);
    assert_eq!(reparsed.page_count(), 1);
    let geometry = reparsed.page_geometry(1).expect("page readable");
    assert!((geometry.width_pt - 612.0).abs() < f64::EPSILON);
    assert!((geometry.height_pt - 792.0).abs() < f64::EPSILON);
    assert_eq!(geometry.rotation_deg, 0);
}

#[test]
fn extracts_subset_in_requested_order() {
    // Input: Letter / A4-rot90 / 420x595-rot270. Select [3, 1].
    let reparsed = extract_output(common::mixed_pages_pdf(), &[3, 1]);
    assert_eq!(reparsed.page_count(), 2);
    let first = reparsed.page_geometry(1).expect("page 1");
    assert!((first.width_pt - 420.0).abs() < f64::EPSILON);
    assert!((first.height_pt - 595.0).abs() < f64::EPSILON);
    assert_eq!(first.rotation_deg, 270);
    let second = reparsed.page_geometry(2).expect("page 2");
    assert!((second.width_pt - 612.0).abs() < f64::EPSILON);
    assert!((second.height_pt - 792.0).abs() < f64::EPSILON);
    assert_eq!(second.rotation_deg, 0);
}

#[test]
fn duplicates_produce_independent_pages() {
    let reparsed = extract_output(common::mixed_pages_pdf(), &[2, 2, 1]);
    assert_eq!(reparsed.page_count(), 3);
    assert_eq!(reparsed.page_geometry(1).expect("p1").rotation_deg, 90);
    assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 90);
    assert_eq!(reparsed.page_geometry(3).expect("p3").rotation_deg, 0);
}

#[test]
fn preserves_metadata() {
    let reparsed = extract_output(common::mixed_pages_pdf(), &[2]);
    assert_eq!(reparsed.pdf_version(), "1.7");
    let meta = reparsed.metadata();
    assert_eq!(meta.title.as_deref(), Some("Mixed Pages"));
    assert_eq!(meta.author.as_deref(), Some("folio-engine fixtures"));
}

#[test]
fn preserves_real_page_content() {
    // Validated independently with `lopdf` (dev-dependency): the engine's
    // raw accessor stays crate-internal, so external re-parsing doubles as
    // an independent correctness check.
    let serialized = extract_bytes(common::text_content_pdf(), &[2]);
    let raw = lopdf::Document::load_mem(&serialized).expect("output re-parses");
    assert_eq!(raw.get_pages().len(), 1);
    let page_id = raw.get_pages()[&1];
    let content = raw.get_page_content(page_id);
    let text = String::from_utf8_lossy(&content);
    assert!(text.contains("Beta page two"), "content survived: {text}");
    assert!(!text.contains("Alpha"), "unselected page leaked: {text}");
}

#[test]
fn empty_selection_fails_cleanly() {
    let result = run_operation(
        &ExtractPagesOperation,
        input(common::single_page_pdf()),
        ExtractPagesOptions::new(vec![]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    expect_error(result, ErrorCode::InvalidInput);
}

#[test]
fn out_of_range_selection_fails_before_output() {
    let result = run_operation(
        &ExtractPagesOperation,
        input(common::single_page_pdf()),
        ExtractPagesOptions::new(vec![1, 11]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::PageOutOfRange);
    assert!(err.message().contains("11"));
    assert_eq!(err.operation(), Some("pdf.extract_pages"));
    assert!(err.job_id().is_some());
}

#[test]
fn multiple_invalid_pages_fail_cleanly() {
    let result = run_operation(
        &ExtractPagesOperation,
        input(common::mixed_pages_pdf()),
        ExtractPagesOptions::new(vec![0, 99]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    let err = expect_error(result, ErrorCode::PageOutOfRange);
    assert!(err.details().is_some());
}

#[test]
fn malformed_inputs_fail_cleanly_with_complete_lifecycle() {
    for (label, bytes) in malformed_inputs() {
        let result = run_operation(
            &ExtractPagesOperation,
            input(bytes),
            ExtractPagesOptions::new(vec![1]),
        );
        assert_eq!(result.status(), CompletionStatus::Failed, "case: {label}");
        assert_lifecycle_complete(&result);
        let err = expect_error(result, ErrorCode::InvalidDocument);
        assert_eq!(err.operation(), Some("pdf.extract_pages"), "case: {label}");
    }
}

#[test]
fn extract_reports_progress_to_completion() {
    let (engine, progress) = test_engine();
    let result = engine.execute(
        &ExtractPagesOperation,
        input(common::mixed_pages_pdf()),
        ExtractPagesOptions::new(vec![3, 1, 2]),
    );
    assert!(result.is_success());
    assert_lifecycle_complete(&result);
    assert_progress_completed(&progress, &result);
}

#[test]
fn extract_honours_cancellation() {
    let source = CancellationSource::new();
    source.cancel();

    let engine = ExecutionEngine::new();
    let result = engine.execute_with_cancellation(
        &ExtractPagesOperation,
        input(common::mixed_pages_pdf()),
        ExtractPagesOptions::new(vec![1, 2, 3]),
        source.token(),
    );

    assert_eq!(result.status(), CompletionStatus::Cancelled);
    let err = expect_error(result, ErrorCode::Cancelled);
    assert_eq!(err.operation(), Some("pdf.extract_pages"));
}

#[test]
fn benchmark_helper_measures_extraction() {
    let engine = ExecutionEngine::new();
    let bytes = common::mixed_pages_pdf();
    let report = benchmark_operation(
        &engine,
        &ExtractPagesOperation,
        BenchmarkCase {
            input_label: "mixed-pages-fixture".to_string(),
            file_bytes: bytes.len() as u64,
            make_input: Box::new(move || {
                ExtractPagesInput::from_bytes(bytes.clone()).expect("input builds")
            }),
            options: ExtractPagesOptions::new(vec![3, 1]),
            repeats: 2,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.document.page_count()),
    );

    assert_eq!(report.operation, "pdf.extract_pages");
    assert_eq!(report.repeats, 2);
    assert_eq!(report.failures, 0);
    assert!(report.measurements.iter().all(|m| m.success));
    assert!(report.measurements.iter().all(|m| m.page_count == Some(2)));
    assert!(!report.to_json().is_empty());
}
