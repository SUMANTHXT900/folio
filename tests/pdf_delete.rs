//! `pdf.delete_pages` through the Lesson 0 execution engine.
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
use folio_engine::processing::pdf::delete::{
    DeletePagesInput, DeletePagesOperation, DeletePagesOptions,
};
use folio_engine::testing::pdf::{
    assert_lifecycle_complete, assert_progress_completed, benchmark_operation, expect_error,
    expect_success, malformed_inputs, run_operation, test_engine, BenchmarkCase,
};

fn input(bytes: Vec<u8>) -> DeletePagesInput {
    DeletePagesInput::from_bytes(bytes).expect("input builds")
}

/// Deletes through the engine and returns the re-parsed output document,
/// proving the result is a valid, self-contained PDF.
fn delete_output(bytes: Vec<u8>, pages: &[PageNumber]) -> PdfDocument {
    let mut out = expect_success(run_operation(
        &DeletePagesOperation,
        input(bytes),
        DeletePagesOptions::new(pages.to_vec()),
    ))
    .document;
    let serialized = out.save_to_bytes().expect("output serializes");
    load_pdf(&serialized).expect("output re-parses")
}

#[test]
fn deletes_single_and_multiple_pages() {
    let reparsed = delete_output(common::five_page_pdf(), &[2, 4]);
    assert_eq!(reparsed.page_count(), 3);
    // Survivors in source order: widths 612, 420, 500.
    let widths: Vec<f64> = (1..=3)
        .map(|n| reparsed.page_geometry(n).expect("readable").width_pt)
        .collect();
    for (actual, expected) in widths.iter().zip([612.0, 420.0, 500.0]) {
        assert!((actual - expected).abs() < f64::EPSILON);
    }
}

#[test]
fn deletes_first_and_last_pages() {
    let reparsed = delete_output(common::mixed_pages_pdf(), &[1, 3]);
    assert_eq!(reparsed.page_count(), 1);
    let geometry = reparsed.page_geometry(1).expect("readable");
    assert!((geometry.width_pt - 595.0).abs() < f64::EPSILON);
    assert_eq!(geometry.rotation_deg, 90);
}

#[test]
fn unsorted_deletion_preserves_source_order() {
    let reparsed = delete_output(common::five_page_pdf(), &[5, 2, 4]);
    assert_eq!(reparsed.page_count(), 2);
    assert_eq!(reparsed.page_geometry(1).expect("p1").rotation_deg, 0);
    assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 270);
}

#[test]
fn empty_deletion_copies_everything() {
    let out = expect_success(run_operation(
        &DeletePagesOperation,
        input(common::mixed_pages_pdf()),
        DeletePagesOptions::new(vec![]),
    ));
    assert_eq!(out.input_page_count, 3);
    assert_eq!(out.output_page_count, 3);
    assert_eq!(out.document.page_count(), 3);
}

#[test]
fn rejects_deleting_all_pages() {
    let result = run_operation(
        &DeletePagesOperation,
        input(common::mixed_pages_pdf()),
        DeletePagesOptions::new(vec![1, 2, 3]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::InvalidInput);
    assert!(err.message().contains("empty document"));
    let details = err.details().expect("structured details");
    assert!(details.contains("input_page_count=3"));
    assert!(details.contains("output_page_count=0"));
}

#[test]
fn rejects_duplicate_deletion() {
    let result = run_operation(
        &DeletePagesOperation,
        input(common::five_page_pdf()),
        DeletePagesOptions::new(vec![2, 2, 5]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::DuplicatePage);
    assert_eq!(err.operation(), Some("pdf.delete_pages"));
    assert!(err.job_id().is_some());
    let details = err.details().expect("structured details");
    assert!(details.contains("page=2"));
    assert!(details.contains("first_position=1"));
    assert!(details.contains("duplicate_position=2"));
}

#[test]
fn rejects_zero_and_out_of_range() {
    for pages in [vec![0], vec![2, 999]] {
        let result = run_operation(
            &DeletePagesOperation,
            input(common::five_page_pdf()),
            DeletePagesOptions::new(pages),
        );
        assert_eq!(result.status(), CompletionStatus::Failed);
        expect_error(result, ErrorCode::PageOutOfRange);
    }
}

#[test]
fn content_follows_surviving_pages() {
    let texts = ["PAGE 1", "PAGE 2", "PAGE 3", "PAGE 4", "PAGE 5"];
    let mut out = expect_success(run_operation(
        &DeletePagesOperation,
        input(common::text_pages_pdf(&texts)),
        DeletePagesOptions::new(vec![2, 4]),
    ))
    .document;
    let serialized = out.save_to_bytes().expect("output serializes");
    let raw = lopdf::Document::load_mem(&serialized).expect("output re-parses");
    assert_eq!(raw.get_pages().len(), 3);
    for (output_index, expected) in ["PAGE 1", "PAGE 3", "PAGE 5"].iter().enumerate() {
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
fn preserves_metadata() {
    let reparsed = delete_output(common::mixed_pages_pdf(), &[2]);
    assert_eq!(reparsed.pdf_version(), "1.7");
    assert_eq!(reparsed.metadata().title.as_deref(), Some("Mixed Pages"));
}

#[test]
fn source_document_is_untouched() {
    let bytes = common::mixed_pages_pdf();
    let before = bytes.clone();
    let out = expect_success(run_operation(
        &DeletePagesOperation,
        input(bytes.clone()),
        DeletePagesOptions::new(vec![2]),
    ));
    assert_eq!(bytes, before);
    assert_eq!(out.input_page_count, 3);
    assert_eq!(out.output_page_count, 2);
    // The source still loads with all pages intact.
    let source = load_pdf(&bytes).expect("source re-parses");
    assert_eq!(source.page_count(), 3);
}

#[test]
fn malformed_inputs_fail_cleanly_with_complete_lifecycle() {
    for (label, bytes) in malformed_inputs() {
        let result = run_operation(
            &DeletePagesOperation,
            input(bytes),
            DeletePagesOptions::new(vec![1]),
        );
        assert_eq!(result.status(), CompletionStatus::Failed, "case: {label}");
        assert_lifecycle_complete(&result);
        let err = expect_error(result, ErrorCode::InvalidDocument);
        assert_eq!(err.operation(), Some("pdf.delete_pages"), "case: {label}");
    }
}

#[test]
fn locked_input_fails_like_extract() {
    let result = run_operation(
        &DeletePagesOperation,
        input(common::locked_pdf()),
        DeletePagesOptions::new(vec![1]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::UnsupportedFormat);
    assert_eq!(err.operation(), Some("pdf.delete_pages"));
}

#[test]
fn delete_reports_progress_to_completion() {
    let (engine, progress) = test_engine();
    let result = engine.execute(
        &DeletePagesOperation,
        input(common::five_page_pdf()),
        DeletePagesOptions::new(vec![5, 2]),
    );
    assert!(result.is_success());
    assert_lifecycle_complete(&result);
    assert_progress_completed(&progress, &result);
}

#[test]
fn delete_honours_cancellation() {
    let source = CancellationSource::new();
    source.cancel();

    let engine = ExecutionEngine::new();
    let result = engine.execute_with_cancellation(
        &DeletePagesOperation,
        input(common::five_page_pdf()),
        DeletePagesOptions::new(vec![2, 4]),
        source.token(),
    );

    assert_eq!(result.status(), CompletionStatus::Cancelled);
    let err = expect_error(result, ErrorCode::Cancelled);
    assert_eq!(err.operation(), Some("pdf.delete_pages"));
}

#[test]
fn benchmark_helper_measures_delete() {
    let engine = ExecutionEngine::new();
    let bytes = common::five_page_pdf();
    let report = benchmark_operation(
        &engine,
        &DeletePagesOperation,
        BenchmarkCase {
            input_label: "five-page-fixture".to_string(),
            file_bytes: bytes.len() as u64,
            make_input: Box::new(move || {
                DeletePagesInput::from_bytes(bytes.clone()).expect("input builds")
            }),
            options: DeletePagesOptions::new(vec![2, 4]),
            repeats: 2,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.output_page_count),
    );

    assert_eq!(report.operation, "pdf.delete_pages");
    assert_eq!(report.repeats, 2);
    assert_eq!(report.failures, 0);
    assert!(report.measurements.iter().all(|m| m.success));
    assert!(report.measurements.iter().all(|m| m.page_count == Some(3)));
    assert!(!report.to_json().is_empty());
}
