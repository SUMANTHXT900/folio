//! `pdf.rotate` through the Lesson 0 execution engine.
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
use folio_engine::processing::pdf::rotate::{RotateInput, RotateOperation, RotateOptions};
use folio_engine::testing::pdf::{
    assert_lifecycle_complete, assert_progress_completed, benchmark_operation, expect_error,
    expect_success, malformed_inputs, run_operation, test_engine, BenchmarkCase,
};

fn input(bytes: Vec<u8>) -> RotateInput {
    RotateInput::from_bytes(bytes).expect("input builds")
}

/// Rotates through the engine and returns the re-parsed output document,
/// proving the result is a valid, self-contained PDF.
fn rotate_output(bytes: Vec<u8>, pages: &[PageNumber], angle: i32) -> PdfDocument {
    let mut out = expect_success(run_operation(
        &RotateOperation,
        input(bytes),
        RotateOptions::new(pages.to_vec(), angle),
    ))
    .document;
    let serialized = out.save_to_bytes().expect("output serializes");
    load_pdf(&serialized).expect("output re-parses")
}

fn rotations(doc: &PdfDocument, count: u32) -> Vec<i32> {
    (1..=count)
        .map(|n| doc.effective_rotation(n).expect("rotation readable"))
        .collect()
}

#[test]
fn rotates_selected_pages_relatively() {
    let reparsed = rotate_output(common::mixed_pages_pdf(), &[1, 2, 3], 90);
    assert_eq!(reparsed.page_count(), 3);
    // Source effective rotations [0, 90, 270] advance by 90.
    assert_eq!(rotations(&reparsed, 3), vec![90, 180, 0]);
}

#[test]
fn negative_rotation_wraps_on_real_path() {
    let reparsed = rotate_output(common::mixed_pages_pdf(), &[1, 3], -90);
    assert_eq!(rotations(&reparsed, 3), vec![270, 90, 180]);
}

#[test]
fn partial_selection_leaves_others_untouched() {
    let reparsed = rotate_output(common::five_page_pdf(), &[2, 4], 90);
    assert_eq!(reparsed.page_count(), 5);
    assert_eq!(rotations(&reparsed, 5), vec![0, 180, 270, 270, 0]);
    // Geometry is identical to the source for every page.
    let source = load_pdf(&common::five_page_pdf()).expect("source parses");
    for n in 1..=5 {
        let before = source.page_geometry(n).expect("source geometry");
        let after = reparsed.page_geometry(n).expect("output geometry");
        assert!((before.width_pt - after.width_pt).abs() < f64::EPSILON);
        assert!((before.height_pt - after.height_pt).abs() < f64::EPSILON);
    }
}

#[test]
fn inherited_rotation_resolves_and_materializes() {
    let reparsed = rotate_output(common::inherited_rotate_pdf(), &[2], 90);
    assert_eq!(rotations(&reparsed, 3), vec![90, 180, 90]);
}

#[test]
fn mixed_inherited_and_direct_rotation() {
    // Ancestor 90, page 2 direct 180 → nearest-wins effective [90, 180, 90].
    let reparsed = rotate_output(common::mixed_rotate_pdf(), &[1], 90);
    assert_eq!(rotations(&reparsed, 3), vec![180, 180, 90]);
    let reparsed = rotate_output(common::mixed_rotate_pdf(), &[3], 180);
    assert_eq!(rotations(&reparsed, 3), vec![90, 180, 270]);
}

#[test]
fn shared_ancestor_is_never_mutated() {
    let reparsed = rotate_output(common::inherited_rotate_pdf(), &[2], 90);
    assert_eq!(rotations(&reparsed, 3), vec![90, 180, 90]);
}

#[test]
fn source_document_is_untouched() {
    let bytes = common::mixed_pages_pdf();
    let before = bytes.clone();
    let out = expect_success(run_operation(
        &RotateOperation,
        input(bytes.clone()),
        RotateOptions::new(vec![2], 90),
    ));
    assert_eq!(bytes, before);
    assert_eq!(out.page_count, 3);
    let source = load_pdf(&bytes).expect("source re-parses");
    let source_rotations: Vec<i32> = (1..=3)
        .map(|n| source.effective_rotation(n).expect("readable"))
        .collect();
    assert_eq!(source_rotations, vec![0, 90, 270]);
}

#[test]
fn content_and_order_survive_rotation() {
    let texts = ["PAGE 1", "PAGE 2", "PAGE 3", "PAGE 4", "PAGE 5"];
    let mut out = expect_success(run_operation(
        &RotateOperation,
        input(common::text_pages_pdf(&texts)),
        RotateOptions::new(vec![2, 4], 90),
    ))
    .document;
    let serialized = out.save_to_bytes().expect("output serializes");
    let raw = lopdf::Document::load_mem(&serialized).expect("output re-parses");
    assert_eq!(raw.get_pages().len(), 5);
    // Same page count, same order, same text on every page.
    for (output_index, expected) in texts.iter().enumerate() {
        let page_number = (output_index + 1) as u32;
        let page_id = raw.get_pages()[&page_number];
        let content = raw.get_page_content(page_id);
        let text = String::from_utf8_lossy(&content);
        assert!(
            text.contains(expected),
            "output page {page_number} shows {expected}: {text}"
        );
    }
    let reparsed = load_pdf(&serialized).expect("re-parses");
    assert_eq!(rotations(&reparsed, 5), vec![0, 90, 0, 90, 0]);
}

#[test]
fn rejects_non_quarter_turn_angle() {
    let result = run_operation(
        &RotateOperation,
        input(common::single_page_pdf()),
        RotateOptions::new(vec![1], 45),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::InvalidInput);
    assert_eq!(err.operation(), Some("pdf.rotate"));
    assert!(err.message().contains("45"));
}

#[test]
fn rejects_duplicates_and_bad_pages() {
    let bad = [
        (vec![1, 1], ErrorCode::DuplicatePage),
        (vec![0], ErrorCode::PageOutOfRange),
        (vec![1, 2, 3, 99], ErrorCode::PageOutOfRange),
    ];
    for (pages, code) in bad {
        let result = run_operation(
            &RotateOperation,
            input(common::mixed_pages_pdf()),
            RotateOptions::new(pages, 90),
        );
        assert_eq!(result.status(), CompletionStatus::Failed);
        assert_lifecycle_complete(&result);
        expect_error(result, code);
    }
}

#[test]
fn empty_selection_and_zero_angle_are_noops() {
    for options in [
        RotateOptions::new(vec![], 90),
        RotateOptions::new(vec![1, 2, 3], 0),
    ] {
        let result = run_operation(&RotateOperation, input(common::mixed_pages_pdf()), options);
        assert!(result.is_success());
        assert_lifecycle_complete(&result);
    }
}

#[test]
fn malformed_inputs_fail_cleanly_with_complete_lifecycle() {
    for (label, bytes) in malformed_inputs() {
        let result = run_operation(
            &RotateOperation,
            input(bytes),
            RotateOptions::new(vec![1], 90),
        );
        assert_eq!(result.status(), CompletionStatus::Failed, "case: {label}");
        assert_lifecycle_complete(&result);
        let err = expect_error(result, ErrorCode::InvalidDocument);
        assert_eq!(err.operation(), Some("pdf.rotate"), "case: {label}");
    }
}

#[test]
fn locked_input_fails_like_siblings() {
    let result = run_operation(
        &RotateOperation,
        input(common::locked_pdf()),
        RotateOptions::new(vec![1], 90),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::UnsupportedFormat);
    assert_eq!(err.operation(), Some("pdf.rotate"));
}

#[test]
fn rotate_reports_progress_to_completion() {
    let (engine, progress) = test_engine();
    let result = engine.execute(
        &RotateOperation,
        input(common::five_page_pdf()),
        RotateOptions::new(vec![5, 2], -90),
    );
    assert!(result.is_success());
    assert_lifecycle_complete(&result);
    assert_progress_completed(&progress, &result);
}

#[test]
fn rotate_honours_cancellation() {
    let source = CancellationSource::new();
    source.cancel();

    let engine = ExecutionEngine::new();
    let result = engine.execute_with_cancellation(
        &RotateOperation,
        input(common::five_page_pdf()),
        RotateOptions::new(vec![1, 2, 3, 4, 5], 90),
        source.token(),
    );

    assert_eq!(result.status(), CompletionStatus::Cancelled);
    let err = expect_error(result, ErrorCode::Cancelled);
    assert_eq!(err.operation(), Some("pdf.rotate"));
}

#[test]
fn benchmark_helper_measures_rotate() {
    let engine = ExecutionEngine::new();
    let bytes = common::five_page_pdf();
    let report = benchmark_operation(
        &engine,
        &RotateOperation,
        BenchmarkCase {
            input_label: "five-page-fixture".to_string(),
            file_bytes: bytes.len() as u64,
            make_input: Box::new(move || {
                RotateInput::from_bytes(bytes.clone()).expect("input builds")
            }),
            options: RotateOptions::new(vec![1, 3, 5], 90),
            repeats: 2,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.page_count),
    );

    assert_eq!(report.operation, "pdf.rotate");
    assert_eq!(report.repeats, 2);
    assert_eq!(report.failures, 0);
    assert!(report.measurements.iter().all(|m| m.success));
    assert!(report.measurements.iter().all(|m| m.page_count == Some(5)));
    assert!(!report.to_json().is_empty());
}

#[test]
fn reorder_still_rejects_duplicates_as_before() {
    // Sibling semantics unchanged by this lesson: extract-style repeats
    // are fine elsewhere, reorder demands a permutation.
    let out = expect_success(run_operation(
        &ReorderOperation,
        ReorderInput::from_bytes(common::mixed_pages_pdf()).expect("input builds"),
        ReorderOptions::new(vec![3, 1, 2]),
    ));
    assert_eq!(out.page_count, 3);
}
