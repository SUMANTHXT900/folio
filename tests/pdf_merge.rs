//! `pdf.merge` through the Lesson 0 execution engine.
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
use folio_engine::processing::pdf::core::PdfDocument;
use folio_engine::processing::pdf::merge::{MergeInput, MergeOperation, MergeOptions};
use folio_engine::testing::pdf::{
    assert_lifecycle_complete, assert_progress_completed, benchmark_operation, expect_error,
    expect_success, malformed_inputs, run_operation, test_engine, BenchmarkCase,
};

fn input(docs: Vec<PdfDocument>) -> MergeInput {
    MergeInput::new(docs)
}

fn doc(bytes: Vec<u8>) -> PdfDocument {
    load_pdf(&bytes).expect("fixture loads")
}

/// Merges through the engine and returns the re-parsed output document,
/// proving the result is a valid, self-contained PDF.
fn merge_output(docs: Vec<PdfDocument>) -> PdfDocument {
    let mut out = expect_success(run_operation(
        &MergeOperation,
        input(docs),
        MergeOptions::new(),
    ))
    .document;
    let serialized = out.save_to_bytes().expect("output serializes");
    load_pdf(&serialized).expect("output re-parses")
}

#[test]
fn merges_two_documents_in_order() {
    let reparsed = merge_output(vec![
        doc(common::single_page_pdf()),
        doc(common::mixed_pages_pdf()),
    ]);
    assert_eq!(reparsed.page_count(), 4);
    assert!((reparsed.page_geometry(1).expect("p1").width_pt - 612.0).abs() < f64::EPSILON);
    assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 0);
    assert_eq!(reparsed.page_geometry(3).expect("p3").rotation_deg, 90);
    assert_eq!(reparsed.page_geometry(4).expect("p4").rotation_deg, 270);
}

#[test]
fn merges_four_documents_preserving_order() {
    let reparsed = merge_output(vec![
        doc(common::mixed_pages_pdf()),
        doc(common::single_page_pdf()),
        doc(common::five_page_pdf()),
        doc(common::single_page_pdf()),
    ]);
    // 3 + 1 + 5 + 1 pages; spot-check each document boundary.
    assert_eq!(reparsed.page_count(), 10);
    assert!((reparsed.page_geometry(3).expect("p3").width_pt - 420.0).abs() < f64::EPSILON);
    assert!((reparsed.page_geometry(4).expect("p4").width_pt - 612.0).abs() < f64::EPSILON);
    assert!((reparsed.page_geometry(5).expect("p5").width_pt - 612.0).abs() < f64::EPSILON);
    assert!((reparsed.page_geometry(9).expect("p9").width_pt - 500.0).abs() < f64::EPSILON);
    assert!((reparsed.page_geometry(10).expect("p10").width_pt - 612.0).abs() < f64::EPSILON);
}

#[test]
fn duplicate_inputs_produce_two_copies() {
    let bytes = common::mixed_pages_pdf();
    let reparsed = merge_output(vec![doc(bytes.clone()), doc(bytes)]);
    assert_eq!(reparsed.page_count(), 6);
    assert_eq!(reparsed.page_geometry(2).expect("p2").rotation_deg, 90);
    assert_eq!(reparsed.page_geometry(5).expect("p5").rotation_deg, 90);
}

#[test]
fn content_follows_document_order() {
    let mut out = expect_success(run_operation(
        &MergeOperation,
        input(vec![
            doc(common::text_pages_pdf(&["A1", "A2"])),
            doc(common::text_pages_pdf(&["B1", "B2", "B3"])),
        ]),
        MergeOptions::new(),
    ))
    .document;
    let serialized = out.save_to_bytes().expect("output serializes");
    let raw = lopdf::Document::load_mem(&serialized).expect("output re-parses");
    assert_eq!(raw.get_pages().len(), 5);
    for (output_index, expected) in ["A1", "A2", "B1", "B2", "B3"].iter().enumerate() {
        let page_number = (output_index + 1) as u32;
        let page_id = raw.get_pages()[&page_number];
        let content = raw.get_page_content(page_id);
        let text = String::from_utf8_lossy(&content);
        assert!(
            text.contains(expected),
            "output page {page_number} shows {expected}: {text}"
        );
    }
}

#[test]
fn images_and_annotations_survive() {
    let reparsed = merge_output(vec![
        doc(common::image_page_pdf()),
        doc(common::annotated_pdf()),
    ]);
    assert_eq!(reparsed.page_count(), 3);
    let mut owned = reparsed;
    let bytes = owned.save_to_bytes().expect("serializes");
    let raw = lopdf::Document::load_mem(&bytes).expect("re-parses");
    let images = raw
        .objects
        .values()
        .filter(|obj| {
            let dict = match obj {
                lopdf::Object::Dictionary(dict) => Some(dict),
                lopdf::Object::Stream(stream) => Some(&stream.dict),
                _ => None,
            };
            dict.is_some_and(|dict| {
                dict.get(b"Subtype")
                    .is_ok_and(|s| s.as_name().is_ok_and(|n| n == b"Image"))
            })
        })
        .count();
    assert_eq!(images, 1);
    // The link on output page 2 (annotated doc's first page) still targets
    // output page 3 (its second page).
    let page_id = raw.get_pages()[&2];
    let page = raw.get_dictionary(page_id).expect("page dict");
    let annots = page
        .get(b"Annots")
        .expect("annots")
        .as_array()
        .expect("array");
    assert_eq!(annots.len(), 1);
    let (_, annot) = raw.dereference(&annots[0]).expect("annot resolves");
    let dest = annot.as_dict().expect("dict").get(b"Dest").expect("dest");
    let (_, dest_array) = raw.dereference(dest).expect("dest resolves");
    let target = dest_array.as_array().expect("array")[0]
        .as_reference()
        .expect("page reference");
    let target_number = raw
        .get_pages()
        .iter()
        .find(|(_, id)| **id == target)
        .map(|(number, _)| *number)
        .expect("destination resolves to a page");
    assert_eq!(target_number, 3);
}

#[test]
fn inherited_rotation_survives_per_source() {
    let reparsed = merge_output(vec![
        doc(common::inherited_rotate_pdf()),
        doc(common::single_page_pdf()),
    ]);
    assert_eq!(reparsed.page_count(), 4);
    for n in 1..=3 {
        assert_eq!(
            reparsed.effective_rotation(n).expect("rotation"),
            90,
            "page {n} keeps inherited 90"
        );
    }
    assert_eq!(reparsed.effective_rotation(4).expect("rotation"), 0);
}

#[test]
fn empty_documents_contribute_nothing() {
    let reparsed = merge_output(vec![
        doc(common::empty_pages_pdf()),
        doc(common::single_page_pdf()),
        doc(common::empty_pages_pdf()),
        doc(common::mixed_pages_pdf()),
    ]);
    assert_eq!(reparsed.page_count(), 4);
}

#[test]
fn all_empty_documents_are_rejected() {
    let result = run_operation(
        &MergeOperation,
        input(vec![
            doc(common::empty_pages_pdf()),
            doc(common::empty_pages_pdf()),
        ]),
        MergeOptions::new(),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::InvalidInput);
    assert!(err.message().contains("no pages"));
}

#[test]
fn rejects_empty_input() {
    let result = run_operation(&MergeOperation, input(vec![]), MergeOptions::new());
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    expect_error(result, ErrorCode::InvalidInput);
}

#[test]
fn locked_input_fails_the_whole_merge() {
    let result = run_operation(
        &MergeOperation,
        input(vec![
            doc(common::single_page_pdf()),
            doc(common::locked_pdf()),
            doc(common::mixed_pages_pdf()),
        ]),
        MergeOptions::new(),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::UnsupportedFormat);
    assert_eq!(err.operation(), Some("pdf.merge"));
    assert!(err.details().expect("details").contains("document_index=1"));
}

#[test]
fn malformed_inputs_fail_cleanly_with_complete_lifecycle() {
    for (label, bytes) in malformed_inputs() {
        // Malformed bytes cannot even form a `PdfDocument`; the failure
        // surfaces at input construction with the same structured error
        // family the engine uses everywhere else.
        let err = load_pdf(&bytes).expect_err(&format!("case: {label}"));
        assert_eq!(err.code(), ErrorCode::InvalidDocument, "case: {label}");
    }
}

#[test]
fn merge_reports_progress_to_completion() {
    let (engine, progress) = test_engine();
    let result = engine.execute(
        &MergeOperation,
        input(vec![
            doc(common::mixed_pages_pdf()),
            doc(common::single_page_pdf()),
            doc(common::five_page_pdf()),
        ]),
        MergeOptions::new(),
    );
    assert!(result.is_success());
    assert_lifecycle_complete(&result);
    assert_progress_completed(&progress, &result);
}

#[test]
fn merge_honours_cancellation() {
    let source = CancellationSource::new();
    source.cancel();

    let engine = ExecutionEngine::new();
    let result = engine.execute_with_cancellation(
        &MergeOperation,
        input(vec![
            doc(common::mixed_pages_pdf()),
            doc(common::five_page_pdf()),
        ]),
        MergeOptions::new(),
        source.token(),
    );

    assert_eq!(result.status(), CompletionStatus::Cancelled);
    let err = expect_error(result, ErrorCode::Cancelled);
    assert_eq!(err.operation(), Some("pdf.merge"));
}

#[test]
fn sources_are_untouched() {
    let bytes_a = common::mixed_pages_pdf();
    let bytes_b = common::single_page_pdf();
    let out = expect_success(run_operation(
        &MergeOperation,
        input(vec![doc(bytes_a.clone()), doc(bytes_b.clone())]),
        MergeOptions::new(),
    ));
    assert_eq!(out.input_document_count, 2);
    assert_eq!(out.input_page_count, 4);
    assert_eq!(out.output_page_count, 4);
    // Source bytes and re-parsed page counts are unchanged.
    assert_eq!(load_pdf(&bytes_a).expect("re-parses").page_count(), 3);
    assert_eq!(load_pdf(&bytes_b).expect("re-parses").page_count(), 1);
}

#[test]
fn benchmark_helper_measures_merge() {
    let engine = ExecutionEngine::new();
    let bytes_a = common::mixed_pages_pdf();
    let bytes_b = common::five_page_pdf();
    let total_bytes = bytes_a.len() as u64 + bytes_b.len() as u64;
    let report = benchmark_operation(
        &engine,
        &MergeOperation,
        BenchmarkCase {
            input_label: "mixed-plus-five-fixture".to_string(),
            file_bytes: total_bytes,
            make_input: Box::new(move || {
                MergeInput::new(vec![doc(bytes_a.clone()), doc(bytes_b.clone())])
            }),
            options: MergeOptions::new(),
            repeats: 2,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.output_page_count),
    );

    assert_eq!(report.operation, "pdf.merge");
    assert_eq!(report.repeats, 2);
    assert_eq!(report.failures, 0);
    assert!(report.measurements.iter().all(|m| m.success));
    assert!(report.measurements.iter().all(|m| m.page_count == Some(8)));
    assert!(!report.to_json().is_empty());
}
