//! Perspective warp: inverse-mapped bilinear resampling of a quad to a
//! rectangle, plus JPEG encoding.
//!
//! Self-implemented (no warp-API dependency risk): homography math lives
//! in `geometry`; this module owns sampling and output sizing.

use image::codecs::jpeg::JpegEncoder;
use image::ImageEncoder;

use crate::error::{ScanError, ScanErrorKind};
use crate::geometry::{apply_homography, homography, invert_homography, Point, Quad};

/// JPEG quality for scan output (matches the capture pipeline).
pub const SCAN_JPEG_QUALITY: u8 = 92;

/// Output dimensions from quad geometry: mean edge lengths scaled so the
/// long edge respects `max_long_edge`. Never upscales beyond the source
/// region's own pixel dimensions (scale ≤ 1 relative to quad size).
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
        let (out_w, out_h) = output_dims(&q, 2500);
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
        assert_eq!(output_dims(&q, 2500), (2500, 1875));
        let small = Quad::new(
            Point::new(0.0, 0.0),
            Point::new(200.0, 0.0),
            Point::new(200.0, 100.0),
            Point::new(0.0, 100.0),
        );
        // No upscale: small quads keep native size.
        assert_eq!(output_dims(&small, 2500), (200, 100));
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
