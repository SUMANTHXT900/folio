//! Edge-case regression tests for `pdf.images_to_pdf` through the engine.
//!
//! Covers three gaps with no prior integration coverage (unit tests cover
//! the pure helpers only):
//!
//! * **Colon names** — image names are diagnostics-only and must accept
//!   Windows-hostile characters (notably `:`) without failing or
//!   corrupting error attribution.
//! * **DPI minimum** — a PNG `pHYs` chunk claiming sub-1 DPI is invalid and
//!   must fall back to the 150 DPI default (same page size as an image
//!   with no DPI metadata), never an error or a degenerate page.
//! * **MediaBox clamp** — a valid-but-tiny DPI on a large image would yield
//!   a hundred-thousand-point page; the uniform clamp caps the peak axis
//!   at exactly 14400 pt while preserving the aspect ratio.

use folio_engine::core::error::ErrorCode;
use folio_engine::processing::pdf::images_to_pdf::{
    ImageInput, ImagesToPdfInput, ImagesToPdfOperation, ImagesToPdfOptions,
};
use folio_engine::testing::pdf::{
    assert_lifecycle_complete, expect_error, expect_success, run_operation,
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

/// IEEE CRC-32 over the chunk type + data (PNG chunk checksum).
fn crc32_ieee(chunk_type: &[u8], data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in chunk_type.iter().chain(data.iter()) {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let lsb = crc & 1;
            crc >>= 1;
            if lsb == 1 {
                crc ^= 0xEDB8_8320;
            }
        }
    }
    !crc
}

/// Splices a `pHYs` chunk (square pixels, unit meter) before the first
/// `IDAT` chunk — the reader stops scanning at `IDAT`, so `pHYs` must
/// precede it — claiming `pixels_per_meter` on both axes. DPI =
/// ppm × 0.0254, so 20 ppm ≈ 0.51 DPI (below the 1.0 minimum →
/// invalid) and 40 ppm ≈ 1.02 DPI (valid but tiny).
fn with_phys_dpi(png: &[u8], pixels_per_meter: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity(9);
    data.extend_from_slice(&pixels_per_meter.to_be_bytes());
    data.extend_from_slice(&pixels_per_meter.to_be_bytes());
    data.push(1u8); // unit: meter

    let mut chunk = Vec::with_capacity(21);
    chunk.extend_from_slice(&9u32.to_be_bytes());
    chunk.extend_from_slice(b"pHYs");
    chunk.extend_from_slice(&data);
    chunk.extend_from_slice(&crc32_ieee(b"pHYs", &data).to_be_bytes());

    let mut out = Vec::with_capacity(png.len() + chunk.len());
    out.extend_from_slice(&png[..8]);
    let mut offset = 8usize;
    loop {
        let length =
            u32::from_be_bytes(png[offset..offset + 4].try_into().expect("chunk len")) as usize;
        let chunk_type = &png[offset + 4..offset + 8];
        let end = offset + 12 + length;
        if chunk_type == b"IDAT" {
            out.extend_from_slice(&chunk);
        }
        out.extend_from_slice(&png[offset..end]);
        offset = end;
        if chunk_type == b"IEND" {
            break;
        }
    }
    // The splice must survive a real decode or the CRC is wrong.
    image::load_from_memory(&out).expect("spliced png still decodes");
    out
}

fn page_size_of(png: Vec<u8>) -> (f64, f64) {
    let name = "probe.png";
    let input = ImagesToPdfInput::new(vec![ImageInput::new(name, png).expect("input builds")]);
    let result = run_operation(&ImagesToPdfOperation, input, ImagesToPdfOptions::default());
    assert_lifecycle_complete(&result);
    let mut output = expect_success(result);
    let bytes = output.document.save_to_bytes().expect("serializes");
    let reparsed =
        folio_engine::processing::pdf::core::loader::load_pdf(&bytes).expect("re-parses");
    let geometry = reparsed.page_geometry(1).expect("geometry");
    (geometry.width_pt, geometry.height_pt)
}

#[test]
fn colon_in_image_name_is_accepted() {
    let input = ImagesToPdfInput::new(vec![ImageInput::new(
        "scan:001.png",
        rgb_png(16, 16, [200, 30, 30]),
    )
    .expect("input builds")]);
    let result = run_operation(&ImagesToPdfOperation, input, ImagesToPdfOptions::default());
    assert_lifecycle_complete(&result);
    let output = expect_success(result);
    assert_eq!(output.page_count, 1);
}

#[test]
fn colon_in_image_name_survives_error_attribution() {
    let input = ImagesToPdfInput::new(vec![ImageInput::new(
        "bad:name.png",
        b"not an image".to_vec(),
    )
    .expect("input builds")]);
    let result = run_operation(&ImagesToPdfOperation, input, ImagesToPdfOptions::default());
    assert_lifecycle_complete(&result);
    let err = expect_error(result, ErrorCode::UnsupportedFormat);
    let details = err.details().expect("details");
    assert!(details.contains("bad:name.png"), "{details}");
}

#[test]
fn sub_minimum_dpi_falls_back_to_default() {
    let plain = rgb_png(150, 150, [10, 200, 10]);
    let tiny_dpi = with_phys_dpi(&plain, 20); // ≈0.51 DPI: below MIN_DPI 1.0
    let (plain_w, plain_h) = page_size_of(plain);
    assert!((plain_w - 72.0).abs() < 0.05, "{plain_w}");
    assert!((plain_h - 72.0).abs() < 0.05, "{plain_h}");
    // Invalid DPI is ignored, never an error: identical to no metadata.
    let (tagged_w, tagged_h) = page_size_of(tiny_dpi);
    assert!((tagged_w - plain_w).abs() < 0.05, "{tagged_w} vs {plain_w}");
    assert!((tagged_h - plain_h).abs() < 0.05, "{tagged_h} vs {plain_h}");
}

#[test]
fn huge_low_dpi_page_clamps_to_viewer_sane_size() {
    // 1200×600 px at ≈1.02 DPI would be an ~85000 pt page; the uniform
    // clamp caps the peak axis at exactly 14400 pt, keeping 2:1 exact.
    let tagged = with_phys_dpi(&rgb_png(1200, 600, [90, 90, 200]), 40);
    let (width, height) = page_size_of(tagged);
    assert!((width - 14_400.0).abs() < 1.0, "{width}");
    assert!(width <= 14_400.01, "{width}");
    assert!((width / height - 2.0).abs() < 0.01, "{width}x{height}");
}
