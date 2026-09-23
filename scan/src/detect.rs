//! Document detection: Canny edges → contours → quadrilateral select.
//!
//! Operates on a downscaled copy (long edge [`DETECT_LONG_EDGE`] px) —
//! detection needs shapes, not megapixels. The returned corners are in
//! FULL-resolution coordinates (scaled back up) so the warp stage uses
//! the original pixels.
//!
//! Confidence is earned, not assumed: the fraction of sampled quad-edge
//! pixels landing on dilated edge pixels, gated by a hard support
//! threshold plus the geometric validation in `geometry`.

use image::{imageops, GrayImage, Luma};

use crate::error::{ScanError, ScanErrorKind};
use crate::geometry::{order_corners, validate_quad, Point, Quad};

/// Detection working resolution (long edge, px).
pub const DETECT_LONG_EDGE: u32 = 800;
/// Minimum edge-support fraction to accept a quad.
pub const MIN_EDGE_SUPPORT: f64 = 0.5;
/// Ramer–Douglas–Peucker epsilon as a fraction of contour perimeter.
const RDP_EPSILON_FRAC: f64 = 0.02;
/// Dilation radius (px, at detection scale) for the edge-support map.
const DILATE_RADIUS: i32 = 2;

/// A detected document: normalized corners + earned confidence 0–1.
#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub quad: Quad,
    pub confidence: f64,
}

/// Detects a document in an RGB buffer (`w*h*3` bytes). Returns `None`
/// when nothing passes validation — never an error for "not found".
/// Errors only on malformed input (empty, wrong length, absurd dims).
pub fn detect_document(rgb: &[u8], w: u32, h: u32) -> Result<Option<Detection>, ScanError> {
    let pixels = u64::from(w) * u64::from(h);
    if w == 0 || h == 0 || w > 30_000 || h > 30_000 || pixels > 100_000_000 {
        return Err(ScanError::new(
            ScanErrorKind::UnsupportedDimensions,
            "image dimensions are unsupported",
        ));
    }
    if rgb.len() != pixels as usize * 3 {
        return Err(ScanError::new(
            ScanErrorKind::InvalidInput,
            "RGB buffer length does not match dimensions",
        ));
    }

    // Downscaled working copy (grayscale).
    let scale = DETECT_LONG_EDGE as f64 / u32::max(w, h).max(1) as f64;
    let scale = scale.min(1.0);
    let sw = ((w as f64 * scale).round() as u32).max(1);
    let sh = ((h as f64 * scale).round() as u32).max(1);
    let full: image::RgbImage =
        image::RgbImage::from_raw(w, h, rgb.to_vec()).expect("length checked");
    let small_rgb = imageops::resize(&full, sw, sh, imageops::FilterType::Triangle);
    let gray = imageops::grayscale(&small_rgb);
    let blurred = imageproc::filter::gaussian_blur_f32(&gray, 1.5);
    let edges = imageproc::edges::canny(&blurred, 40.0, 120.0);
    let support_map = dilate(&edges, DILATE_RADIUS);

    let mut best: Option<Detection> = None;
    for contour in imageproc::contours::find_contours::<u32>(&edges) {
        if contour.points.len() < 20 {
            continue;
        }
        let pts: Vec<Point> = contour
            .points
            .iter()
            .map(|p| Point::new(f64::from(p.x), f64::from(p.y)))
            .collect();
        let perimeter = poly_perimeter(&pts);
        if perimeter < 50.0 {
            continue;
        }
        let Some(corners) = approx_closed_quad(&pts, RDP_EPSILON_FRAC * perimeter) else {
            continue;
        };
        let quad = match order_corners(corners) {
            Ok(q) => q,
            Err(_) => continue,
        };
        if validate_quad(&quad, f64::from(sw), f64::from(sh)).is_err() {
            continue;
        }
        let support = edge_support(&quad, &support_map);
        if support < MIN_EDGE_SUPPORT {
            continue;
        }
        let better = best
            .as_ref()
            .map(|b: &Detection| support > b.confidence)
            .unwrap_or(true);
        if better {
            best = Some(Detection {
                quad,
                confidence: support,
            });
        }
    }

    // Scale corners back to full resolution.
    Ok(best.map(|d| {
        let up = |p: Point| Point::new(p.x / scale, p.y / scale);
        let quad = Quad::new(up(d.quad.tl), up(d.quad.tr), up(d.quad.br), up(d.quad.bl));
        Detection {
            quad,
            confidence: d.confidence,
        }
    }))
}

/// Perimeter of an open point loop (closed implicitly).
fn poly_perimeter(pts: &[Point]) -> f64 {
    if pts.len() < 2 {
        return 0.0;
    }
    let mut sum = 0.0;
    for i in 0..pts.len() {
        sum += pts[i].dist(&pts[(i + 1) % pts.len()]);
    }
    sum
}

/// Ramer–Douglas–Peucker polyline simplification (open polyline).
fn rdp(pts: &[Point], epsilon: f64) -> Vec<Point> {
    if pts.len() <= 2 {
        return pts.to_vec();
    }
    // Farthest point from the chord first→last.
    let (a, b) = (pts[0], pts[pts.len() - 1]);
    let (mut idx, mut dist) = (0usize, 0.0f64);
    for (i, p) in pts
        .iter()
        .enumerate()
        .skip(1)
        .take(pts.len().saturating_sub(2))
    {
        let d = point_line_dist(p, &a, &b);
        if d > dist {
            dist = d;
            idx = i;
        }
    }
    if dist > epsilon {
        let mut left = rdp(&pts[..=idx], epsilon);
        let right = rdp(&pts[idx..], epsilon);
        left.pop();
        left.extend_from_slice(&right);
        left
    } else {
        vec![a, b]
    }
}

/// Approximates a CLOSED contour loop as a quadrilateral.
///
/// Border-following starts at an arbitrary loop point, so plain RDP
/// keeps that point as a spurious 5th vertex. Rotating the loop to
/// start at the point farthest from the centroid (a corner for convex
/// quads) makes the open-polyline RDP converge to exactly 4 points;
/// anything else is not a clean quad.
fn approx_closed_quad(pts: &[Point], epsilon: f64) -> Option<[Point; 4]> {
    if pts.len() < 4 {
        return None;
    }
    let n = pts.len() as f64;
    let (cx, cy) = (
        pts.iter().map(|p| p.x).sum::<f64>() / n,
        pts.iter().map(|p| p.y).sum::<f64>() / n,
    );
    let center = Point::new(cx, cy);
    let start = pts
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| {
            a.dist(&center)
                .partial_cmp(&b.dist(&center))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(i, _)| i)?;
    let mut looped = Vec::with_capacity(pts.len() + 1);
    looped.extend_from_slice(&pts[start..]);
    looped.extend_from_slice(&pts[..start]);
    looped.push(pts[start]);
    let approx = rdp(&looped, epsilon);
    // Drop the closing duplicate; require exactly the 4 corners.
    let mut clean: Vec<Point> = approx;
    if clean.len() >= 2 && clean[0].dist(&clean[clean.len() - 1]) < epsilon.max(2.0) {
        clean.pop();
    }
    if clean.len() != 4 {
        return None;
    }
    Some([clean[0], clean[1], clean[2], clean[3]])
}

fn point_line_dist(p: &Point, a: &Point, b: &Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len = dx.hypot(dy);
    if len < 1e-12 {
        return p.dist(a);
    }
    // Parentheses matter: method calls bind tighter than unary minus,
    // so (-dx).mul_add(...) must be explicit.
    ((dy).mul_add(p.x, (-dx).mul_add(p.y, b.x * a.y - b.y * a.x))).abs() / len
}

/// Binary 3×3-style dilation with a square radius (edge-support map).
fn dilate(edges: &GrayImage, radius: i32) -> GrayImage {
    let (w, h) = (edges.width() as i32, edges.height() as i32);
    let mut out = GrayImage::new(edges.width(), edges.height());
    for y in 0..h {
        for x in 0..w {
            let mut hit = false;
            'win: for dy in -radius..=radius {
                for dx in -radius..=radius {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx >= 0
                        && ny >= 0
                        && nx < w
                        && ny < h
                        && edges.get_pixel(nx as u32, ny as u32).0[0] > 0
                    {
                        hit = true;
                        break 'win;
                    }
                }
            }
            if hit {
                out.put_pixel(x as u32, y as u32, Luma([255u8]));
            }
        }
    }
    out
}

/// Fraction of sampled quad-perimeter pixels landing on dilated edges.
fn edge_support(quad: &Quad, support_map: &GrayImage) -> f64 {
    let c = quad.corners();
    let mut hits = 0u32;
    let mut total = 0u32;
    for i in 0..4 {
        let (a, b) = (c[i], c[(i + 1) % 4]);
        let len = a.dist(&b);
        let steps = (len / 4.0).ceil().max(1.0) as u32;
        for s in 0..=steps {
            let t = f64::from(s) / f64::from(steps);
            let x = (a.x + (b.x - a.x) * t).round() as i32;
            let y = (a.y + (b.y - a.y) * t).round() as i32;
            if x >= 0 && y >= 0 && x < support_map.width() as i32 && y < support_map.height() as i32
            {
                total += 1;
                if support_map.get_pixel(x as u32, y as u32).0[0] > 0 {
                    hits += 1;
                }
            }
        }
    }
    if total == 0 {
        0.0
    } else {
        f64::from(hits) / f64::from(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Renders a solid white convex quad on a black canvas (RGB).
    fn quad_fixture(w: u32, h: u32, q: &Quad) -> Vec<u8> {
        let mut img = vec![0u8; w as usize * h as usize * 3];
        // Scanline fill via winding test against the ordered corners.
        let c = q.corners();
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x), f64::from(y));
                if point_in_convex(&p, &c) {
                    let o = (y as usize * w as usize + x as usize) * 3;
                    img[o] = 255;
                    img[o + 1] = 255;
                    img[o + 2] = 255;
                }
            }
        }
        img
    }

    fn point_in_convex(p: &Point, c: &[Point; 4]) -> bool {
        let mut sign = 0.0;
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
                return false;
            }
        }
        true
    }

    #[test]
    fn detects_axis_aligned_document() {
        let q = Quad::new(
            Point::new(100.0, 120.0),
            Point::new(540.0, 120.0),
            Point::new(540.0, 680.0),
            Point::new(100.0, 680.0),
        );
        let rgb = quad_fixture(640, 800, &q);
        let d = detect_document(&rgb, 640, 800)
            .expect("runs")
            .expect("detects");
        assert!(d.confidence >= MIN_EDGE_SUPPORT, "{}", d.confidence);
        for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
            assert!(got.dist(want) < 12.0, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn detects_perspective_document() {
        let q = Quad::new(
            Point::new(120.0, 90.0),
            Point::new(520.0, 130.0),
            Point::new(470.0, 700.0),
            Point::new(80.0, 660.0),
        );
        let rgb = quad_fixture(640, 800, &q);
        let d = detect_document(&rgb, 640, 800)
            .expect("runs")
            .expect("detects");
        assert!(d.confidence >= MIN_EDGE_SUPPORT, "{}", d.confidence);
        for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
            assert!(got.dist(want) < 16.0, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn blank_and_tiny_inputs_yield_none() {
        let blank = vec![0u8; 320 * 240 * 3];
        assert!(detect_document(&blank, 320, 240).expect("runs").is_none());
        // Tiny white square: below the 5% area gate.
        let mut tiny = vec![0u8; 400 * 400 * 3];
        for y in 180..220 {
            for x in 180..220 {
                let o = (y * 400 + x) * 3;
                tiny[o] = 255;
                tiny[o + 1] = 255;
                tiny[o + 2] = 255;
            }
        }
        assert!(detect_document(&tiny, 400, 400).expect("runs").is_none());
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(detect_document(&[], 0, 0).is_err());
        assert!(detect_document(&[1, 2, 3], 10, 10).is_err());
    }

    #[test]
    fn closed_quad_approx_converges_on_rectangle_loop() {
        // Regression: method-call precedence once broke point_line_dist
        // (`-(x).mul_add` parses as `-(x.mul_add)`), starving RDP.
        let mut loop_pts = Vec::new();
        for x in 0..440 {
            loop_pts.push(Point::new(100.0 + x as f64, 120.0));
        }
        for y in 0..560 {
            loop_pts.push(Point::new(540.0, 120.0 + y as f64));
        }
        for x in (0..440).rev() {
            loop_pts.push(Point::new(100.0 + x as f64, 680.0));
        }
        for y in (0..560).rev() {
            loop_pts.push(Point::new(100.0, 120.0 + y as f64));
        }
        let approx = approx_closed_quad(&loop_pts, 40.0).expect("rectangle loop converges");
        let quad = order_corners(approx).expect("orders");
        assert!(validate_quad(&quad, 640.0, 800.0).is_ok());
    }
}
