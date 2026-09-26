//! Document detection: Canny edges → contours → quadrilateral select.
//!
//! Operates on a downscaled copy (long edge [`DETECT_LONG_EDGE`] px) —
//! detection needs shapes, not megapixels. The downscale reads the
//! caller's RGB bytes through a borrowed view: no full-resolution copy
//! is materialized. The returned corners are in FULL-resolution
//! coordinates (scaled back up) so the warp stage uses the original
//! pixels.
//!
//! Confidence is earned, not assumed: the fraction of sampled quad-edge
//! pixels landing on dilated edge pixels, gated by a hard support
//! threshold plus the geometric validation in `geometry`.

use image::flat::{FlatSamples, SampleLayout};
use image::{imageops, GrayImage, Luma, Rgb};

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
/// Only the largest N contours (by area) are fitted — text and texture
/// produce thousands of tiny loops that can never be documents.
const MAX_CONTOUR_CANDIDATES: usize = 8;
/// Contours below this frame-area fraction are skipped before fitting.
const MIN_CONTOUR_AREA_FRAC: f64 = 0.015;
/// Contours with fewer points than this are never page boundaries.
const MIN_CONTOUR_POINTS: usize = 20;
/// Closed loops with a shorter perimeter (px) are noise, not page edges.
const MIN_CONTOUR_PERIMETER: f64 = 50.0;

/// A detected document: normalized corners + earned confidence 0–1.
#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub quad: Quad,
    pub confidence: f64,
}

/// Describes raw RGB bytes (`w*h*3`) as a flat sample buffer. Callers
/// view it without copying.
fn rgb_samples(rgb: &[u8], w: u32, h: u32) -> FlatSamples<&[u8]> {
    FlatSamples {
        samples: rgb,
        layout: SampleLayout::row_major_packed(3, w, h),
        color_hint: Some(image::ColorType::Rgb8),
    }
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

    // Downscaled working copy (grayscale). The RGB bytes are borrowed as
    // an image view — `resize` reads straight from the caller's buffer,
    // so no full-resolution `RgbImage` copy is materialized.
    let scale = DETECT_LONG_EDGE as f64 / u32::max(w, h).max(1) as f64;
    let scale = scale.min(1.0);
    let sw = ((w as f64 * scale).round() as u32).max(1);
    let sh = ((h as f64 * scale).round() as u32).max(1);
    let flat = rgb_samples(rgb, w, h);
    let view = flat
        .as_view::<Rgb<u8>>()
        .expect("RGB buffer length checked above");
    let small_rgb = imageops::resize(&view, sw, sh, imageops::FilterType::Triangle);
    let gray = imageops::grayscale(&small_rgb);
    let blurred = imageproc::filter::gaussian_blur_f32(&gray, 1.5);
    // Otsu binarization: adapts to the photo's own lighting instead of
    // assuming lab-grade contrast. Dark indoor shots get a threshold
    // near their own bimodal valley; bright shots behave as before.
    let binary = otsu_threshold(&blurred);
    // Morphological closing bridges 1–2px gaps (shadow breaks, weak
    // edge segments) so the page boundary forms closed loops.
    let closed = morph_close(&binary, 2);
    let edges = imageproc::edges::canny(&closed, 40.0, 120.0);
    let support_map = dilate(&edges, DILATE_RADIUS);

    // Largest contours first: the document is usually among the biggest
    // shapes; text/texture loops are rejected by area before fitting.
    // Cheap prefilter during iteration (point count + bounding extent)
    // keeps thousands of tiny texture loops from ever being materialized
    // as f64 point vectors; the exact perimeter gate below is unchanged.
    let frame_area = f64::from(sw) * f64::from(sh);
    let mut contours: Vec<Vec<Point>> = imageproc::contours::find_contours::<u32>(&edges)
        .iter()
        .filter(|c| {
            c.points.len() >= MIN_CONTOUR_POINTS
                && 2.0 * f64::from(contour_extent(&c.points)) >= MIN_CONTOUR_PERIMETER
        })
        .map(|c| {
            c.points
                .iter()
                .map(|p| Point::new(f64::from(p.x), f64::from(p.y)))
                .collect::<Vec<_>>()
        })
        .filter(|pts| poly_perimeter(pts) >= MIN_CONTOUR_PERIMETER)
        .collect();
    contours.sort_by(|a, b| {
        poly_area(b)
            .partial_cmp(&poly_area(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    contours.truncate(MAX_CONTOUR_CANDIDATES);

    // Collect passing quads (area-ordered): the winner below is the
    // largest, with pairwise spread-merge attempted before accepting.
    let mut candidates: Vec<(Quad, f64)> = Vec::new();
    for pts in &contours {
        if poly_area(pts) / frame_area < MIN_CONTOUR_AREA_FRAC {
            continue;
        }
        let perimeter = poly_perimeter(pts);
        let Some(corners) = approx_closed_quad(pts, RDP_EPSILON_FRAC * perimeter) else {
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
        candidates.push((quad, support));
        if candidates.len() >= 4 {
            break;
        }
    }
    let Some((winner, _)) = candidates.first() else {
        return Ok(None);
    };
    let winner = *winner;
    // Open-spread merge: two side-by-side halves (split by a spine/fold)
    // reunite into the outer boundary when their facing edges align.
    // The merged quad re-passes validation + support, so single pages
    // and unrelated neighbors are unaffected.
    for (other, _) in candidates.iter().skip(1) {
        if let Some(merged) = try_merge_horizontal(&winner, other) {
            if validate_quad(&merged, f64::from(sw), f64::from(sh)).is_ok() {
                let support = edge_support(&merged, &support_map);
                if support >= MIN_EDGE_SUPPORT {
                    let up = |p: Point| Point::new(p.x / scale, p.y / scale);
                    let full =
                        Quad::new(up(merged.tl), up(merged.tr), up(merged.br), up(merged.bl));
                    return Ok(Some(Detection {
                        quad: full,
                        confidence: support,
                    }));
                }
            }
        }
    }
    // No merge: the largest passing quad wins (industry-standard).
    let up = |p: Point| Point::new(p.x / scale, p.y / scale);
    let full = Quad::new(up(winner.tl), up(winner.tr), up(winner.br), up(winner.bl));
    let support = edge_support(&winner, &support_map);
    Ok(Some(Detection {
        quad: full,
        confidence: support,
    }))
}

/// Attempts to merge two side-by-side quads (open-spread halves split
/// by a spine/fold) into their outer boundary.
///
/// The left quad's right edge and the right quad's left edge must be
/// near-vertical, close in x (gap ≤ 15% of the narrower width), and
/// overlap in y by ≥ 70% of the shorter edge. Returns the merged quad
/// in normalized corner order; validation + support happen in the
/// caller, so unrelated neighbors cannot sneak through.
fn try_merge_horizontal(a: &Quad, b: &Quad) -> Option<Quad> {
    let (left, right) = if (a.tl.x + a.bl.x) / 2.0 <= (b.tl.x + b.bl.x) / 2.0 {
        (a, b)
    } else {
        (b, a)
    };
    let left_x = (left.tr.x + left.br.x) / 2.0;
    let right_x = (right.tl.x + right.bl.x) / 2.0;
    let gap = right_x - left_x;
    let left_w = (left.tr.x - left.tl.x)
        .abs()
        .max((left.br.x - left.bl.x).abs());
    let right_w = (right.tr.x - right.tl.x)
        .abs()
        .max((right.br.x - right.bl.x).abs());
    if gap < 0.0 || gap > 0.15 * left_w.min(right_w).max(1.0) {
        return None;
    }
    // Vertical overlap of the two facing edges.
    let l_top = left.tr.y.min(left.br.y);
    let l_bot = left.tr.y.max(left.br.y);
    let r_top = right.tl.y.min(right.bl.y);
    let r_bot = right.tl.y.max(right.bl.y);
    let overlap_len = l_bot.min(r_bot) - l_top.max(r_top);
    let min_edge = (l_bot - l_top).min(r_bot - r_top).max(1.0);
    if overlap_len < 0.7 * min_edge {
        return None;
    }
    let corners = [left.tl, left.bl, right.tr, right.br];
    order_corners(corners).ok()
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

/// Absolute polygon area (shoelace). Used to order contours largest-first.
fn poly_area(pts: &[Point]) -> f64 {
    if pts.len() < 3 {
        return 0.0;
    }
    let mut sum = 0.0;
    for i in 0..pts.len() {
        let a = pts[i];
        let b = pts[(i + 1) % pts.len()];
        sum += a.x * b.y - b.x * a.y;
    }
    sum.abs() / 2.0
}

/// Bounding-box extent (px) of a raw contour: `max(width, height)`.
///
/// A closed loop's perimeter is at least twice its bounding-box extent,
/// so this is a cheap necessary condition for [`MIN_CONTOUR_PERIMETER`]:
/// tiny loops are dropped before any `f64` points are allocated.
fn contour_extent(pts: &[imageproc::point::Point<u32>]) -> u32 {
    if pts.is_empty() {
        return 0;
    }
    let (mut min_x, mut min_y) = (u32::MAX, u32::MAX);
    let (mut max_x, mut max_y) = (0u32, 0u32);
    for p in pts {
        min_x = min_x.min(p.x);
        min_y = min_y.min(p.y);
        max_x = max_x.max(p.x);
        max_y = max_y.max(p.y);
    }
    (max_x - min_x).max(max_y - min_y)
}

/// Otsu's threshold: the gray level maximizing between-class variance.
/// Adapts to each photo's lighting (dark rooms, shade, bright desks).
fn otsu_threshold(gray: &GrayImage) -> GrayImage {
    let mut hist = [0u64; 256];
    for px in gray.pixels() {
        hist[px.0[0] as usize] += 1;
    }
    let total = (gray.width() as u64) * (gray.height() as u64);
    if total == 0 {
        return gray.clone();
    }
    let mut sum_all = 0u64;
    for (i, h) in hist.iter().enumerate() {
        sum_all += i as u64 * h;
    }
    let mut sum_bg = 0u64;
    let mut weight_bg = 0u64;
    let mut best_var = -1.0f64;
    let mut threshold = 128u8;
    for (t, h) in hist.iter().enumerate() {
        weight_bg += h;
        if weight_bg == 0 || weight_bg == total {
            continue;
        }
        sum_bg += t as u64 * h;
        let weight_fg = total - weight_bg;
        let mean_bg = sum_bg as f64 / weight_bg as f64;
        let mean_fg = (sum_all - sum_bg) as f64 / weight_fg as f64;
        let var = weight_bg as f64 * weight_fg as f64 * (mean_bg - mean_fg).powi(2);
        if var > best_var {
            best_var = var;
            threshold = t as u8;
        }
    }
    let mut out = GrayImage::new(gray.width(), gray.height());
    for (x, y, px) in out.enumerate_pixels_mut() {
        let v = gray.get_pixel(x, y).0[0];
        *px = Luma([if v > threshold { 255u8 } else { 0u8 }]);
    }
    out
}

/// Binary erosion with a square radius (companion to [`dilate`]).
fn erode(binary: &GrayImage, radius: i32) -> GrayImage {
    let (w, h) = (binary.width() as i32, binary.height() as i32);
    let mut out = GrayImage::new(binary.width(), binary.height());
    for y in 0..h {
        for x in 0..w {
            let mut all = true;
            'win: for dy in -radius..=radius {
                for dx in -radius..=radius {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || ny < 0 || nx >= w || ny >= h {
                        continue;
                    }
                    if binary.get_pixel(nx as u32, ny as u32).0[0] == 0 {
                        all = false;
                        break 'win;
                    }
                }
            }
            if all {
                out.put_pixel(x as u32, y as u32, Luma([255u8]));
            }
        }
    }
    out
}

/// Morphological closing (dilate then erode): bridges small gaps in
/// boundaries without fattening shapes overall.
fn morph_close(binary: &GrayImage, radius: i32) -> GrayImage {
    erode(&dilate(binary, radius), radius)
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
    fn detects_dark_photo_with_shadow_gradient() {
        // Night/desk-lamp photo: dim page on a dark background with a
        // diagonal light falloff plus sensor noise. Fixed thresholds
        // go blind here; Otsu must adapt.
        let q = Quad::new(
            Point::new(140.0, 110.0),
            Point::new(500.0, 150.0),
            Point::new(460.0, 690.0),
            Point::new(100.0, 650.0),
        );
        let mut img = vec![0u8; 640 * 800 * 3];
        let c = q.corners();
        // Deterministic pseudo-noise (no rand dependency in tests).
        let noise = |x: u32, y: u32| ((x * 7919 + y * 104729) % 23) as u8;
        for y in 0..800u32 {
            for x in 0..640u32 {
                // Diagonal falloff: bright top-left, near-black bottom-right.
                let falloff = 46u8.saturating_sub(((x + y) / 48) as u8);
                let n = noise(x, y);
                let o = (y as usize * 640 + x as usize) * 3;
                img[o] = falloff.saturating_add(n / 4);
                img[o + 1] = falloff.saturating_add(n / 4);
                img[o + 2] = falloff.saturating_add(n / 4);
            }
        }
        for y in 0..800u32 {
            for x in 0..640u32 {
                let p = Point::new(f64::from(x), f64::from(y));
                if point_in_convex(&p, &c) {
                    let falloff = 150u8.saturating_sub(((x + y) / 48) as u8);
                    let n = noise(x, y);
                    let o = (y as usize * 640 + x as usize) * 3;
                    img[o] = falloff.saturating_add(n / 3);
                    img[o + 1] = falloff.saturating_add(n / 3);
                    img[o + 2] = falloff.saturating_add(n / 3);
                }
            }
        }
        let d = detect_document(&img, 640, 800)
            .expect("runs")
            .expect("detects dark photo");
        assert!(d.confidence >= MIN_EDGE_SUPPORT, "{}", d.confidence);
        for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
            assert!(got.dist(want) < 24.0, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn detects_page_on_textured_background() {
        // Cluttered desk: high-frequency texture everywhere plus a dark
        // notebook slab beside the page. The page must win over texture.
        let q = Quad::new(
            Point::new(150.0, 120.0),
            Point::new(470.0, 140.0),
            Point::new(450.0, 670.0),
            Point::new(130.0, 650.0),
        );
        let mut img = vec![0u8; 640 * 800 * 3];
        let c = q.corners();
        for y in 0..800u32 {
            for x in 0..640u32 {
                // Coarse checker texture (bedsheet-like clutter).
                let check = ((x / 24 + y / 24) % 2) * 26;
                let n = ((x * 7919 + y * 104729) % 17) as u8;
                let o = (y as usize * 640 + x as usize) * 3;
                // Dark slab on the right (notebook cover).
                let slab = if x > 500 { 12u8 } else { 0 };
                img[o] = 34 + check as u8 + n / 3 - slab.min(34 + check as u8 + n / 3);
                img[o + 1] = 30 + check as u8 + n / 3 - slab.min(30 + check as u8 + n / 3);
                img[o + 2] = 28 + check as u8 + n / 3 - slab.min(28 + check as u8 + n / 3);
            }
        }
        for y in 0..800u32 {
            for x in 0..640u32 {
                let p = Point::new(f64::from(x), f64::from(y));
                if point_in_convex(&p, &c) {
                    let o = (y as usize * 640 + x as usize) * 3;
                    img[o] = 232;
                    img[o + 1] = 230;
                    img[o + 2] = 226;
                }
            }
        }
        let d = detect_document(&img, 640, 800)
            .expect("runs")
            .expect("detects on texture");
        for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
            assert!(got.dist(want) < 24.0, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn detects_open_notebook_with_spine() {
        // Open notebook: a dark spine bar splits the spread. The OUTER
        // boundary must still win over the two half-page loops.
        let outer = Quad::new(
            Point::new(90.0, 130.0),
            Point::new(550.0, 130.0),
            Point::new(550.0, 670.0),
            Point::new(90.0, 670.0),
        );
        let mut img = vec![0u8; 640 * 800 * 3];
        for px in img.chunks_exact_mut(3) {
            px[0] = 30;
            px[1] = 28;
            px[2] = 26;
        }
        let c = outer.corners();
        for y in 0..800u32 {
            for x in 0..640u32 {
                let p = Point::new(f64::from(x), f64::from(y));
                if point_in_convex(&p, &c) {
                    let spine = (312..328).contains(&x);
                    let v = if spine { 40u8 } else { 235u8 };
                    let o = (y as usize * 640 + x as usize) * 3;
                    img[o] = v;
                    img[o + 1] = v.saturating_sub(2);
                    img[o + 2] = v.saturating_sub(6);
                }
            }
        }
        let d = detect_document(&img, 640, 800)
            .expect("runs")
            .expect("detects spread");
        // Outer spread found (not one of the halves): full width expected.
        let w = d.quad.tr.dist(&d.quad.tl);
        assert!(w > 380.0, "got half page instead of spread: {w}");
        for (got, want) in d.quad.corners().iter().zip(outer.corners().iter()) {
            assert!(got.dist(want) < 24.0, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn detects_rotated_low_contrast_page() {
        // Rotated ~20° page, modest contrast (indoor light, gray desk).
        let q = Quad::new(
            Point::new(180.0, 90.0),
            Point::new(520.0, 210.0),
            Point::new(440.0, 700.0),
            Point::new(100.0, 580.0),
        );
        let mut img = vec![0u8; 640 * 800 * 3];
        for px in img.chunks_exact_mut(3) {
            px[0] = 150;
            px[1] = 148;
            px[2] = 146;
        }
        let c = q.corners();
        for y in 0..800u32 {
            for x in 0..640u32 {
                let p = Point::new(f64::from(x), f64::from(y));
                if point_in_convex(&p, &c) {
                    let o = (y as usize * 640 + x as usize) * 3;
                    img[o] = 198;
                    img[o + 1] = 196;
                    img[o + 2] = 192;
                }
            }
        }
        let d = detect_document(&img, 640, 800)
            .expect("runs")
            .expect("detects low contrast");
        for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
            assert!(got.dist(want) < 28.0, "{got:?} vs {want:?}");
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
    fn borrowed_rgb_view_downscales_like_an_owned_image() {
        // Removing the full-resolution copy must not change a single
        // detection pixel: the borrowed FlatSamples view has to downscale
        // bit-identically to the previous owned `RgbImage` path.
        let q = Quad::new(
            Point::new(100.0, 120.0),
            Point::new(540.0, 120.0),
            Point::new(540.0, 680.0),
            Point::new(100.0, 680.0),
        );
        let rgb = quad_fixture(640, 800, &q);
        let owned = image::RgbImage::from_raw(640, 800, rgb.clone()).expect("fits");
        let from_owned = imageops::resize(&owned, 80, 100, imageops::FilterType::Triangle);
        let flat = rgb_samples(&rgb, 640, 800);
        let view = flat.as_view::<Rgb<u8>>().expect("view");
        let from_view = imageops::resize(&view, 80, 100, imageops::FilterType::Triangle);
        assert_eq!(from_view.as_raw(), from_owned.as_raw());
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(detect_document(&[], 0, 0).is_err());
        assert!(detect_document(&[1, 2, 3], 10, 10).is_err());
    }

    #[test]
    fn merge_joins_spine_split_halves() {
        let left = Quad::new(
            Point::new(90.0, 130.0),
            Point::new(311.0, 130.0),
            Point::new(311.0, 670.0),
            Point::new(90.0, 670.0),
        );
        let right = Quad::new(
            Point::new(328.0, 130.0),
            Point::new(550.0, 130.0),
            Point::new(550.0, 670.0),
            Point::new(328.0, 670.0),
        );
        let merged = try_merge_horizontal(&left, &right).expect("merges");
        assert_eq!(merged.tl, Point::new(90.0, 130.0));
        assert_eq!(merged.tr, Point::new(550.0, 130.0));
        assert_eq!(merged.br, Point::new(550.0, 670.0));
        assert_eq!(merged.bl, Point::new(90.0, 670.0));
        // Order-independent.
        assert!(try_merge_horizontal(&right, &left).is_some());
    }

    #[test]
    fn merge_rejects_wide_gaps_and_misaligned_pairs() {
        let left = Quad::new(
            Point::new(90.0, 130.0),
            Point::new(311.0, 130.0),
            Point::new(311.0, 670.0),
            Point::new(90.0, 670.0),
        );
        // Far neighbor: gap dwarfs the widths.
        let far = Quad::new(
            Point::new(500.0, 130.0),
            Point::new(620.0, 130.0),
            Point::new(620.0, 670.0),
            Point::new(500.0, 670.0),
        );
        assert!(try_merge_horizontal(&left, &far).is_none());
        // Vertically offset: facing edges barely overlap.
        let low = Quad::new(
            Point::new(328.0, 500.0),
            Point::new(550.0, 500.0),
            Point::new(550.0, 790.0),
            Point::new(328.0, 790.0),
        );
        assert!(try_merge_horizontal(&left, &low).is_none());
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
