//! `pdf.read_metadata` + `pdf.set_metadata` through the Lesson 0
//! execution engine.
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
use folio_engine::processing::pdf::metadata::{
    DocumentMetadata, FieldPatch, MetadataPatch, PdfDate, ReadMetadataInput, ReadMetadataOperation,
    ReadMetadataOptions, SetMetadataInput, SetMetadataOperation, SetMetadataOptions,
};
use folio_engine::testing::pdf::{
    assert_lifecycle_complete, assert_progress_completed, benchmark_operation, expect_error,
    expect_success, malformed_inputs, run_operation, test_engine, BenchmarkCase,
};

fn read_input(bytes: Vec<u8>) -> ReadMetadataInput {
    ReadMetadataInput::from_bytes(bytes).expect("input builds")
}

fn write_input(bytes: Vec<u8>) -> SetMetadataInput {
    SetMetadataInput::from_bytes(bytes).expect("input builds")
}

/// Applies a patch through the engine and returns the re-parsed output
/// document, proving the result is a valid, self-contained PDF.
fn set_output(bytes: Vec<u8>, patch: MetadataPatch) -> PdfDocument {
    let mut out = expect_success(run_operation(
        &SetMetadataOperation,
        write_input(bytes),
        SetMetadataOptions::new(patch),
    ))
    .document;
    let serialized = out.save_to_bytes().expect("output serializes");
    load_pdf(&serialized).expect("output re-parses")
}

fn read_back(bytes: &[u8]) -> DocumentMetadata {
    expect_success(run_operation(
        &ReadMetadataOperation,
        read_input(bytes.to_vec()),
        ReadMetadataOptions::new(),
    ))
    .metadata
}

#[test]
fn reads_rich_metadata_through_the_engine() {
    let result = run_operation(
        &ReadMetadataOperation,
        read_input(common::metadata_rich_pdf()),
        ReadMetadataOptions::new(),
    );
    let out = expect_success(result);
    assert_eq!(out.page_count, 1);
    assert_eq!(out.metadata.title.as_deref(), Some("Rich Metadata"));
    assert_eq!(out.metadata.author.as_deref(), Some("Integration Author"));
    assert_eq!(out.metadata.keywords.as_deref(), Some("alpha, beta"));
    assert_eq!(out.metadata.creator.as_deref(), Some("Creator \u{e9}"));
    let created = out.metadata.creation_date.expect("typed creation date");
    assert_eq!((created.year, created.month, created.day), (2026, 1, 23));
    assert_eq!(created.tz_offset_minutes, 330);
    assert_eq!(
        out.metadata
            .modification_date
            .expect("typed mod date")
            .tz_offset_minutes,
        0
    );
}

#[test]
fn read_reports_lifecycle_and_progress() {
    let (engine, progress) = test_engine();
    let result = engine.execute(
        &ReadMetadataOperation,
        read_input(common::metadata_rich_pdf()),
        ReadMetadataOptions::new(),
    );
    assert_eq!(result.status(), CompletionStatus::Completed);
    assert_lifecycle_complete(&result);
    assert_progress_completed(&progress, &result);
}

#[test]
fn round_trip_read_patch_write_reopen_read() {
    // Mandatory round-trip: set, clear, and unchanged fields together.
    let patch = MetadataPatch {
        title: FieldPatch::Set("Round Trip".to_string()),
        author: FieldPatch::Clear,
        keywords: FieldPatch::Set("k".to_string()),
        creation_date: FieldPatch::Set(PdfDate::new(2025, 12, 31, 23, 59, 58, -300).expect("date")),
        ..MetadataPatch::default()
    };
    let out = expect_success(run_operation(
        &SetMetadataOperation,
        write_input(common::metadata_rich_pdf()),
        SetMetadataOptions::new(patch),
    ));
    assert_eq!(out.page_count, 1);
    let mut document = out.document;
    let bytes = document.save_to_bytes().expect("serializes");
    let meta = read_back(&bytes);
    assert_eq!(meta.title.as_deref(), Some("Round Trip"));
    assert_eq!(meta.author, None);
    assert_eq!(meta.keywords.as_deref(), Some("k"));
    // Untouched fields survive the rewrite.
    assert_eq!(meta.creator.as_deref(), Some("Creator \u{e9}"));
    let created = meta.creation_date.expect("new date survives");
    assert_eq!(
        (
            created.year,
            created.month,
            created.day,
            created.hour,
            created.minute
        ),
        (2025, 12, 31, 23, 59)
    );
    assert_eq!(created.tz_offset_minutes, -300);
    // Untouched date survives too.
    assert!(meta.modification_date.is_some());
}

#[test]
fn write_preserves_pages_geometry_rotation_and_version() {
    let source = load_pdf(&common::mixed_pages_pdf()).expect("source parses");
    let patch = MetadataPatch {
        title: FieldPatch::Set("T".to_string()),
        ..MetadataPatch::default()
    };
    let reparsed = set_output(common::mixed_pages_pdf(), patch);
    assert_eq!(reparsed.page_count(), source.page_count());
    assert_eq!(reparsed.pdf_version(), source.pdf_version());
    for n in 1..=source.page_count() {
        let before = source.page_geometry(n).expect("source geometry");
        let after = reparsed.page_geometry(n).expect("output geometry");
        assert!((before.width_pt - after.width_pt).abs() < f64::EPSILON);
        assert!((before.height_pt - after.height_pt).abs() < f64::EPSILON);
        assert_eq!(
            source.effective_rotation(n).expect("source rotation"),
            reparsed.effective_rotation(n).expect("output rotation")
        );
    }
}

#[test]
fn write_reports_lifecycle_and_progress() {
    let (engine, progress) = test_engine();
    let result = engine.execute(
        &SetMetadataOperation,
        write_input(common::single_page_pdf()),
        SetMetadataOptions::new(MetadataPatch {
            title: FieldPatch::Set("T".to_string()),
            ..MetadataPatch::default()
        }),
    );
    assert_eq!(result.status(), CompletionStatus::Completed);
    assert_lifecycle_complete(&result);
    assert_progress_completed(&progress, &result);
}

#[test]
fn rejects_empty_set_values_through_the_engine() {
    let result = run_operation(
        &SetMetadataOperation,
        write_input(common::single_page_pdf()),
        SetMetadataOptions::new(MetadataPatch {
            title: FieldPatch::Set(String::new()),
            ..MetadataPatch::default()
        }),
    );
    assert_eq!(result.status(), CompletionStatus::Failed);
    let err = expect_error(result, ErrorCode::InvalidInput);
    assert!(err.message().contains("title"));
}

#[test]
fn malformed_inputs_fail_cleanly_with_complete_lifecycle() {
    for (label, bytes) in malformed_inputs() {
        let read_result = run_operation(
            &ReadMetadataOperation,
            ReadMetadataInput::from_bytes(bytes.clone()).expect("input builds"),
            ReadMetadataOptions::new(),
        );
        assert_eq!(
            read_result.status(),
            CompletionStatus::Failed,
            "case: {label}"
        );
        let err = expect_error(read_result, ErrorCode::InvalidDocument);
        assert_eq!(err.operation(), Some("pdf.read_metadata"), "case: {label}");

        let write_result = run_operation(
            &SetMetadataOperation,
            SetMetadataInput::from_bytes(bytes).expect("input builds"),
            SetMetadataOptions::new(MetadataPatch::default()),
        );
        assert_eq!(
            write_result.status(),
            CompletionStatus::Failed,
            "case: {label}"
        );
        let err = expect_error(write_result, ErrorCode::InvalidDocument);
        assert_eq!(err.operation(), Some("pdf.set_metadata"), "case: {label}");
    }
}

#[test]
fn locked_input_fails_like_siblings() {
    let read_result = run_operation(
        &ReadMetadataOperation,
        read_input(common::locked_pdf()),
        ReadMetadataOptions::new(),
    );
    assert_eq!(read_result.status(), CompletionStatus::Failed);
    expect_error(read_result, ErrorCode::UnsupportedFormat);

    let write_result = run_operation(
        &SetMetadataOperation,
        write_input(common::locked_pdf()),
        SetMetadataOptions::new(MetadataPatch::default()),
    );
    assert_eq!(write_result.status(), CompletionStatus::Failed);
    expect_error(write_result, ErrorCode::UnsupportedFormat);
}

#[test]
fn read_honours_cancellation() {
    let source = CancellationSource::new();
    source.cancel();

    let engine = ExecutionEngine::new();
    let result = engine.execute_with_cancellation(
        &ReadMetadataOperation,
        read_input(common::metadata_rich_pdf()),
        ReadMetadataOptions::new(),
        source.token(),
    );
    assert_eq!(result.status(), CompletionStatus::Cancelled);
    expect_error(result, ErrorCode::Cancelled);
}

#[test]
fn write_honours_cancellation() {
    let source = CancellationSource::new();
    source.cancel();

    let engine = ExecutionEngine::new();
    let result = engine.execute_with_cancellation(
        &SetMetadataOperation,
        write_input(common::single_page_pdf()),
        SetMetadataOptions::new(MetadataPatch {
            title: FieldPatch::Set("T".to_string()),
            ..MetadataPatch::default()
        }),
        source.token(),
    );
    assert_eq!(result.status(), CompletionStatus::Cancelled);
    expect_error(result, ErrorCode::Cancelled);
}

#[test]
fn benchmark_helper_measures_metadata() {
    let engine = ExecutionEngine::new();
    let bytes = common::metadata_rich_pdf();
    let read_report = benchmark_operation(
        &engine,
        &ReadMetadataOperation,
        BenchmarkCase {
            input_label: "metadata-rich-fixture".to_string(),
            file_bytes: bytes.len() as u64,
            make_input: Box::new(move || read_input(bytes.clone())),
            options: ReadMetadataOptions::new(),
            repeats: 2,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.page_count),
    );
    assert_eq!(read_report.operation, "pdf.read_metadata");
    assert_eq!(read_report.failures, 0);
    assert!(read_report.measurements.iter().all(|m| m.success));

    let bytes = common::single_page_pdf();
    let patch = MetadataPatch {
        title: FieldPatch::Set("Benchmark".to_string()),
        ..MetadataPatch::default()
    };
    let write_report = benchmark_operation(
        &engine,
        &SetMetadataOperation,
        BenchmarkCase {
            input_label: "single-page-fixture".to_string(),
            file_bytes: bytes.len() as u64,
            make_input: Box::new(move || write_input(bytes.clone())),
            options: SetMetadataOptions::new(patch.clone()),
            repeats: 2,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.page_count),
    );
    assert_eq!(write_report.operation, "pdf.set_metadata");
    assert_eq!(write_report.failures, 0);
    assert!(write_report.measurements.iter().all(|m| m.success));
    assert!(!write_report.to_json().is_empty());
}
