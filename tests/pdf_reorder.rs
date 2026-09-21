//! `pdf.reorder` through the Lesson 0 execution engine.
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
use folio_engine::processing::pdf::core::{PageNumber, PdfDocument};
use folio_engine::processing::pdf::reorder::{ReorderInput, ReorderOperation, ReorderOptions};
use folio_engine::testing::pdf::{
    assert_lifecycle_complete, assert_progress_completed, benchmark_operation, expect_error,
    expect_success, malformed_inputs, run_operation, test_engine, BenchmarkCase,
};

fn input(bytes: Vec<u8>) -> ReorderInput {
    ReorderInput::from_bytes(bytes).expect("input builds")
}

/// Reorders through the engine and returns the re-parsed output document,
/// proving the result is a valid, self-contained PDF.
fn reorder_output(bytes: Vec<u8>, order: &[PageNumber]) -> PdfDocument {
    let mut out = expect_success(run_operation(
        &ReorderOperation,
        input(bytes),
        ReorderOptions::new(order.to_vec()),
    ))
    .document;
    let serialized = out.save_to_bytes().expect("output serializes");
    load_pdf(&serialized).expect("output re-parses")
}

#[test]
fn reorders_five_pages_arbitrarily() {
    let reparsed = reorder_output(common::five_page_pdf(), &[5, 2, 4, 1, 3]);
    assert_eq!(reparsed.page_count(), 5);
    // Source widths in requested order: 500, 595, 612, 612, 420.
    let widths: Vec<f64> = (1..=5)
        .map(|n| reparsed.page_geometry(n).expect("readable").width_pt)
        .collect();
    for (actual, expected) in widths.iter().zip([500.0, 595.0, 612.0, 612.0, 420.0]) {
        assert!((actual - expected).abs() < f64::EPSILON);
    }
    assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 90);
    assert_eq!(reparsed.page_geometry(3).expect("p3").rotation_deg, 180);
    assert_eq!(reparsed.page_geometry(5).expect("p5").rotation_deg, 270);
}

#[test]
fn identity_order_preserves_everything() {
    let reparsed = reorder_output(common::mixed_pages_pdf(), &[1, 2, 3]);
    assert_eq!(reparsed.page_count(), 3);
    assert_eq!(reparsed.page_geometry(1).expect("p1").rotation_deg, 0);
    assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 90);
    assert_eq!(reparsed.page_geometry(3).expect("p3").rotation_deg, 270);
    assert_eq!(reparsed.pdf_version(), "1.7");
    assert_eq!(reparsed.metadata().title.as_deref(), Some("Mixed Pages"));
}

#[test]
fn content_follows_reordered_pages() {
    // Five text pages reordered [5, 2, 4, 1, 3]; verify every output page
    // shows exactly its source page's text, via independent `lopdf` parsing.
    let texts = ["PAGE 1", "PAGE 2", "PAGE 3", "PAGE 4", "PAGE 5"];
    let mut out = expect_success(run_operation(
        &ReorderOperation,
        input(common::text_pages_pdf(&texts)),
        ReorderOptions::new(vec![5, 2, 4, 1, 3]),
    ))
    .document;
    let serialized = out.save_to_bytes().expect("output serializes");
    let raw = lopdf::Document::load_mem(&serialized).expect("output re-parses");
    assert_eq!(raw.get_pages().len(), 5);
    for (output_index, expected) in ["PAGE 5", "PAGE 2", "PAGE 4", "PAGE 1", "PAGE 3"]
        .iter()
        .enumerate()
    {
        let page_number = (output_index + 1) as u32;
        let page_id = raw.get_pages()[&page_number];
        let content = raw.get_page_content(page_id);
        let text = String::from_utf8_lossy(&content);
        assert!(
            text.contains(expected),
            "output page {page_number} shows {expected}: {text}"
        );
        for other in texts {
            if other != *expected {
                assert!(
                    !text.contains(other),
                    "output page {page_number} leaked {other}: {text}"
                );
            }
        }
    }
}

#[test]
fn rejects_short_and_long_orders() {
    for order in [vec![1, 2, 3, 4], vec![1, 2, 3, 4, 5, 5]] {
        let result = run_operation(
            &ReorderOperation,
            input(common::five_page_pdf()),
            ReorderOptions::new(order),
        );
        assert_eq!(result.status(), CompletionStatus::Failed);
        assert_lifecycle_complete(&result);
        expect_error(result, ErrorCode::InvalidInput);
    }
}

#[test]
fn rejects_duplicates_and_reports_positions() {
    let result = run_operation(
        &ReorderOperation,
        input(common::five_page_pdf()),
        ReorderOptions::new(vec![1, 2, 2, 4, 5]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::DuplicatePage);
    assert_eq!(err.operation(), Some("pdf.reorder"));
    assert!(err.job_id().is_some());
    let details = err.details().expect("structured details");
    assert!(details.contains("page=2"));
    assert!(details.contains("first_position=2"));
    assert!(details.contains("duplicate_position=3"));
}

#[test]
fn rejects_zero_and_out_of_range() {
    for order in [vec![0, 2, 3, 4, 5], vec![1, 2, 3, 4, 999]] {
        let result = run_operation(
            &ReorderOperation,
            input(common::five_page_pdf()),
            ReorderOptions::new(order),
        );
        assert_eq!(result.status(), CompletionStatus::Failed);
        expect_error(result, ErrorCode::PageOutOfRange);
    }
}

#[test]
fn rejects_empty_order() {
    let result = run_operation(
        &ReorderOperation,
        input(common::single_page_pdf()),
        ReorderOptions::new(vec![]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    expect_error(result, ErrorCode::InvalidInput);
}

#[test]
fn malformed_inputs_fail_cleanly_with_complete_lifecycle() {
    for (label, bytes) in malformed_inputs() {
        let result = run_operation(
            &ReorderOperation,
            input(bytes),
            ReorderOptions::new(vec![1]),
        );
        assert_eq!(result.status(), CompletionStatus::Failed, "case: {label}");
        assert_lifecycle_complete(&result);
        let err = expect_error(result, ErrorCode::InvalidDocument);
        assert_eq!(err.operation(), Some("pdf.reorder"), "case: {label}");
    }
}

#[test]
fn locked_input_fails_like_extract() {
    let result = run_operation(
        &ReorderOperation,
        input(common::locked_pdf()),
        ReorderOptions::new(vec![1]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::UnsupportedFormat);
    assert_eq!(err.operation(), Some("pdf.reorder"));
}

#[test]
fn reorder_reports_progress_to_completion() {
    let (engine, progress) = test_engine();
    let result = engine.execute(
        &ReorderOperation,
        input(common::five_page_pdf()),
        ReorderOptions::new(vec![5, 4, 3, 2, 1]),
    );
    assert!(result.is_success());
    assert_lifecycle_complete(&result);
    assert_progress_completed(&progress, &result);
}

#[test]
fn reorder_honours_cancellation() {
    let source = CancellationSource::new();
    source.cancel();

    let engine = ExecutionEngine::new();
    let result = engine.execute_with_cancellation(
        &ReorderOperation,
        input(common::five_page_pdf()),
        ReorderOptions::new(vec![5, 4, 3, 2, 1]),
        source.token(),
    );

    assert_eq!(result.status(), CompletionStatus::Cancelled);
    let err = expect_error(result, ErrorCode::Cancelled);
    assert_eq!(err.operation(), Some("pdf.reorder"));
}

#[test]
fn benchmark_helper_measures_reorder() {
    let engine = ExecutionEngine::new();
    let bytes = common::five_page_pdf();
    let report = benchmark_operation(
        &engine,
        &ReorderOperation,
        BenchmarkCase {
            input_label: "five-page-fixture".to_string(),
            file_bytes: bytes.len() as u64,
            make_input: Box::new(move || {
                ReorderInput::from_bytes(bytes.clone()).expect("input builds")
            }),
            options: ReorderOptions::new(vec![5, 4, 3, 2, 1]),
            repeats: 2,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.page_count),
    );

    assert_eq!(report.operation, "pdf.reorder");
    assert_eq!(report.repeats, 2);
    assert_eq!(report.failures, 0);
    assert!(report.measurements.iter().all(|m| m.success));
    assert!(report.measurements.iter().all(|m| m.page_count == Some(5)));
    assert!(!report.to_json().is_empty());
}
