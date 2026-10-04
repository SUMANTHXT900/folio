//! Perspective warp: inverse-mapped bilinear resampling of a quad to a
//! rectangle, plus JPEG encoding.
//!
//! Self-implemented (no warp-API dependency risk): homography math lives
//! in `geometry`; this module owns sampling and output sizing.

use image::codecs::jpeg::JpegEncoder;
use image::ImageEncoder;

use crate::error::{ScanError, ScanErrorKind};
use crate::geometry::{apply_homography, homography, invert_homography, Point, Quad};

/// JPEG quality for the scan re-encode (the SECOND JPEG generation of
/// every scanned page).
///
/// JPEG-generation chain per scan (why 95/95):
///
/// ```text
/// capture canvas clamp ≤3600px, JPEG q0.95   → generation 1 (app side)
/// scan decode → warp → SCAN_JPEG_QUALITY 95  → generation 2 (here)
/// images_to_pdf DCT-passthrough embed        → byte-identical (keep!)
/// ```
///
/// Both generations land on glyph edges, where DCT ringing compounds:
/// generation 2 re-encodes pixels that generation 1 already softened, so
/// the two encodes must be tuned TOGETHER — 95/95. Bumping only one side
/// leaves the other generation's mush visible; 95 sits near the JPEG
/// quality knee where text-edge ringing drops sharply for a modest byte
/// cost. The capture encode mirrors this constant at q0.95 (the canvas
/// clamp encode on the app side); if one side ever moves, move both and
/// rewrite this chain.
///
/// Cost (D17): scan output ≈ input JPEG size, so quality bumps grow the
/// embedded page (and thus the PDF) modestly — an accepted trade for
/// text fidelity, not a silent regression.
///
/// Chroma: the `image` crate's JPEG encoder is fixed 4:4:4 (no chroma
/// subsampling — all components are encoded with 1×1 sampling factors,
/// one 8×8 block each per MCU), which is exactly what text wants; there
/// is no subsampling knob to turn. The browser-side capture JPEG is
/// typically 4:2:0 (capture-side fact, not controllable here).
pub const SCAN_JPEG_QUALITY: u8 = 95;

/// Output dimensions from quad geometry: the quad's NATIVE mean edge
/// lengths, capped at `max_long_edge`. The cap only ever shrinks: a
/// quad whose long edge is under the cap (small crops, low-res captures)
/// keeps its native pixel count exactly — no downscale toward the cap,
/// no upscale (scale ≤ 1 relative to quad size).
pub fn output_dims(quad: &Quad, max_long_edge: u32) -> (u32, u32) {
    let (mw, mh) = quad.mean_size();
    let longest = mw.max(mh).max(1.0);
    let scale = (f64::from(max_long_edge) / longest).min(1.0);
    (
        (mw * scale).round().max(1.0) as u32,
        (mh * scale).round().max(1.0) as u32,
    )
}

/// Warps `quad` (in `w×h` RGB pixels) to a `out_w×out_h` RGB rectangle.
/// Pixels sampling outside the source fill white (document assumption).
pub fn warp_quad(
    rgb: &[u8],
    w: u32,
    h: u32,
    quad: &Quad,
    out_w: u32,
    out_h: u32,
) -> Result<Vec<u8>, ScanError> {
    if rgb.len() != w as usize * h as usize * 3 || out_w == 0 || out_h == 0 {
        return Err(ScanError::new(
            ScanErrorKind::InvalidInput,
            "warp input dimensions do not match the buffer",
        ));
    }
    let fwd = homography(quad, f64::from(out_w), f64::from(out_h))?;
    let inv = invert_homography(&fwd)?;
    let mut out = vec![255u8; out_w as usize * out_h as usize * 3];
    for y in 0..out_h {
        for x in 0..out_w {
            // Sample at pixel centers, matching the corner convention
            // (corners map to rectangle corners, not edges).
            let src = apply_homography(&inv, Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5));
            let (r, g, b) = bilinear(rgb, w, h, src.x - 0.5, src.y - 0.5);
            let o = (y as usize * out_w as usize + x as usize) * 3;
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
        }
    }
    Ok(out)
}

/// Bilinear sample in pixel-index space; outside → white.
fn bilinear(rgb: &[u8], w: u32, h: u32, x: f64, y: f64) -> (u8, u8, u8) {
    let (w, h) = (w as i64, h as i64);
    let x0 = x.floor() as i64;
    let y0 = y.floor() as i64;
    let (fx, fy) = (x - x0 as f64, y - y0 as f64);
    let mut acc = [0.0f64; 3];
    for (dy, wy) in [(0, 1.0 - fy), (1, fy)] {
        for (dx, wx) in [(0, 1.0 - fx), (1, fx)] {
            let (sx, sy) = (x0 + dx, y0 + dy);
            let weight = wx * wy;
            if sx < 0 || sy < 0 || sx >= w || sy >= h {
                for c in &mut acc {
                    *c += 255.0 * weight;
                }
            } else {
                let o = (sy as usize * w as usize + sx as usize) * 3;
                for (c, v) in acc.iter_mut().zip(&rgb[o..o + 3]) {
                    *c += f64::from(*v) * weight;
                }
            }
        }
    }
    (
        acc[0].round().clamp(0.0, 255.0) as u8,
        acc[1].round().clamp(0.0, 255.0) as u8,
        acc[2].round().clamp(0.0, 255.0) as u8,
    )
}

/// Encodes RGB pixels as JPEG.
pub fn encode_jpeg(rgb: &[u8], w: u32, h: u32, quality: u8) -> Result<Vec<u8>, ScanError> {
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, quality)
        .write_image(rgb, w, h, image::ExtendedColorType::Rgb8)
        .map_err(|err| {
            ScanError::new(ScanErrorKind::EncodeFailed, "scan JPEG encode failed")
                .with_details(err.to_string())
        })?;
    Ok(bytes)
}

/// Warps a quad and encodes the result as JPEG in one step.
pub fn warp_to_jpeg(
    rgb: &[u8],
    w: u32,
    h: u32,
    quad: &Quad,
    max_long_edge: u32,
) -> Result<(Vec<u8>, u32, u32), ScanError> {
    let (out_w, out_h) = output_dims(quad, max_long_edge);
    let warped = warp_quad(rgb, w, h, quad, out_w, out_h)?;
    let jpeg = encode_jpeg(&warped, out_w, out_h, SCAN_JPEG_QUALITY)?;
    Ok((jpeg, out_w, out_h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Point;

    fn solid(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
        let mut v = Vec::with_capacity(w as usize * h as usize * 3);
        for _ in 0..w * h {
            v.extend_from_slice(&rgb);
        }
        v
    }

    /// Paints a solid rectangle into an RGB buffer (bounds-clipped).
    fn bar(rgb: &mut [u8], w: u32, h: u32, rect: [u32; 4], v: u8) {
        let [x0, y0, bw, bh] = rect;
        for y in y0..(y0 + bh).min(h) {
            for x in x0..(x0 + bw).min(w) {
                let o = (y as usize * w as usize + x as usize) * 3;
                rgb[o] = v;
                rgb[o + 1] = v;
                rgb[o + 2] = v;
            }
        }
    }

    /// Text-ish fixture: dense crisp glyph-block stems on white — the
    /// DCT stress case behind the quality bump (the two-generation chain
    /// compounds ringing on 2–5 px stems, i.e. type at reading size).
    fn textish(w: u32, h: u32) -> Vec<u8> {
        let mut rgb = vec![255u8; w as usize * h as usize * 3];
        for (row, ly) in (20..h.saturating_sub(40)).step_by(44).enumerate() {
            let mut x = 16;
            let mut cell = 0usize;
            while x + 24 < w {
                let stem = 3 + (x + ly) % 3;
                bar(&mut rgb, w, h, [x, ly, stem, 26], 20);
                bar(&mut rgb, w, h, [x, ly + 11, 16, 3], 20);
                if (cell + row).is_multiple_of(3) {
                    bar(&mut rgb, w, h, [x + 12, ly + 4, stem, 22], 20);
                }
                x += 22;
                cell += 1;
            }
        }
        rgb
    }

    #[test]
    fn identity_quad_reproduces_pixels() {
        let rgb = solid(16, 12, [11, 200, 30]);
        let q = Quad::new(
            Point::new(0.0, 0.0),
            Point::new(16.0, 0.0),
            Point::new(16.0, 12.0),
            Point::new(0.0, 12.0),
        );
        let out = warp_quad(&rgb, 16, 12, &q, 16, 12).expect("warps");
        assert_eq!(out, rgb);
    }

    #[test]
    fn trapezoid_warps_to_full_white_rect() {
        // White trapezoid on black, painted exactly: warp must yield an
        // all-white rect (modulo bilinear fringe on the boundary).
        let (w, h) = (200, 200);
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        let q = Quad::new(
            Point::new(60.0, 40.0),
            Point::new(140.0, 40.0),
            Point::new(170.0, 170.0),
            Point::new(30.0, 170.0),
        );
        let c = q.corners();
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x), f64::from(y));
                let mut sign = 0.0;
                let mut inside = true;
                for i in 0..4 {
                    let a = c[i];
                    let b = c[(i + 1) % 4];
                    let cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
                    if cross.abs() < 1e-9 {
                        continue;
                    }
                    if sign == 0.0 {
                        sign = cross.signum();
                    } else if cross.signum() != sign {
                        inside = false;
                        break;
                    }
                }
                if inside {
                    let o = (y as usize * w as usize + x as usize) * 3;
                    rgb[o] = 255;
                    rgb[o + 1] = 255;
                    rgb[o + 2] = 255;
                }
            }
        }
        let (out_w, out_h) = output_dims(&q, 3600);
        let out = warp_quad(&rgb, w, h, &q, out_w, out_h).expect("warps");
        assert!(out_w > 50 && out_h > 80, "{out_w}x{out_h}");
        let white = out
            .chunks_exact(3)
            .filter(|px| px[0] > 250 && px[1] > 250 && px[2] > 250)
            .count();
        let total = out.len() / 3;
        assert!(
            white as f64 / total as f64 > 0.93,
            "white fraction {}",
            white as f64 / total as f64
        );
    }

    #[test]
    fn output_dims_derive_from_geometry_and_cap() {
        let q = Quad::new(
            Point::new(0.0, 0.0),
            Point::new(4000.0, 0.0),
            Point::new(4000.0, 3000.0),
            Point::new(0.0, 3000.0),
        );
        assert_eq!(output_dims(&q, 3600), (3600, 2700));
        // 3600px capture clamp (app side): a full-frame quad now warps at
        // its NATIVE captured size — cap == clamp, so pixels captured at
        // full resolution are never downscaled a second time.
        let full = Quad::new(
            Point::new(0.0, 0.0),
            Point::new(3600.0, 0.0),
            Point::new(3600.0, 2700.0),
            Point::new(0.0, 2700.0),
        );
        assert_eq!(output_dims(&full, 3600), (3600, 2700));
        let small = Quad::new(
            Point::new(0.0, 0.0),
            Point::new(200.0, 0.0),
            Point::new(200.0, 100.0),
            Point::new(0.0, 100.0),
        );
        // No upscale: small quads keep native size.
        assert_eq!(output_dims(&small, 3600), (200, 100));
    }

    #[test]
    fn small_crop_keeps_native_resolution_under_cap() {
        // Crop-review pin: an 800×1000 region of a 3600px capture must
        // come out at the region's OWN pixel count — no downscale toward
        // the cap (that is what mushed small crops' text), no fake
        // upscale. The 3600 cap only ever shrinks regions whose native
        // long edge exceeds it.
        let (w, h) = (3600, 1800);
        let rgb = solid(w, h, [250, 250, 250]);
        let q = Quad::new(
            Point::new(500.0, 100.0),
            Point::new(1300.0, 100.0),
            Point::new(1300.0, 1100.0),
            Point::new(500.0, 1100.0),
        );
        assert_eq!(output_dims(&q, 3600), (800, 1000));
        let (jpeg, out_w, out_h) = warp_to_jpeg(&rgb, w, h, &q, 3600).expect("warps");
        assert_eq!((out_w, out_h), (800, 1000));
        let back = image::load_from_memory(&jpeg).expect("decodes");
        assert_eq!((back.width(), back.height()), (800, 1000));
    }

    #[test]
    fn integer_offset_crop_reproduces_source_pixels_exactly() {
        // Half-pixel convention pin (scale 1): output pixel (x, y) must
        // sample the source pixel at (x+10, y) EXACTLY. An off-by-half in
        // the `src ± 0.5` edge↔pixel-index convention would blend each
        // column pair and fail this.
        let (w, h) = (40, 40);
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        for y in 0..h {
            for x in 0..w {
                let o = (y as usize * w as usize + x as usize) * 3;
                rgb[o] = (x * 4) as u8;
                rgb[o + 1] = (y * 4) as u8;
                rgb[o + 2] = 200;
            }
        }
        let q = Quad::new(
            Point::new(10.0, 0.0),
            Point::new(30.0, 0.0),
            Point::new(30.0, 40.0),
            Point::new(10.0, 40.0),
        );
        let out = warp_quad(&rgb, w, h, &q, 20, 40).expect("warps");
        for y in 0..40usize {
            for x in 0..20usize {
                let o = (y * 20 + x) * 3;
                let s = (y * 40 + (x + 10)) * 3;
                assert_eq!(&out[o..o + 3], &rgb[s..s + 3], "x={x} y={y}");
            }
        }
    }

    #[test]
    fn half_pixel_offset_averages_adjacent_source_pixels() {
        // The companion pin: a quad shifted +0.5 px must land each output
        // column exactly BETWEEN two source columns (the rounded mean),
        // not on either one. Dropping (or doubling) the `src.x - 0.5`
        // correction snaps samples onto a single column and fails here.
        let (w, h) = (40, 40);
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        for y in 0..h {
            for x in 0..w {
                let o = (y as usize * w as usize + x as usize) * 3;
                rgb[o] = (x * 4) as u8;
                rgb[o + 1] = (y * 4) as u8;
                rgb[o + 2] = 200;
            }
        }
        let q = Quad::new(
            Point::new(10.5, 0.0),
            Point::new(30.5, 0.0),
            Point::new(30.5, 40.0),
            Point::new(10.5, 40.0),
        );
        let out = warp_quad(&rgb, w, h, &q, 20, 40).expect("warps");
        for y in 0..40usize {
            for x in 0..20usize {
                let o = (y * 20 + x) * 3;
                let s0 = (y * 40 + (x + 10)) * 3;
                let s1 = (y * 40 + (x + 11)) * 3;
                for c in 0..3 {
                    // Mean of two values 4 apart: always an integer, so
                    // no half-way rounding boundary to flake on.
                    let mean = ((u32::from(rgb[s0 + c]) + u32::from(rgb[s1 + c])) / 2) as u8;
                    assert_eq!(out[o + c], mean, "x={x} y={y} c={c}");
                }
            }
        }
    }

    #[test]
    fn scan_jpeg_quality_is_95_by_two_generation_policy() {
        // Policy pin: generation 2 of the JPEG chain. See the constant's
        // comment for the 95/95 rationale. Changing this must be a
        // conscious decision (and must move the capture encode with it).
        assert_eq!(SCAN_JPEG_QUALITY, 95);
    }

    #[test]
    fn quality_95_growth_over_92_is_modest_and_sharper() {
        // D17 measurement pin on a text-ish fixture: q95 bytes stay
        // close to q92 (modest PDF growth — accepted), while decoded
        // error against the source fixture drops (less DCT ringing on
        // glyph stems — the point of the bump). Sizes/errors print for
        // `cargo test -- --nocapture` reporting.
        let (w, h) = (900, 1200);
        let src = textish(w, h);
        let q92 = encode_jpeg(&src, w, h, 92).expect("encodes");
        let q95 = encode_jpeg(&src, w, h, SCAN_JPEG_QUALITY).expect("encodes");
        println!("text-ish {w}x{h}: q92={}B q95={}B", q92.len(), q95.len());
        assert!(q95.len() >= q92.len(), "q95 must not shrink below q92");
        assert!(
            q95.len() * 2 <= q92.len() * 3,
            "q95 growth must stay modest (q92={} q95={})",
            q92.len(),
            q95.len()
        );
        let mad = |jpeg: &[u8]| -> f64 {
            let back = image::load_from_memory(jpeg).expect("decodes").into_rgb8();
            let (sum, n) =
                back.pixels()
                    .zip(src.chunks_exact(3))
                    .fold((0u64, 0u64), |(sum, n), (px, s)| {
                        let d =
                            px.0.iter()
                                .zip(s)
                                .map(|(a, b)| u64::from(*a).abs_diff(u64::from(*b)))
                                .sum::<u64>();
                        (sum + d, n + 3)
                    });
            sum as f64 / n as f64
        };
        let (e92, e95) = (mad(&q92), mad(&q95));
        println!("mean abs error vs source: q92={e92:.4} q95={e95:.4}");
        assert!(
            e95 <= e92,
            "q95 must not be softer than q92 (q92={e92} q95={e95})"
        );
    }

    #[test]
    fn jpeg_round_trips_dimensions() {
        let rgb = solid(32, 24, [200, 100, 50]);
        let bytes = encode_jpeg(&rgb, 32, 24, SCAN_JPEG_QUALITY).expect("encodes");
        assert_eq!(&bytes[0..3], &[0xFF, 0xD8, 0xFF]);
        let back = image::load_from_memory(&bytes).expect("decodes");
        assert_eq!((back.width(), back.height()), (32, 24));
    }
}
