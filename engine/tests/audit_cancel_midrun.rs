//! Mid-run cancellation through the real engine.
//!
//! Every existing cancellation test pre-cancels its token before executing,
//! which only proves the first checkpoint works. These tests prove the
//! cooperative checkpoints *inside* the per-item loops work: a progress
//! sink cancels the token after the first unit of real work is reported,
//! so the run must observe cancellation mid-loop, stop safely, and report
//! a `Cancelled` result with a complete lifecycle.
//!
//! The sink runs synchronously inside `execute_with_cancellation` on the
//! same thread, so no threads or sleeps are involved and the tests are
//! fully deterministic: at least one progress event is always emitted
//! before the token flips.

#[path = "common/mod.rs"]
mod common;

use std::sync::{Arc, Mutex};

use folio_engine::core::error::ErrorCode;
use folio_engine::core::result::CompletionStatus;
use folio_engine::execution::cancellation::{CancellationSource, CancellationToken};
use folio_engine::execution::progress::{ProgressEvent, ProgressSink};
use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::loader::load_pdf;
use folio_engine::processing::pdf::images_to_pdf::{
    ImageInput, ImagesToPdfInput, ImagesToPdfOperation, ImagesToPdfOptions,
};
use folio_engine::processing::pdf::merge::{MergeInput, MergeOperation, MergeOptions};
use folio_engine::testing::pdf::{assert_lifecycle_complete, expect_error};

/// Cancels its token the first time it observes `phase`, counting how
/// many such events it saw. The count proves the operation performed real
/// work before cancellation (mid-run), as opposed to a pre-cancelled
/// token that never starts.
struct CancellingSink {
    token: CancellationToken,
    phase: &'static str,
    seen: Mutex<usize>,
}

impl CancellingSink {
    fn watched(token: CancellationToken, phase: &'static str) -> Arc<Self> {
        Arc::new(Self {
            token,
            phase,
            seen: Mutex::new(0),
        })
    }

    fn seen(&self) -> usize {
        *self.seen.lock().expect("sink lock")
    }
}

impl ProgressSink for CancellingSink {
    fn emit(&self, event: ProgressEvent) {
        if event.phase() == Some(self.phase) {
            *self.seen.lock().expect("sink lock") += 1;
            self.token.cancel();
        }
    }
}

fn rgb_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    use image::ImageEncoder;
    let mut img = image::RgbImage::new(width, height);
    for pixel in img.pixels_mut() {
        *pixel = image::Rgb(rgb);
    }
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(img.as_raw(), width, height, image::ExtendedColorType::Rgb8)
        .expect("png encodes");
    bytes
}

#[test]
fn images_to_pdf_stops_mid_loop_when_sink_cancels() {
    let source = CancellationSource::new();
    let sink = CancellingSink::watched(source.token(), "processing images");
    let engine = ExecutionEngine::new().with_progress(sink.clone());

    let images: Vec<ImageInput> = (0..6)
        .map(|i| ImageInput::new(format!("page-{i}.png"), rgb_png(16, 16, [i as u8, 40, 90])))
        .collect::<Result<_, _>>()
        .expect("inputs build");
    let result = engine.execute_with_cancellation(
        &ImagesToPdfOperation,
        ImagesToPdfInput::new(images),
        ImagesToPdfOptions::default(),
        source.token(),
    );

    assert_eq!(result.status(), CompletionStatus::Cancelled);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::Cancelled);
    assert_eq!(err.operation(), Some("pdf.images_to_pdf"));
    // Exactly one per-image event fired before the next loop iteration
    // observed the flipped token: work started, then stopped mid-run.
    assert_eq!(sink.seen(), 1, "cancellation must land mid-loop");
}

#[test]
fn merge_stops_mid_copy_when_sink_cancels() {
    let source = CancellationSource::new();
    let sink = CancellingSink::watched(source.token(), "merging");
    let engine = ExecutionEngine::new().with_progress(sink.clone());

    let documents = vec![
        load_pdf(&common::mixed_pages_pdf()).expect("fixture loads"),
        load_pdf(&common::five_page_pdf()).expect("fixture loads"),
    ];
    let result = engine.execute_with_cancellation(
        &MergeOperation,
        MergeInput::new(documents),
        MergeOptions::new(),
        source.token(),
    );

    assert_eq!(result.status(), CompletionStatus::Cancelled);
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::Cancelled);
    assert_eq!(err.operation(), Some("pdf.merge"));
    // The first per-page event fired (one page copied), then the next
    // page callback observed cancellation: 8 pages in, stopped after 1.
    assert_eq!(sink.seen(), 1, "cancellation must land mid-copy");
}
