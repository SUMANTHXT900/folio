//! `pdf.split` through the Lesson 0 execution engine.
//!
//! Follows the standard operation-test pattern (Arrange → execute through
//! the real engine → assert outcome → assert lifecycle → validate every
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
use folio_engine::processing::pdf::split::{SplitInput, SplitOperation, SplitOptions, SplitPart};
use folio_engine::testing::pdf::{
    assert_lifecycle_complete, assert_progress_completed, benchmark_operation, expect_error,
    expect_success, malformed_inputs, run_operation, test_engine, BenchmarkCase,
};

fn input(bytes: Vec<u8>) -> SplitInput {
    SplitInput::from_bytes(bytes).expect("input builds")
}

fn plan(part_pages: &[&[PageNumber]]) -> SplitOptions {
    SplitOptions::new(
        part_pages
            .iter()
            .map(|pages| SplitPart::new(pages.to_vec()))
            .collect(),
    )
}

/// Splits through the engine and returns every re-parsed part, proving
/// each output is a valid, self-contained PDF.
fn split_output(bytes: Vec<u8>, part_pages: &[&[PageNumber]]) -> Vec<PdfDocument> {
    let out = expect_success(run_operation(
        &SplitOperation,
        input(bytes),
        plan(part_pages),
    ));
    assert_eq!(out.parts.len(), part_pages.len());
    out.parts
        .into_iter()
        .map(|mut part| {
            let serialized = part.document.save_to_bytes().expect("part serializes");
            load_pdf(&serialized).expect("part re-parses")
        })
        .collect()
}

#[test]
fn splits_into_two_parts() {
    let parts = split_output(common::mixed_pages_pdf(), &[&[1, 2], &[3]]);
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[0].page_count(), 2);
    assert_eq!(parts[1].page_count(), 1);
    assert_eq!(
        parts[1].page_geometry(1).expect("readable").rotation_deg,
        270
    );
}

#[test]
fn preserves_exact_order_without_sorting() {
    let parts = split_output(common::five_page_pdf(), &[&[4, 2, 1], &[5, 3]]);
    assert_eq!(parts.len(), 2);
    // Part 1: Letter-rot180, A4-rot90, Letter.
    assert_eq!(parts[0].page_geometry(1).expect("p1").rotation_deg, 180);
    assert_eq!(parts[0].page_geometry(2).expect("p2").rotation_deg, 90);
    assert!((parts[0].page_geometry(3).expect("p3").width_pt - 612.0).abs() < f64::EPSILON);
    // Part 2: 500-wide, then 420-wide.
    assert!((parts[1].page_geometry(1).expect("p1").width_pt - 500.0).abs() < f64::EPSILON);
    assert!((parts[1].page_geometry(2).expect("p2").width_pt - 420.0).abs() < f64::EPSILON);
}

#[test]
fn duplicates_and_overlap_across_parts() {
    let parts = split_output(common::five_page_pdf(), &[&[1, 2, 3], &[3, 4, 5], &[2, 2]]);
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0].page_count(), 3);
    assert_eq!(parts[1].page_count(), 3);
    assert_eq!(parts[2].page_count(), 2);
    // Source page 3 (420-wide, rot270) opens part 2 and sits mid part 1.
    assert!((parts[0].page_geometry(3).expect("p3").width_pt - 420.0).abs() < f64::EPSILON);
    assert!((parts[1].page_geometry(1).expect("p1").width_pt - 420.0).abs() < f64::EPSILON);
    assert_eq!(parts[1].page_geometry(1).expect("p1").rotation_deg, 270);
    assert_eq!(parts[2].page_geometry(1).expect("p1").rotation_deg, 90);
    assert_eq!(parts[2].page_geometry(2).expect("p2").rotation_deg, 90);
}

#[test]
fn carries_part_names_and_metadata() {
    let out = expect_success(run_operation(
        &SplitOperation,
        input(common::mixed_pages_pdf()),
        SplitOptions::new(vec![
            SplitPart::named(vec![1], "cover"),
            SplitPart::new(vec![2, 3]),
        ]),
    ));
    assert_eq!(out.parts.len(), 2);
    assert_eq!(out.input_page_count, 3);
    assert_eq!(out.parts[0].name.as_deref(), Some("cover"));
    assert_eq!(out.parts[1].name, None);
    // Metadata behavior matches extract: Info carried into every part.
    for part in &out.parts {
        assert_eq!(
            part.document.metadata().title.as_deref(),
            Some("Mixed Pages")
        );
    }
}

#[test]
fn content_follows_requested_order_across_parts() {
    // Text fixture: page 1 = Alpha, page 2 = Beta. Split [2] | [1] and
    // verify content per part with independent `lopdf` parsing.
    let out = expect_success(run_operation(
        &SplitOperation,
        input(common::text_content_pdf()),
        plan(&[&[2], &[1]]),
    ));
    assert_eq!(out.parts.len(), 2);
    let texts: Vec<String> = out
        .parts
        .into_iter()
        .map(|mut part| {
            let serialized = part.document.save_to_bytes().expect("serializes");
            let raw = lopdf::Document::load_mem(&serialized).expect("re-parses");
            assert_eq!(raw.get_pages().len(), 1);
            let page_id = raw.get_pages()[&1];
            String::from_utf8_lossy(&raw.get_page_content(page_id)).into_owned()
        })
        .collect();
    assert!(texts[0].contains("Beta page two"), "part 1: {}", texts[0]);
    assert!(!texts[0].contains("Alpha"), "part 1 leaked: {}", texts[0]);
    assert!(texts[1].contains("Alpha page one"), "part 2: {}", texts[1]);
    assert!(!texts[1].contains("Beta"), "part 2 leaked: {}", texts[1]);
}

#[test]
fn rejects_empty_plan() {
    let result = run_operation(&SplitOperation, input(common::single_page_pdf()), plan(&[]));
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    expect_error(result, ErrorCode::InvalidInput);
}

#[test]
fn rejects_empty_part() {
    let result = run_operation(
        &SplitOperation,
        input(common::mixed_pages_pdf()),
        plan(&[&[1, 2], &[]]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::InvalidInput);
    assert!(err.message().contains("part 2"));
}

#[test]
fn rejects_page_zero_with_location() {
    let result = run_operation(
        &SplitOperation,
        input(common::single_page_pdf()),
        plan(&[&[0, 1]]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    let err = expect_error(result, ErrorCode::PageOutOfRange);
    assert!(err.message().contains("part 1"));
    assert_eq!(err.operation(), Some("pdf.split"));
    assert!(err.job_id().is_some());
}

#[test]
fn rejects_out_of_range_page_with_location() {
    let result = run_operation(
        &SplitOperation,
        input(common::mixed_pages_pdf()),
        plan(&[&[1], &[2, 999_999]]),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::PageOutOfRange);
    assert!(err.message().contains("part 2"));
    assert!(err.message().contains("999999"));
    assert!(err.message().contains("3 pages"));
    let details = err.details().expect("structured details");
    assert!(details.contains("part=2"));
    assert!(details.contains("page=999999"));
    assert!(details.contains("page_count=3"));
}

#[test]
fn malformed_inputs_fail_cleanly_with_complete_lifecycle() {
    for (label, bytes) in malformed_inputs() {
        let result = run_operation(&SplitOperation, input(bytes), plan(&[&[1]]));
        assert_eq!(result.status(), CompletionStatus::Failed, "case: {label}");
        assert_lifecycle_complete(&result);
        let err = expect_error(result, ErrorCode::InvalidDocument);
        assert_eq!(err.operation(), Some("pdf.split"), "case: {label}");
    }
}

#[test]
fn locked_input_fails_like_extract() {
    let result = run_operation(&SplitOperation, input(common::locked_pdf()), plan(&[&[1]]));
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::UnsupportedFormat);
    assert_eq!(err.operation(), Some("pdf.split"));
}

#[test]
fn split_reports_progress_to_completion() {
    let (engine, progress) = test_engine();
    let result = engine.execute(
        &SplitOperation,
        input(common::five_page_pdf()),
        plan(&[&[5, 1], &[2, 3, 4]]),
    );
    assert!(result.is_success());
    assert_lifecycle_complete(&result);
    assert_progress_completed(&progress, &result);
}

#[test]
fn split_honours_cancellation() {
    let source = CancellationSource::new();
    source.cancel();

    let engine = ExecutionEngine::new();
    let result = engine.execute_with_cancellation(
        &SplitOperation,
        input(common::five_page_pdf()),
        plan(&[&[1, 2], &[3, 4, 5]]),
        source.token(),
    );

    assert_eq!(result.status(), CompletionStatus::Cancelled);
    let err = expect_error(result, ErrorCode::Cancelled);
    assert_eq!(err.operation(), Some("pdf.split"));
}

#[test]
fn benchmark_helper_measures_split() {
    let engine = ExecutionEngine::new();
    let bytes = common::five_page_pdf();
    let report = benchmark_operation(
        &engine,
        &SplitOperation,
        BenchmarkCase {
            input_label: "five-page-fixture".to_string(),
            file_bytes: bytes.len() as u64,
            make_input: Box::new(move || {
                SplitInput::from_bytes(bytes.clone()).expect("input builds")
            }),
            options: plan(&[&[1, 2], &[3, 4, 5]]),
            repeats: 2,
        },
        |outcome| {
            outcome.as_ref().ok().map(|out| {
                out.parts
                    .iter()
                    .map(|part| part.document.page_count())
                    .sum()
            })
        },
    );

    assert_eq!(report.operation, "pdf.split");
    assert_eq!(report.repeats, 2);
    assert_eq!(report.failures, 0);
    assert!(report.measurements.iter().all(|m| m.success));
    assert!(report.measurements.iter().all(|m| m.page_count == Some(5)));
    assert!(!report.to_json().is_empty());
}
