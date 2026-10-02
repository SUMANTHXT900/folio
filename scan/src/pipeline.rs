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
//!
//! Memory discipline (R2): the full-resolution RGB buffer is the
//! pipeline's peak cost (~3 B/px — 36 MB at 12 MP). Decoding reuses the
//! decoder's own allocation wherever the `image` crate allows (JPEG
//! decodes straight to RGB8: zero-copy move; RGBA strips alpha in place
//! in the same allocation instead of holding RGBA+RGB simultaneously).
//! Enhancement modes encode ONCE (5-1): warp → mode → JPEG over the
//! warped pixels, with no intermediate JPEG encode/decode round-trip
//! (the old path re-encoded the warp and decoded it back before
//! enhancing — slower AND lossier).

use crate::detect::detect_document;
use crate::enhance::{apply_mode, ScanMode};
use crate::error::{ScanError, ScanErrorKind};
use crate::geometry::Point;
use crate::warp::{encode_jpeg, output_dims, warp_quad, warp_to_jpeg, SCAN_JPEG_QUALITY};

/// Output long-edge cap (px). BENCHMARK CONSTRAINT for M1 (correction 5):
/// tune after measuring real quality/memory, do not hard-code forever.
///
/// Applied exactly once per scan (shutter and crop-review rewarp paths)
/// via [`crate::warp::output_dims`], which derives output size from the
/// quad's own pixel dimensions and only ever shrinks — a small crop
/// region keeps its native resolution (never downscaled toward the cap,
/// never upscaled).
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
    let rgb8 = decode_to_rgb8(&request.bytes)?;
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
    if request.mode == ScanMode::Original {
        let (bytes, out_w, out_h) =
            warp_to_jpeg(rgb8.as_raw(), w, h, &d.quad, MAX_OUTPUT_LONG_EDGE)?;
        return Ok(ScanOutput {
            bytes,
            width: out_w,
            height: out_h,
            corners: Some(d.quad.corners()),
            confidence: d.confidence,
            fallback: false,
        });
    }
    // Single encode (5-1): warp to pixels, enhance in place, encode once.
    // The old path ran warp→JPEG→decode→enhance→JPEG: a full extra
    // encode/decode of the warped image that cost CPU and added a second
    // generation of JPEG loss on top of the final encode.
    let (out_w, out_h) = output_dims(&d.quad, MAX_OUTPUT_LONG_EDGE);
    let warped = warp_quad(rgb8.as_raw(), w, h, &d.quad, out_w, out_h)?;
    drop(rgb8);
    let enhanced = apply_mode(warped, out_w, out_h, request.mode);
    let bytes = encode_jpeg(&enhanced, out_w, out_h, SCAN_JPEG_QUALITY)?;
    Ok(ScanOutput {
        bytes,
        width: out_w,
        height: out_h,
        corners: Some(d.quad.corners()),
        confidence: d.confidence,
        fallback: false,
    })
}

/// Decodes JPEG/PNG bytes to an owned RGB8 buffer with minimal peak
/// memory (R2). JPEG decoders emit RGB8 directly, so that path is a
/// zero-copy move (`into_rgb8` returns the buffer as-is). RGBA inputs
/// (screenshots, PNGs with alpha) strip the alpha channel IN PLACE in
/// the decoder's own allocation: pixel-identical to `into_rgb8` (the
/// `image` crate's Rgba→Rgb conversion drops alpha without compositing
/// — verified against `color.rs` `FromColor<Rgba<S>> for Rgb<T>`), while
/// peak drops from RGBA+RGB simultaneously (7 B/px) to the one buffer
/// (4 B/px, truncated to 3 B/px). All other color types keep the
/// crate's conversion unchanged (rare inputs: Luma PNGs, 16-bit).
fn decode_to_rgb8(bytes: &[u8]) -> Result<image::RgbImage, ScanError> {
    let decoded = image::load_from_memory(bytes).map_err(|err| {
        ScanError::new(
            ScanErrorKind::InvalidInput,
            "scan input is not a readable JPEG/PNG image",
        )
        .with_details(err.to_string())
    })?;
    match decoded {
        image::DynamicImage::ImageRgb8(buf) => Ok(buf),
        image::DynamicImage::ImageRgba8(buf) => {
            let (w, h) = (buf.width(), buf.height());
            let mut raw = buf.into_raw();
            let pixels = raw.len() / 4;
            // Forward compaction is safe: write index (3i) never passes
            // read index (4i), so no unread byte is ever clobbered.
            for i in 0..pixels {
                raw[i * 3] = raw[i * 4];
                raw[i * 3 + 1] = raw[i * 4 + 1];
                raw[i * 3 + 2] = raw[i * 4 + 2];
            }
            raw.truncate(pixels * 3);
            image::RgbImage::from_raw(w, h, raw).ok_or_else(|| {
                ScanError::new(
                    ScanErrorKind::InvalidInput,
                    "RGBA alpha-strip produced a short buffer",
                )
            })
        }
        other => Ok(other.into_rgb8()),
    }
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
    fn single_encode_keeps_detection_and_mode_semantics() {
        // 5-1: warp→mode→encode once must not move detection (same input,
        // same corners/confidence as the color path) and the mode must
        // survive the single JPEG generation.
        let (bytes, _, _) = doc_photo();
        let color = scan_document(&ScanRequest {
            bytes: bytes.clone(),
            mode: ScanMode::Original,
            detect_only: false,
        })
        .expect("scans");
        assert!(!color.fallback);
        let gray = scan_document(&ScanRequest {
            bytes: bytes.clone(),
            mode: ScanMode::Grayscale,
            detect_only: false,
        })
        .expect("scans");
        assert!(!gray.fallback);
        assert_eq!(gray.corners, color.corners);
        assert_eq!(gray.confidence, color.confidence);
        assert_eq!((gray.width, gray.height), (color.width, color.height));
        // Grayscale survives its JPEG: mean inter-channel spread stays
        // tiny (chroma-subsampling noise averages out over the page).
        let back = image::load_from_memory(&gray.bytes)
            .expect("decodes")
            .into_rgb8();
        let (mut spread, mut n) = (0u64, 0u64);
        for px in back.pixels() {
            let (r, g, b) = (u64::from(px[0]), u64::from(px[1]), u64::from(px[2]));
            spread += r.max(g).max(b) - r.min(g).min(b);
            n += 1;
        }
        assert!(
            spread as f64 / n as f64 <= 6.0,
            "mean channel spread {}",
            spread as f64 / n as f64
        );
        // B&W survives its JPEG: nearly every pixel stays near-binary
        // (JPEG ringing only fringes the ink edges).
        let bw = scan_document(&ScanRequest {
            bytes,
            mode: ScanMode::BlackWhite,
            detect_only: false,
        })
        .expect("scans");
        assert!(!bw.fallback);
        let back = image::load_from_memory(&bw.bytes)
            .expect("decodes")
            .into_rgb8();
        let total = (back.width() * back.height()) as usize;
        let binary = back
            .pixels()
            .filter(|px| {
                (px[0] < 48 && px[1] < 48 && px[2] < 48)
                    || (px[0] > 207 && px[1] > 207 && px[2] > 207)
            })
            .count();
        assert!(
            binary as f64 / total as f64 > 0.95,
            "binary fraction {}",
            binary as f64 / total as f64
        );
    }

    #[test]
    fn rgba_alpha_strip_is_pixel_identical_to_crate_conversion() {
        // R2: the in-place RGBA→RGB strip must produce EXACTLY the bytes
        // `into_rgb8` would (which drops alpha without compositing), so
        // detection/warp see bit-identical pixels with a lower peak.
        let (w, h) = (64u32, 48u32);
        let mut rgba = image::RgbaImage::new(w, h);
        for (x, y, px) in rgba.enumerate_pixels_mut() {
            let n = ((x * 7919 + y * 104729) % 256) as u8;
            // Varied alpha (incl. fully transparent) exercises the strip.
            *px = image::Rgba([n, 255 - n, (x + y) as u8, ((x * y) % 256) as u8]);
        }
        let mut png = Vec::new();
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(rgba.as_raw(), w, h, image::ExtendedColorType::Rgba8)
            .expect("encodes");
        let stripped = super::decode_to_rgb8(&png).expect("decodes");
        let reference = image::load_from_memory(&png).expect("decodes").into_rgb8();
        assert_eq!(stripped.as_raw(), reference.as_raw());
    }

    #[test]
    fn rgba_input_scans_like_its_rgb_twin() {
        // End to end: an opaque-alpha RGBA PNG detects the same document
        // as the equivalent RGB JPEG (strip changes no pixel).
        let (w, h) = (640u32, 800u32);
        let mut rgba = image::RgbaImage::new(w, h);
        for (x, y, px) in rgba.enumerate_pixels_mut() {
            let inside = (100..540).contains(&x) && (120..680).contains(&y);
            let v = if inside { 242u8 } else { 18u8 };
            *px = image::Rgba([v, v, v, 255]);
        }
        let mut png = Vec::new();
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(rgba.as_raw(), w, h, image::ExtendedColorType::Rgba8)
            .expect("encodes");
        let out = scan_document(&ScanRequest {
            bytes: png,
            mode: ScanMode::Original,
            detect_only: false,
        })
        .expect("scans");
        assert!(!out.fallback, "opaque RGBA must detect");
        assert!(out.confidence >= 0.5, "{}", out.confidence);
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
