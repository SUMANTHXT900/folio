//! Scan geometry: points, corner normalization, quad validation,
//! homography computation.
//!
//! All math is dependency-free `f64` (no linear-algebra crate): the only
//! solve is an 8×8 DLT system via Gaussian elimination with partial
//! pivoting — exact, deterministic, and small enough to own.

use crate::error::{ScanError, ScanErrorKind};

/// A 2D point in pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    #[must_use]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    #[must_use]
    pub fn dist(&self, other: &Point) -> f64 {
        (self.x - other.x).hypot(self.y - other.y)
    }
}

/// A document quadrilateral in NORMALIZED order:
///
/// ```text
/// tl ── tr
/// │      │
/// bl ── br
/// ```
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Quad {
    pub tl: Point,
    pub tr: Point,
    pub br: Point,
    pub bl: Point,
}

impl Quad {
    #[must_use]
    pub const fn new(tl: Point, tr: Point, br: Point, bl: Point) -> Self {
        Self { tl, tr, br, bl }
    }

    /// Corners in winding order (tl → tr → br → bl).
    #[must_use]
    pub fn corners(&self) -> [Point; 4] {
        [self.tl, self.tr, self.br, self.bl]
    }

    /// Signed area via the shoelace formula (absolute value used).
    #[must_use]
    pub fn area(&self) -> f64 {
        let c = self.corners();
        let mut sum = 0.0;
        for i in 0..4 {
            let a = c[i];
            let b = c[(i + 1) % 4];
            sum += a.x * b.y - b.x * a.y;
        }
        sum.abs() / 2.0
    }

    /// Mean edge lengths: (top+bottom)/2, (left+right)/2. Output page
    /// dimensions derive from these — never hard-coded.
    #[must_use]
    pub fn mean_size(&self) -> (f64, f64) {
        let w = (self.tl.dist(&self.tr) + self.bl.dist(&self.br)) / 2.0;
        let h = (self.tl.dist(&self.bl) + self.tr.dist(&self.br)) / 2.0;
        (w, h)
    }
}

/// Normalizes four unordered corner points to TL/TR/BR/BL.
///
/// Uses the sum/difference method: TL minimizes `x+y`, BR maximizes it,
/// TR maximizes `x−y`, BL minimizes it. Rejects degenerate inputs
/// (non-finite, duplicates) rather than guessing.
pub fn order_corners(points: [Point; 4]) -> Result<Quad, ScanError> {
    for (i, p) in points.iter().enumerate() {
        if !p.x.is_finite() || !p.y.is_finite() {
            return Err(ScanError::new(
                ScanErrorKind::NoDocument,
                "corner coordinates must be finite",
            )
            .with_details(format!("index={i}")));
        }
    }
    for i in 0..4 {
        for j in (i + 1)..4 {
            if (points[i].x - points[j].x).abs() < 1e-9 && (points[i].y - points[j].y).abs() < 1e-9
            {
                return Err(ScanError::new(
                    ScanErrorKind::NoDocument,
                    "duplicate corner points are degenerate",
                ));
            }
        }
    }
    let mut tl = 0;
    let mut br = 0;
    let mut tr = 0;
    let mut bl = 0;
    let mut min_sum = f64::INFINITY;
    let mut max_sum = f64::NEG_INFINITY;
    let mut max_diff = f64::NEG_INFINITY;
    let mut min_diff = f64::INFINITY;
    for (i, p) in points.iter().enumerate() {
        let sum = p.x + p.y;
        let diff = p.x - p.y;
        if sum < min_sum {
            min_sum = sum;
            tl = i;
        }
        if sum > max_sum {
            max_sum = sum;
            br = i;
        }
        if diff > max_diff {
            max_diff = diff;
            tr = i;
        }
        if diff < min_diff {
            min_diff = diff;
            bl = i;
        }
    }
    // Each role must resolve to a distinct point; ties (e.g. a perfect
    // diamond orientation where sum/diff collide) are degenerate input.
    let mut roles = [tl, tr, br, bl];
    roles.sort_unstable();
    for w in roles.windows(2) {
        if w[0] == w[1] {
            return Err(ScanError::new(
                ScanErrorKind::NoDocument,
                "corner roles are ambiguous for this point set",
            ));
        }
    }
    Ok(Quad::new(points[tl], points[tr], points[br], points[bl]))
}

/// Validates a normalized quad against image geometry. Returns the area
/// fraction (0–1) for confidence scoring.
///
/// Rejects: non-convex winding, area outside 5%–99% of the frame,
/// interior angles outside 30°–150°, zero-length edges.
pub fn validate_quad(quad: &Quad, img_w: f64, img_h: f64) -> Result<f64, ScanError> {
    if !(img_w > 0.0 && img_h > 0.0 && img_w.is_finite() && img_h.is_finite()) {
        return Err(ScanError::new(
            ScanErrorKind::UnsupportedDimensions,
            "image dimensions must be positive and finite",
        ));
    }
    let c = quad.corners();
    // Convexity: consistent cross-product sign around the winding.
    let mut sign = 0.0;
    for i in 0..4 {
        let a = c[i];
        let b = c[(i + 1) % 4];
        let d = c[(i + 2) % 4];
        let cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
        if cross.abs() < 1e-9 {
            return Err(ScanError::new(
                ScanErrorKind::NoDocument,
                "collinear consecutive corners are degenerate",
            ));
        }
        if sign == 0.0 {
            sign = cross.signum();
        } else if cross.signum() != sign {
            return Err(ScanError::new(
                ScanErrorKind::NoDocument,
                "non-convex quadrilateral is not a document",
            ));
        }
    }
    // Edge lengths + interior angles.
    for i in 0..4 {
        let a = c[i];
        let b = c[(i + 1) % 4];
        let d = c[(i + 2) % 4];
        let abx = b.x - a.x;
        let aby = b.y - a.y;
        let len = abx.hypot(aby);
        if len < 1e-9 {
            return Err(ScanError::new(
                ScanErrorKind::NoDocument,
                "zero-length quad edge is degenerate",
            ));
        }
        let bdx = d.x - b.x;
        let bdy = d.y - b.y;
        let dot = (abx * bdx + aby * bdy) / (len * bdx.hypot(bdy).max(1e-9));
        let angle = dot.clamp(-1.0, 1.0).acos().to_degrees();
        // Interior angle = 180° − turn angle.
        let interior = 180.0 - angle;
        if !(30.0..=150.0).contains(&interior) {
            return Err(ScanError::new(
                ScanErrorKind::NoDocument,
                "quad interior angle outside 30°–150°",
            )
            .with_details(format!("angle={interior:.1}")));
        }
    }
    let frac = quad.area() / (img_w * img_h);
    if !(0.05..=0.99).contains(&frac) {
        return Err(ScanError::new(
            ScanErrorKind::NoDocument,
            "quad area outside 5%–99% of the frame",
        )
        .with_details(format!("area_frac={frac:.3}")));
    }
    Ok(frac)
}

/// Computes the 3×3 homography mapping `src` quad corners to the
/// rectangle `(0,0) → (dst_w,dst_h)` (row-major `[h00..h22]`, `h22 = 1`).
/// Direct linear transform via Gaussian elimination with partial
/// pivoting; near-singular systems (degenerate quads that slipped
/// validation) fail as `WarpFailed` instead of producing garbage.
pub fn homography(src: &Quad, dst_w: f64, dst_h: f64) -> Result<[f64; 9], ScanError> {
    let dst = [
        Point::new(0.0, 0.0),
        Point::new(dst_w, 0.0),
        Point::new(dst_w, dst_h),
        Point::new(0.0, dst_h),
    ];
    let from = src.corners();
    // 8 equations, 8 unknowns (h00..h21; h22 fixed at 1).
    let mut m = [[0.0f64; 9]; 8];
    for (i, (s, d)) in from.iter().zip(dst.iter()).enumerate() {
        let r = 2 * i;
        m[r][0] = s.x;
        m[r][1] = s.y;
        m[r][2] = 1.0;
        m[r][6] = -d.x * s.x;
        m[r][7] = -d.x * s.y;
        m[r][8] = d.x;
        m[r + 1][3] = s.x;
        m[r + 1][4] = s.y;
        m[r + 1][5] = 1.0;
        m[r + 1][6] = -d.y * s.x;
        m[r + 1][7] = -d.y * s.y;
        m[r + 1][8] = d.y;
    }
    // Forward elimination with partial pivoting.
    for col in 0..8 {
        let mut pivot = col;
        for row in col..8 {
            if m[row][col].abs() > m[pivot][col].abs() {
                pivot = row;
            }
        }
        if m[pivot][col].abs() < 1e-12 {
            return Err(ScanError::new(
                ScanErrorKind::WarpFailed,
                "homography system is singular (degenerate quad)",
            ));
        }
        m.swap(col, pivot);
        for row in (col + 1)..8 {
            let factor = m[row][col] / m[col][col];
            let src = m[col];
            for (cell, s) in m[row].iter_mut().zip(src.iter()).skip(col) {
                *cell -= factor * s;
            }
        }
    }
    // Back substitution.
    let mut h = [0.0f64; 8];
    for i in (0..8).rev() {
        let mut sum = m[i][8];
        for k in (i + 1)..8 {
            sum -= m[i][k] * h[k];
        }
        h[i] = sum / m[i][i];
    }
    Ok([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1.0])
}

/// Applies a row-major homography to one point.
#[must_use]
pub fn apply_homography(h: &[f64; 9], p: Point) -> Point {
    let w = h[6] * p.x + h[7] * p.y + h[8];
    Point::new(
        (h[0] * p.x + h[1] * p.y + h[2]) / w,
        (h[3] * p.x + h[4] * p.y + h[5]) / w,
    )
}

/// Inverts a row-major 3×3 homography (adjugate / determinant).
/// Fails on near-singular matrices instead of dividing by ~zero.
pub fn invert_homography(h: &[f64; 9]) -> Result<[f64; 9], ScanError> {
    let (a, b, c, d, e, f, g, hh, i) = (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]);
    let det = a * (e * i - f * hh) - b * (d * i - f * g) + c * (d * hh - e * g);
    if det.abs() < 1e-12 {
        return Err(ScanError::new(
            ScanErrorKind::WarpFailed,
            "homography is not invertible",
        ));
    }
    Ok([
        (e * i - f * hh) / det,
        (c * hh - b * i) / det,
        (b * f - c * e) / det,
        (f * g - d * i) / det,
        (a * i - c * g) / det,
        (c * d - a * f) / det,
        (d * hh - e * g) / det,
        (b * g - a * hh) / det,
        (a * e - b * d) / det,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect() -> Quad {
        Quad::new(
            Point::new(10.0, 20.0),
            Point::new(110.0, 20.0),
            Point::new(110.0, 220.0),
            Point::new(10.0, 220.0),
        )
    }

    #[test]
    fn orders_axis_aligned_corners() {
        let q = rect();
        let shuffled = [q.br, q.tl, q.bl, q.tr];
        assert_eq!(order_corners(shuffled).expect("orders"), q);
    }

    #[test]
    fn orders_rotated_and_shuffled_corners() {
        // ~30° rotated rectangle, shuffled.
        let pts = [
            Point::new(63.3, 6.7),
            Point::new(136.7, 150.0),
            Point::new(36.7, 150.0),
            Point::new(110.0, 6.7),
        ];
        let q = order_corners(pts).expect("orders");
        assert!(q.tl.x < q.tr.x && q.bl.x < q.br.x);
        assert!(q.tl.y < q.bl.y && q.tr.y < q.br.y);
    }

    #[test]
    fn orders_perspective_quad() {
        // Keystoned: top edge shorter, shifted right.
        let pts = [
            Point::new(300.0, 400.0),
            Point::new(60.0, 50.0),
            Point::new(40.0, 380.0),
            Point::new(220.0, 60.0),
        ];
        let q = order_corners(pts).expect("orders");
        assert_eq!(q.tl, Point::new(60.0, 50.0));
        assert_eq!(q.tr, Point::new(220.0, 60.0));
        assert_eq!(q.br, Point::new(300.0, 400.0));
        assert_eq!(q.bl, Point::new(40.0, 380.0));
    }

    #[test]
    fn rejects_degenerate_point_sets() {
        let dup = [Point::new(1.0, 1.0); 4];
        assert!(order_corners(dup).is_err());
        let collinear = [
            Point::new(0.0, 0.0),
            Point::new(1.0, 1.0),
            Point::new(2.0, 2.0),
            Point::new(3.0, 3.0),
        ];
        assert!(order_corners(collinear).is_err());
        let nan = [
            Point::new(f64::NAN, 0.0),
            Point::new(1.0, 0.0),
            Point::new(1.0, 1.0),
            Point::new(0.0, 1.0),
        ];
        assert!(order_corners(nan).is_err());
    }

    #[test]
    fn validates_good_quad_and_reports_area() {
        let frac = validate_quad(&rect(), 200.0, 400.0).expect("valid");
        assert!((frac - 0.25).abs() < 1e-9, "{frac}");
    }

    #[test]
    fn rejects_bad_quads() {
        // Tiny area.
        let tiny = Quad::new(
            Point::new(0.0, 0.0),
            Point::new(2.0, 0.0),
            Point::new(2.0, 2.0),
            Point::new(0.0, 2.0),
        );
        assert!(validate_quad(&tiny, 200.0, 200.0).is_err());
        // Non-convex (dart): ordered directly, validation must refuse it.
        let dart = Quad::new(
            Point::new(0.0, 0.0),
            Point::new(100.0, 0.0),
            Point::new(30.0, 30.0),
            Point::new(0.0, 100.0),
        );
        assert!(validate_quad(&dart, 200.0, 200.0).is_err());
        // Needle angle (thin rhombus: two ~157° interior angles).
        let needle = Quad::new(
            Point::new(0.0, 20.0),
            Point::new(100.0, 0.0),
            Point::new(200.0, 20.0),
            Point::new(100.0, 40.0),
        );
        assert!(validate_quad(&needle, 200.0, 200.0).is_err());
    }

    #[test]
    fn homography_maps_corners_exactly() {
        let src = Quad::new(
            Point::new(60.0, 50.0),
            Point::new(220.0, 60.0),
            Point::new(300.0, 400.0),
            Point::new(40.0, 380.0),
        );
        let h = homography(&src, 200.0, 300.0).expect("solves");
        let dst = [
            Point::new(0.0, 0.0),
            Point::new(200.0, 0.0),
            Point::new(200.0, 300.0),
            Point::new(0.0, 300.0),
        ];
        for (s, d) in src.corners().iter().zip(dst.iter()) {
            let mapped = apply_homography(&h, *s);
            assert!(mapped.dist(d) < 1e-6, "{mapped:?} vs {d:?}");
        }
    }

    #[test]
    fn homography_identity_stays_identity() {
        let src = Quad::new(
            Point::new(0.0, 0.0),
            Point::new(100.0, 0.0),
            Point::new(100.0, 100.0),
            Point::new(0.0, 100.0),
        );
        let h = homography(&src, 100.0, 100.0).expect("solves");
        for v in [h[0], h[4], h[8]] {
            assert!((v - 1.0).abs() < 1e-9);
        }
        for v in [h[1], h[2], h[3], h[5], h[6], h[7]] {
            assert!(v.abs() < 1e-9);
        }
    }

    #[test]
    fn homography_round_trips_through_inverse() {
        let src = Quad::new(
            Point::new(60.0, 50.0),
            Point::new(220.0, 60.0),
            Point::new(300.0, 400.0),
            Point::new(40.0, 380.0),
        );
        let h = homography(&src, 200.0, 300.0).expect("solves");
        let inv = invert_homography(&h).expect("inverts");
        for s in src.corners() {
            let there = apply_homography(&h, s);
            let back = apply_homography(&inv, there);
            assert!(back.dist(&s) < 1e-6, "{back:?} vs {s:?}");
        }
    }
}
