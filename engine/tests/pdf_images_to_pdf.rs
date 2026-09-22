//! Integration tests for `pdf.images_to_pdf` through the real engine.
//!
//! Arrange → execute through `ExecutionEngine` → assert outcome → assert
//! lifecycle → validate produced data. Image fixtures are generated in
//! memory with the `image` crate (already a library dependency); no binary
//! fixtures are committed and the `test pdfs/` corpus is never touched.

mod common;

use folio_engine::core::error::ErrorCode;
use folio_engine::execution::cancellation::CancellationSource;
use folio_engine::processing::pdf::core::loader::load_pdf;
use folio_engine::processing::pdf::images_to_pdf::{
    ImageInput, ImagesToPdfInput, ImagesToPdfOperation, ImagesToPdfOptions, PageSizePolicy,
};
use folio_engine::testing::pdf::{
    assert_lifecycle_complete, assert_progress_completed, benchmark_operation, expect_error,
    expect_success, run_operation, test_engine,
};

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

fn jpeg(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    use image::ImageEncoder;
    let mut img = image::RgbImage::new(width, height);
    for pixel in img.pixels_mut() {
        *pixel = image::Rgb(rgb);
    }
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90)
        .write_image(img.as_raw(), width, height, image::ExtendedColorType::Rgb8)
        .expect("jpeg encodes");
    bytes
}

fn input(entries: Vec<(&str, Vec<u8>)>) -> ImagesToPdfInput {
    ImagesToPdfInput::new(
        entries
            .into_iter()
            .map(|(name, bytes)| ImageInput::new(name, bytes).expect("input builds"))
            .collect(),
    )
}

fn output_images(bytes: &[u8]) -> Vec<(u32, u32, Vec<u8>)> {
    let raw = lopdf::Document::load_mem(bytes).expect("output parses");
    let pages = raw.get_pages();
    let mut numbers: Vec<u32> = pages.keys().copied().collect();
    numbers.sort_unstable();
    let mut out = Vec::new();
    for number in numbers {
        let page_id = pages[&number];
        let page = raw.get_dictionary(page_id).expect("page dict");
        let resources = page.get(b"Resources").expect("resources");
        let (_, resources) = raw.dereference(resources).expect("resolve");
        let xobjects = resources
            .as_dict()
            .expect("dict")
            .get(b"XObject")
            .expect("xobject");
        let (_, xobjects) = raw.dereference(xobjects).expect("resolve");
        let im = xobjects.as_dict().expect("dict").get(b"Im1").expect("Im1");
        let (_, image) = raw.dereference(im).expect("image resolves");
        let stream = image.as_stream().expect("stream");
        let width = stream.dict.get(b"Width").expect("w").as_i64().expect("int") as u32;
        let height = stream
            .dict
            .get(b"Height")
            .expect("h")
            .as_i64()
            .expect("int") as u32;
        out.push((width, height, stream.content.clone()));
    }
    out
}

#[test]
fn jpeg_to_pdf_through_engine() {
    let result = run_operation(
        &ImagesToPdfOperation,
        input(vec![("photo.jpg", jpeg(16, 12, [200, 30, 30]))]),
        ImagesToPdfOptions::default(),
    );
    assert_lifecycle_complete(&result);
    let mut output = expect_success(result);
    assert_eq!(output.page_count, 1);
    assert_eq!(output.image_count, 1);
    let bytes = output.document.save_to_bytes().expect("serializes");
    let reparsed = load_pdf(&bytes).expect("re-parses");
    assert_eq!(reparsed.page_count(), 1);
}

#[test]
fn png_to_pdf_through_engine() {
    let result = run_operation(
        &ImagesToPdfOperation,
        input(vec![("graphic.png", rgb_png(12, 16, [30, 120, 200]))]),
        ImagesToPdfOptions::default(),
    );
    assert_lifecycle_complete(&result);
    let mut output = expect_success(result);
    let bytes = output.document.save_to_bytes().expect("serializes");
    let reparsed = load_pdf(&bytes).expect("re-parses");
    assert_eq!(reparsed.page_count(), 1);
    let geometry = reparsed.page_geometry(1).expect("geometry");
    assert!(geometry.height_pt > geometry.width_pt);
}

#[test]
fn multiple_images_preserve_order() {
    let result = run_operation(
        &ImagesToPdfOperation,
        input(vec![
            ("a.png", rgb_png(8, 8, [255, 0, 0])),
            ("b.jpg", jpeg(8, 8, [0, 255, 0])),
            ("c.png", rgb_png(8, 8, [0, 0, 255])),
        ]),
        ImagesToPdfOptions::default(),
    );
    assert_lifecycle_complete(&result);
    let mut output = expect_success(result);
    assert_eq!(output.page_count, 3);
    let bytes = output.document.save_to_bytes().expect("serializes");
    let images = output_images(&bytes);
    assert_eq!(images.len(), 3);
    // JPEG middle page is lossy: assert hue dominance instead of exact bytes.
    assert_eq!(&images[0].2[0..3], &[255, 0, 0]);
    assert_eq!(&images[2].2[0..3], &[0, 0, 255]);
    let (r, g, b) = (images[1].2[0], images[1].2[1], images[1].2[2]);
    assert!(g > r && g > b, "middle page stays greenish: {r},{g},{b}");
}

#[test]
fn mixed_orientations_keep_aspect() {
    let result = run_operation(
        &ImagesToPdfOperation,
        input(vec![
            ("portrait.png", rgb_png(8, 16, [10, 10, 10])),
            ("landscape.jpg", jpeg(16, 8, [10, 10, 10])),
            ("square.png", rgb_png(12, 12, [10, 10, 10])),
        ]),
        ImagesToPdfOptions::default(),
    );
    let mut output = expect_success(result);
    let bytes = output.document.save_to_bytes().expect("serializes");
    let reparsed = load_pdf(&bytes).expect("re-parses");
    assert_eq!(reparsed.page_count(), 3);
    let portrait = reparsed.page_geometry(1).expect("p1");
    let landscape = reparsed.page_geometry(2).expect("p2");
    let square = reparsed.page_geometry(3).expect("p3");
    assert!(portrait.height_pt > portrait.width_pt);
    assert!(landscape.width_pt > landscape.height_pt);
    assert!((square.width_pt - square.height_pt).abs() < 0.05);
}

#[test]
fn standard_page_produces_a4() {
    let result = run_operation(
        &ImagesToPdfOperation,
        input(vec![("wide.png", rgb_png(16, 8, [90, 90, 90]))]),
        ImagesToPdfOptions::new(PageSizePolicy::StandardPage, [255, 255, 255]),
    );
    let mut output = expect_success(result);
    let bytes = output.document.save_to_bytes().expect("serializes");
    let reparsed = load_pdf(&bytes).expect("re-parses");
    let geometry = reparsed.page_geometry(1).expect("geometry");
    assert!(
        (geometry.width_pt - 595.28).abs() < 0.1,
        "{}",
        geometry.width_pt
    );
    assert!(
        (geometry.height_pt - 841.89).abs() < 0.1,
        "{}",
        geometry.height_pt
    );
}

#[test]
fn rejects_zero_images() {
    let result = run_operation(
        &ImagesToPdfOperation,
        ImagesToPdfInput::new(vec![]),
        ImagesToPdfOptions::default(),
    );
    assert_lifecycle_complete(&result);
    expect_error(result, ErrorCode::InvalidInput);
}

#[test]
fn rejects_unsupported_format_with_attribution() {
    let result = run_operation(
        &ImagesToPdfOperation,
        input(vec![("notes.txt", b"hello, not an image".to_vec())]),
        ImagesToPdfOptions::default(),
    );
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::UnsupportedFormat);
    let details = err.details().expect("details");
    assert!(details.contains("image_index=1"), "{details}");
    assert!(details.contains("notes.txt"), "{details}");
}

#[test]
fn failing_entry_identifies_its_index() {
    let result = run_operation(
        &ImagesToPdfOperation,
        input(vec![
            ("first.png", rgb_png(8, 8, [1, 2, 3])),
            ("second.png", b"bad".to_vec()),
        ]),
        ImagesToPdfOptions::default(),
    );
    let err = expect_error(result, ErrorCode::UnsupportedFormat);
    let details = err.details().expect("details");
    assert!(details.contains("image_index=2"), "{details}");
    assert!(details.contains("second.png"), "{details}");
}

#[test]
fn progress_reaches_100_on_success() {
    let (engine, sink) = test_engine();
    let result = engine.execute(
        &ImagesToPdfOperation,
        input(vec![
            ("a.png", rgb_png(8, 8, [1, 1, 1])),
            ("b.png", rgb_png(8, 8, [2, 2, 2])),
        ]),
        ImagesToPdfOptions::default(),
    );
    assert_lifecycle_complete(&result);
    assert!(result.is_success());
    assert_progress_completed(&sink, &result);
}

#[test]
fn cancellation_aborts_multi_image_run() {
    use folio_engine::execution::scheduler::ExecutionEngine;
    let source = CancellationSource::new();
    let token = source.token();
    source.cancel();
    assert!(token.is_cancelled());
    let engine = ExecutionEngine::new();
    let result = engine.execute_with_cancellation(
        &ImagesToPdfOperation,
        input(vec![
            ("a.png", rgb_png(16, 16, [1, 1, 1])),
            ("b.png", rgb_png(16, 16, [2, 2, 2])),
        ]),
        ImagesToPdfOptions::default(),
        token,
    );
    assert_lifecycle_complete(&result);
    expect_error(result, ErrorCode::Cancelled);
}

#[test]
fn benchmark_smoke_three_images() {
    use folio_engine::testing::pdf::BenchmarkCase;
    let engine = folio_engine::execution::scheduler::ExecutionEngine::new();
    let make = || {
        input(vec![
            ("a.png", rgb_png(32, 32, [200, 30, 30])),
            ("b.jpg", jpeg(32, 32, [30, 200, 30])),
            ("c.png", rgb_png(32, 32, [30, 30, 200])),
        ])
    };
    let total_bytes: u64 = {
        let probe = make();
        probe
            .images
            .iter()
            .map(|image| image.bytes.len() as u64)
            .sum()
    };
    let case = BenchmarkCase {
        input_label: "3 mixed images".to_string(),
        file_bytes: total_bytes,
        make_input: Box::new(make),
        options: ImagesToPdfOptions::default(),
        repeats: 2,
    };
    let report = benchmark_operation(&engine, &ImagesToPdfOperation, case, |outcome| {
        outcome.as_ref().ok().map(|out| out.page_count)
    });
    assert_eq!(report.repeats, 2);
    assert_eq!(report.failures, 0);
    assert!(report.to_json().contains("pdf.images_to_pdf"));
}
