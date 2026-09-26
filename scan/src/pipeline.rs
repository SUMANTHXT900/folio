//! Scan pipeline: decode → detect (downscaled, borrowed) → warp (full-res)
//! → enhance (mode) → JPEG.
//!
//! `detect_only` requests stop after detection: corners/confidence return
//! with no output bytes and no warp/encode work (live guidance every
//! ~500 ms must never pay for a result it discards).
//!
//! Detection failure is never fatal: the original bytes return with
//! `fallback: true` so the caller offers "Use original". Orientation
//! assumption: input bytes are already upright (camera captures are
//! EXIF-free canvas JPEGs — the v2.0 M3 wiring; uploads with EXIF
//! orientation are out of scope for the scan path, documented here
//! rather than silently mishandled).

use crate::detect::detect_document;
use crate::enhance::{apply_mode, ScanMode};
use crate::error::{ScanError, ScanErrorKind};
use crate::geometry::Point;
use crate::warp::{encode_jpeg, warp_to_jpeg, SCAN_JPEG_QUALITY};

/// Output long-edge cap (px). BENCHMARK CONSTRAINT for M1 (correction 5):
/// tune after measuring real quality/memory, do not hard-code forever.
pub const MAX_OUTPUT_LONG_EDGE: u32 = 2500;

/// One scan job: owned bytes in, owned outputs out. No I/O, no globals.
#[derive(Debug, Clone)]
pub struct ScanRequest {
    /// JPEG/PNG bytes (upright).
    pub bytes: Vec<u8>,
    /// Enhancement mode.
    pub mode: ScanMode,
    /// Detection-only fast path (live guidance): run detection, skip the
    /// warp + JPEG stages, and return EMPTY [`ScanOutput::bytes`].
    pub detect_only: bool,
}

/// Scan result: processed JPEG plus provenance for the UI.
#[derive(Debug, Clone)]
pub struct ScanOutput {
    /// Processed (or original, on fallback) JPEG bytes. EMPTY for
    /// `detect_only` requests — the fast path produces no image bytes.
    pub bytes: Vec<u8>,
    /// Output dimensions (px); the INPUT dimensions for `detect_only`
    /// (no warp runs, so there is no output size to report).
    pub width: u32,
    pub height: u32,
    /// Detected corners in input coordinates (None on fallback).
    pub corners: Option<[Point; 4]>,
    /// Earned detection confidence (0 on fallback).
    pub confidence: f64,
    /// True when detection failed and the original is returned.
    pub fallback: bool,
}

/// Runs the scan pipeline over owned image bytes.
pub fn scan_document(request: &ScanRequest) -> Result<ScanOutput, ScanError> {
    if request.bytes.is_empty() {
        return Err(ScanError::new(
            ScanErrorKind::InvalidInput,
            "scan input bytes must not be empty",
        ));
    }
    let decoded = image::load_from_memory(&request.bytes).map_err(|err| {
        ScanError::new(
            ScanErrorKind::InvalidInput,
            "scan input is not a readable JPEG/PNG image",
        )
        .with_details(err.to_string())
    })?;
    // Own the decoder's buffer: `into_rgb8` moves it when the decoder
    // already produced RGB8 (JPEG always does), instead of cloning the
    // full-resolution pixels through `to_rgb8`.
    let rgb8 = decoded.into_rgb8();
    let (w, h) = (rgb8.width(), rgb8.height());
    if w == 0 || h == 0 {
        return Err(ScanError::new(
            ScanErrorKind::UnsupportedDimensions,
            "scan input has zero dimensions",
        ));
    }

    // Detection borrows the owned buffer; the warp below reuses it.
    let detection = detect_document(rgb8.as_raw(), w, h)?;
    let Some(d) = detection else {
        return Ok(ScanOutput {
            // Live guidance never receives bytes; the full path returns
            // the original capture for the "Use original" option.
            bytes: if request.detect_only {
                Vec::new()
            } else {
                request.bytes.clone()
            },
            width: w,
            height: h,
            corners: None,
            confidence: 0.0,
            fallback: true,
        });
    };
    if request.detect_only {
        return Ok(ScanOutput {
            bytes: Vec::new(),
            width: w,
            height: h,
            corners: Some(d.quad.corners()),
            confidence: d.confidence,
            fallback: false,
        });
    }
    let (mut bytes, out_w, out_h) =
        warp_to_jpeg(rgb8.as_raw(), w, h, &d.quad, MAX_OUTPUT_LONG_EDGE)?;
    if request.mode != ScanMode::Original {
        let warped = image::load_from_memory(&bytes).expect("just-encoded JPEG decodes");
        // Move when already RGB8 — no full-resolution clone.
        let w2 = warped.into_rgb8();
        let enhanced = apply_mode(w2.as_raw(), out_w, out_h, request.mode);
        bytes = encode_jpeg(&enhanced, out_w, out_h, SCAN_JPEG_QUALITY)?;
    }
    Ok(ScanOutput {
        bytes,
        width: out_w,
        height: out_h,
        corners: Some(d.quad.corners()),
        confidence: d.confidence,
        fallback: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encodes an RGB buffer as JPEG (test fixture writer).
    fn jpeg_of(rgb: &[u8], w: u32, h: u32) -> Vec<u8> {
        use image::ImageEncoder;
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 95)
            .write_image(rgb, w, h, image::ExtendedColorType::Rgb8)
            .expect("encodes");
        bytes
    }

    /// White perspective quad on near-black with slight noise.
    fn doc_photo() -> (Vec<u8>, u32, u32) {
        let (w, h) = (640u32, 800u32);
        let mut rgb = vec![18u8; w as usize * h as usize * 3];
        for y in 0..h {
            for x in 0..w {
                // Deterministic pseudo-noise on the background.
                let n = ((x * 7919 + y * 104729) % 17) as u8;
                let o = (y as usize * w as usize + x as usize) * 3;
                rgb[o] += n;
                rgb[o + 1] += n;
                rgb[o + 2] += n;
            }
        }
        // Fill the quad white via edge interpolation per scanline.
        for y in 0..h {
            let lx = 80.0 + (120.0 - 80.0) * ((660.0 - f64::from(y)) / 570.0).clamp(0.0, 1.0);
            let rx = 470.0 + (520.0 - 470.0) * ((700.0 - f64::from(y)) / 570.0).clamp(0.0, 1.0);
            if (90..=700).contains(&y) {
                for x in (lx as u32)..=(rx as u32).min(w - 1) {
                    let o = (y as usize * w as usize + x as usize) * 3;
                    rgb[o] = 245;
                    rgb[o + 1] = 245;
                    rgb[o + 2] = 245;
                }
            }
        }
        (jpeg_of(&rgb, w, h), w, h)
    }

    /// Solid near-black JPEG (detection sees no document).
    fn blank_jpeg() -> Vec<u8> {
        let gray = image::GrayImage::from_pixel(320, 240, image::Luma([18u8]));
        let mut bytes = Vec::new();
        use image::ImageEncoder;
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 95)
            .write_image(gray.as_raw(), 320, 240, image::ExtendedColorType::L8)
            .expect("encodes");
        bytes
    }

    #[test]
    fn pipeline_scans_a_document_photo() {
        let (bytes, _, _) = doc_photo();
        let out = scan_document(&ScanRequest {
            bytes,
            mode: ScanMode::Original,
            detect_only: false,
        })
        .expect("scans");
        assert!(!out.fallback, "should detect");
        assert!(out.confidence >= 0.5, "{}", out.confidence);
        assert!(out.corners.is_some());
        assert!(out.width > 200 && out.height > 200);
        assert_eq!(&out.bytes[0..3], &[0xFF, 0xD8, 0xFF]);
    }

    #[test]
    fn pipeline_modes_cover_grayscale_and_bw() {
        let (bytes, _, _) = doc_photo();
        for mode in [ScanMode::Grayscale, ScanMode::BlackWhite] {
            let out = scan_document(&ScanRequest {
                bytes: bytes.clone(),
                mode,
                detect_only: false,
            })
            .expect("scans");
            assert!(!out.fallback);
            let back = image::load_from_memory(&out.bytes).expect("decodes");
            assert_eq!((back.width(), back.height()), (out.width, out.height));
        }
    }

    #[test]
    fn pipeline_detect_only_returns_corners_without_bytes() {
        let (bytes, w, h) = doc_photo();
        let full = scan_document(&ScanRequest {
            bytes: bytes.clone(),
            mode: ScanMode::Original,
            detect_only: false,
        })
        .expect("scans");
        let live = scan_document(&ScanRequest {
            bytes,
            mode: ScanMode::Original,
            detect_only: true,
        })
        .expect("runs");
        assert!(!live.fallback);
        assert!(live.corners.is_some());
        assert!(live.confidence >= 0.5, "{}", live.confidence);
        assert!(live.bytes.is_empty(), "detect-only must not produce bytes");
        // Live guidance reports INPUT dimensions (no warp ran).
        assert_eq!((live.width, live.height), (w, h));
        // Detection is identical with and without the warp stages.
        assert_eq!(live.corners, full.corners);
        assert_eq!(live.confidence, full.confidence);
    }

    #[test]
    fn pipeline_detect_only_fallback_carries_no_bytes() {
        let out = scan_document(&ScanRequest {
            bytes: blank_jpeg(),
            mode: ScanMode::Original,
            detect_only: true,
        })
        .expect("runs");
        assert!(out.fallback);
        assert!(out.corners.is_none());
        assert_eq!(out.confidence, 0.0);
        assert!(out.bytes.is_empty(), "fallback must not clone bytes back");
        assert_eq!((out.width, out.height), (320, 240));
    }

    #[test]
    fn pipeline_falls_back_on_blank_input() {
        let bytes = blank_jpeg();
        let out = scan_document(&ScanRequest {
            bytes: bytes.clone(),
            mode: ScanMode::Original,
            detect_only: false,
        })
        .expect("runs");
        assert!(out.fallback);
        assert_eq!(out.confidence, 0.0);
        assert!(out.corners.is_none());
        assert_eq!(out.bytes, bytes);
    }

    #[test]
    fn pipeline_rejects_garbage() {
        assert!(scan_document(&ScanRequest {
            bytes: vec![],
            mode: ScanMode::Original,
            detect_only: false,
        })
        .is_err());
        assert!(scan_document(&ScanRequest {
            bytes: b"not an image".to_vec(),
            mode: ScanMode::Original,
            detect_only: false,
        })
        .is_err());
    }
}
