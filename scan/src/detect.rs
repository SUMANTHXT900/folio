//! Document detection: Canny edges → contours → quadrilateral select.
//!
//! Operates on a downscaled copy (long edge [`DETECT_LONG_EDGE`] px) —
//! detection needs shapes, not megapixels. The downscale reads the
//! caller's RGB bytes through a borrowed view: no full-resolution copy
//! is materialized. The returned corners are in FULL-resolution
//! coordinates (scaled back up) so the warp stage uses the original
//! pixels.
//!
//! Selection is a weighted rank over passing quads (edge support,
//! area, 90°-plausibility, mild A/DIN aspect sanity) — not
//! largest-wins. Confidence is the rank blended into
//! `MIN_EDGE_SUPPORT..=1.0`, gated by the same hard support threshold
//! plus the geometric validation in `geometry` (gates never weakened).
//!
//! Recall paths (bounded, near-failure-only cost): grayscale-Canny and
//! local-adaptive threshold rungs behind a shared trigger — empty pool,
//! non-bimodal Otsu histogram (research §11 H-B), or a weakly-supported
//! binary winner (a ring broken by shadow or fused pattern blobs passes
//! the gates corner-cut; only the local-contrast rungs can out-rank it).
//! Candidates from every rung share the UNCHANGED gates and the rank
//! decides — Otsu stays the primary rung, recall candidates must
//! out-rank it, never wholesale-replace it. Plus 5–8-gon → quad fitting
//! by turning angle, and a 3-epsilon RDP sweep kept per-contour-best.
//! Every Canny pass runs on a replicate-padded margin with a
//! frame-closure stroke (H-A) so pages touching the frame still form
//! closed rings; contour points return in original coordinates.

use std::cmp::Ordering;

use image::flat::{FlatSamples, SampleLayout};
use image::{imageops, GrayImage, Luma, Rgb};

use crate::error::{ScanError, ScanErrorKind};
use crate::geometry::{order_corners, validate_quad, Point, Quad};

/// Detection working resolution (long edge, px).
///
/// 1200 (not 800): the capture-path detect now runs in the background
/// review queue, so it can afford ~2.25× the pixels of the old live-tick
/// scale for finer boundary/texture separation. Live guidance frames
/// (long edge ~160–320px) are UNAFFECTED: [`detection_scale`] never
/// upscales, so small frames still detect at native resolution.
pub const DETECT_LONG_EDGE: u32 = 1200;
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
/// Ranking weights (sum 1.0). Support dominates; aspect is a mild nudge.
const RANK_W_SUPPORT: f64 = 0.5;
const RANK_W_AREA: f64 = 0.2;
const RANK_W_ANGLE: f64 = 0.2;
const RANK_W_ASPECT: f64 = 0.1;
/// Bounded RDP epsilon sweep (multipliers on the base epsilon).
/// Primary first; per-contour best wins so the success path keeps its
/// quad while rounded/fragmented loops get coarser/finer chances.
const EPSILON_SWEEP_MULTS: [f64; 3] = [1.0, 1.5, 0.7];
/// Bimodality guard: both Otsu classes need ≥5% weight, means ≥20 gray
/// levels apart, and Otsu effectiveness η ≥ 0.15. All computed from the
/// already-built histogram — no second pixel pass.
const BIMODAL_MIN_CLASS_FRAC: f64 = 0.05;
const BIMODAL_MIN_MEAN_SEP: f64 = 20.0;
const BIMODAL_MIN_EFFECTIVENESS: f64 = 0.15;
/// Replicate border margin (px, detection scale) prepended before Canny.
/// Moves Canny's zero frame outside the content and gives strokes cut by
/// the frame runway past the original border (H-A).
const BORDER_PAD: i32 = 4;
/// Illumination-estimate thumbnail long edge (research §6, detect-side).
const ILLUM_THUMB_LONG_EDGE: u32 = 64;
/// Clamped background-divide gain (research §6: ≤1.3×) — flattens light
/// falloff without letting page-vs-background contrast collapse.
const ILLUM_MAX_GAIN: f64 = 1.3;
/// Strength of the applied correction (research §6 damped pre-step).
/// The divide alone converges toward the reference on large uniform
/// regions — page AND background both move toward the mean when each is
/// bigger than the estimate scale — collapsing page-vs-background
/// contrast. Damping keeps most of the original contrast while still
/// flattening shadow gradients (partial shading removal beats a broken
/// threshold split).
const ILLUM_STRENGTH: f64 = 0.5;
/// Recall-rung trigger (not an acceptance gate): when the binary path's
/// best candidate is supported below this, its ring is broken — shadow
/// cut, fused pattern blobs — and the local-contrast rungs get their
/// chance to out-rank it. Acceptance gates are untouched.
const RECALL_SUPPORT_TRIGGER: f64 = 0.85;
/// Local-adaptive rung: a pixel stays white when it reaches its block
/// mean minus this offset. Absorbs sensor noise in uniform regions so
/// only real boundaries (page vs surroundings) leave the moat.
const ADAPTIVE_OFFSET: u32 = 12;

/// A detected document: normalized corners + earned confidence 0–1.
#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub quad: Quad,
    pub confidence: f64,
}

/// A quad that passed the unchanged gates, with its rank inputs.
/// `map_idx` names the support map its support was measured against
/// (0 = main rung; recall rungs append).
#[derive(Debug, Clone)]
struct ScoredCandidate {
    quad: Quad,
    area_frac: f64,
    support: f64,
    rank: f64,
    confidence: f64,
    map_idx: u8,
}

/// Working downscale factor for detection: maps the long edge to
/// [`DETECT_LONG_EDGE`] px and is capped at 1.0 — small images (live
/// guidance ticks, tiny uploads) are never upscaled. Corners return in
/// full-resolution coordinates via `p / scale`, so this factor is the
/// single mapping between detection space and caller space.
fn detection_scale(w: u32, h: u32) -> f64 {
    (DETECT_LONG_EDGE as f64 / u32::max(w, h).max(1) as f64).min(1.0)
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
    let scale = detection_scale(w, h);
    let sw = ((w as f64 * scale).round() as u32).max(1);
    let sh = ((h as f64 * scale).round() as u32).max(1);
    let flat = rgb_samples(rgb, w, h);
    let view = flat
        .as_view::<Rgb<u8>>()
        .expect("RGB buffer length checked above");
    let small_rgb = imageops::resize(&view, sw, sh, imageops::FilterType::Triangle);
    let gray = imageops::grayscale(&small_rgb);
    let blurred = imageproc::filter::gaussian_blur_f32(&gray, 1.5);
    // Illumination normalization (research §6 background-divide, applied
    // to DETECT — not enhance): a tiny blurred thumbnail estimates the
    // lighting field and every pixel gets the clamped gain `ref/illum`,
    // flattening light falloff and shadow gradients BEFORE thresholding
    // so global Otsu splits page-vs-background instead of lit-vs-shadowed.
    // Buffers are detection-scale or thumbnail-scale only.
    let normalized = normalize_illumination(&blurred);
    // Otsu binarization: adapts to the photo's own lighting instead of
    // assuming lab-grade contrast. The histogram is built once here;
    // the bimodality guard below reuses it with no second pixel pass.
    let analysis = otsu_analyze(&normalized);
    let bimodal = analysis.bimodal;
    let binary = analysis.binary;
    // Morphological closing bridges 1–2px gaps (shadow breaks, weak
    // edge segments) so the page boundary forms closed loops.
    let closed = morph_close(&binary, 2);
    // Rung 1: binary → closing → Canny → contours (frame-closed, H-A).
    let main_pass = edge_pass(&closed, true);
    let mut maps: Vec<GrayImage> = vec![main_pass.support_map];
    let frame_area = f64::from(sw) * f64::from(sh);
    let mut candidates =
        collect_scored_candidates(&main_pass.contours, &maps[0], sw, sh, frame_area, 0);

    // Recall rungs (bounded, near-failure-only cost): when the binary
    // path yields zero candidates, when the Otsu histogram is
    // non-bimodal (global threshold untrustworthy — trimodal patterned
    // sheets, shadow splits), or when its best candidate is weakly
    // supported: paper in shadow falls to sheet brightness, no global
    // threshold separates them, and the binary path returns a passing
    // but corner-cut quad only the local-contrast rungs can out-rank.
    // All at detection scale with buffers already in memory; candidates
    // from every rung share the same unchanged gates and the rank
    // decides — Otsu stays the primary rung and recall candidates must
    // out-rank it, never wholesale-replace it.
    let binary_weak = !candidates
        .iter()
        .any(|c| c.support >= RECALL_SUPPORT_TRIGGER);
    if !bimodal || binary_weak {
        // Rung 2: grayscale-Canny on the already-normalized gray.
        let gray_pass = edge_pass(&normalized, true);
        maps.push(gray_pass.support_map);
        let gray_idx = (maps.len() - 1) as u8;
        let gray_cands = collect_scored_candidates(
            &gray_pass.contours,
            &maps[maps.len() - 1],
            sw,
            sh,
            frame_area,
            gray_idx,
        );
        // Rung 3: local-adaptive threshold → closing → Canny. Research
        // §11 H-B: adaptive only as a gated secondary path — it erases
        // boundaries on clean uniform backgrounds, never wholesale.
        let adaptive = adaptive_binary(&normalized, adaptive_radius(sw, sh), ADAPTIVE_OFFSET);
        let adaptive_closed = morph_close(&adaptive, 2);
        let adapt_pass = edge_pass(&adaptive_closed, true);
        maps.push(adapt_pass.support_map);
        let adapt_idx = (maps.len() - 1) as u8;
        let adapt_cands = collect_scored_candidates(
            &adapt_pass.contours,
            &maps[maps.len() - 1],
            sw,
            sh,
            frame_area,
            adapt_idx,
        );
        for extra in [gray_cands, adapt_cands] {
            if candidates.is_empty() {
                candidates = extra;
            } else {
                candidates.extend(extra);
            }
        }
    }

    if candidates.is_empty() {
        return Ok(None);
    }
    // Weighted rank (not largest-wins): support dominates, area/angle
    // break ties toward page-like quads, aspect only nudges.
    // Deterministic tie-breaks (rank ε, then area, then corners).
    candidates.sort_by(compare_candidates);
    let winner = candidates[0].clone();
    let winner_map: &GrayImage = &maps[winner.map_idx as usize];
    // Open-spread merge: two side-by-side halves (split by a spine/fold)
    // reunite into the outer boundary when their facing edges align.
    // The merged quad re-passes validation + support on the winner's
    // edge map, so single pages and unrelated neighbors are unaffected.
    for other in candidates.iter().skip(1) {
        if let Some(merged) = try_merge_horizontal(&winner.quad, &other.quad) {
            if let Ok(area_frac) = validate_quad(&merged, f64::from(sw), f64::from(sh)) {
                let support = edge_support(&merged, winner_map);
                if support >= MIN_EDGE_SUPPORT {
                    let (_, confidence) = rank_scores(area_frac, support, &merged);
                    let up = |p: Point| Point::new(p.x / scale, p.y / scale);
                    let full =
                        Quad::new(up(merged.tl), up(merged.tr), up(merged.br), up(merged.bl));
                    return Ok(Some(Detection {
                        quad: full,
                        confidence,
                    }));
                }
            }
        }
    }
    // No merge: the top-ranked passing quad wins.
    let up = |p: Point| Point::new(p.x / scale, p.y / scale);
    let full = Quad::new(
        up(winner.quad.tl),
        up(winner.quad.tr),
        up(winner.quad.br),
        up(winner.quad.bl),
    );
    Ok(Some(Detection {
        quad: full,
        confidence: winner.confidence,
    }))
}

/// Attempts to merge two side-by-side quads (open-spread halves split
/// by a spine/fold) into their outer boundary.
///
/// The left quad's right edge and the right quad's left edge must be
/// close in x — gutter gap OR slight fold overlap within 15% of the
/// narrower width (soft folds shade the halves' fitted corners a few px
/// past the fold core) — and overlap in y by ≥ 70% of the shorter edge.
/// Returns the merged quad in normalized corner order; validation +
/// support happen in the caller, so unrelated neighbors (and nested
/// inner-block quads, whose gap is ~a full width) cannot sneak through.
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
    if gap.abs() > 0.15 * left_w.min(right_w).max(1.0) {
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

/// One Canny → contours pass at detection scale, frame-closed (H-A).
///
/// The input is replicate-padded by [`BORDER_PAD`] before Canny so the
/// zero frame sits outside the content and strokes cut by the frame keep
/// runway past the original border, then a 1px margin stroke is drawn
/// along the ORIGINAL frame so those cut rings close. Contour points
/// come back in original coordinates; the support map is the honest
/// Canny gradient (margin stroke excluded) cropped to the original
/// extent — frame-coincident quad edges simply earn no support there.
struct EdgePass {
    contours: Vec<Vec<Point>>,
    support_map: GrayImage,
}

fn edge_pass(input: &GrayImage, frame_closure: bool) -> EdgePass {
    let pad = if frame_closure { BORDER_PAD } else { 0 };
    let padded = replicate_pad(input, pad);
    let edges = imageproc::edges::canny(&padded, 40.0, 120.0);
    let support_map = crop_gray(&dilate(&edges, DILATE_RADIUS), pad);
    let mut contour_input = edges;
    if frame_closure {
        stroke_frame_margin(&mut contour_input, pad);
    }
    let contours = contours_from_edges(&contour_input)
        .iter()
        .map(|pts| {
            pts.iter()
                .map(|p| Point::new(p.x - f64::from(pad), p.y - f64::from(pad)))
                .collect()
        })
        .collect();
    EdgePass {
        contours,
        support_map,
    }
}

/// Replicate-border pad of a detection-scale gray image. `pad = 0`
/// clones — no special cases downstream.
fn replicate_pad(src: &GrayImage, pad: i32) -> GrayImage {
    if pad == 0 {
        return src.clone();
    }
    let (w, h) = (src.width() as i32, src.height() as i32);
    let (pw, ph) = (w + 2 * pad, h + 2 * pad);
    let mut out = GrayImage::new(pw as u32, ph as u32);
    for y in 0..ph {
        let sy = (y - pad).clamp(0, h - 1);
        for x in 0..pw {
            let sx = (x - pad).clamp(0, w - 1);
            out.put_pixel(x as u32, y as u32, *src.get_pixel(sx as u32, sy as u32));
        }
    }
    out
}

/// Draws a 1px stroke along the ORIGINAL frame inside the padded edge
/// map: the synthetic margin that closes boundary rings cut by the
/// frame (H-A). Its own ring contours are ~100% / ~99.5% frame-area and
/// are rejected by the unchanged 5–99% area gate, so it can only close
/// rings — never smuggle in a quad.
fn stroke_frame_margin(img: &mut GrayImage, pad: i32) {
    let (w, h) = (img.width() as i32, img.height() as i32);
    let (x0, y0) = (pad, pad);
    let (x1, y1) = (w - 1 - pad, h - 1 - pad);
    if x1 <= x0 + 1 || y1 <= y0 + 1 {
        return;
    }
    for x in x0..=x1 {
        img.put_pixel(x as u32, y0 as u32, Luma([255u8]));
        img.put_pixel(x as u32, y1 as u32, Luma([255u8]));
    }
    for y in y0..=y1 {
        img.put_pixel(x0 as u32, y as u32, Luma([255u8]));
        img.put_pixel(x1 as u32, y as u32, Luma([255u8]));
    }
}

/// Center crop back to the original extent (support-map de-padding).
fn crop_gray(src: &GrayImage, pad: i32) -> GrayImage {
    if pad == 0 {
        return src.clone();
    }
    let (w, h) = (src.width() as i32, src.height() as i32);
    let (ow, oh) = (w - 2 * pad, h - 2 * pad);
    let mut out = GrayImage::new(ow as u32, oh as u32);
    for y in 0..oh {
        for x in 0..ow {
            out.put_pixel(
                x as u32,
                y as u32,
                *src.get_pixel((x + pad) as u32, (y + pad) as u32),
            );
        }
    }
    out
}

/// Clamped, DAMPED thumbnail background-divide (research §6, detect-side).
///
/// The blurred thumbnail is the illumination estimate: per-pixel
/// `gain = ref / illum` clamped to `ILLUM_MAX_GAIN` both ways flattens
/// light falloff and shadow gradients. The clamp alone cannot keep
/// page-vs-background contrast when both regions are large (the smooth
/// estimate converges to each region's own mean), so the correction is
/// applied at [`ILLUM_STRENGTH`] — most of the shading benefit, most of
/// the contrast preserved. O(N) with one detection-scale output — no
/// full-resolution copies anywhere.
fn normalize_illumination(gray: &GrayImage) -> GrayImage {
    let (w, h) = (gray.width(), gray.height());
    let scale = ILLUM_THUMB_LONG_EDGE as f64 / u32::max(w, h).max(1) as f64;
    let scale = scale.min(1.0);
    let tw = ((w as f64 * scale).round() as u32).clamp(2, w.max(2));
    let th = ((h as f64 * scale).round() as u32).clamp(2, h.max(2));
    let thumb = imageops::resize(gray, tw, th, imageops::FilterType::Triangle);
    let illum_thumb = imageproc::filter::gaussian_blur_f32(&thumb, 3.0);
    let mut ref_sum = 0.0f64;
    for px in illum_thumb.pixels() {
        ref_sum += f64::from(px.0[0]);
    }
    let reference = ref_sum / f64::from(tw * th);
    let illum = imageops::resize(&illum_thumb, w, h, imageops::FilterType::Triangle);
    let mut out = GrayImage::new(w, h);
    for (x, y, px) in out.enumerate_pixels_mut() {
        let est = f64::from(illum.get_pixel(x, y).0[0]).max(1.0);
        let gain = (reference / est).clamp(1.0 / ILLUM_MAX_GAIN, ILLUM_MAX_GAIN);
        let damped = 1.0 + ILLUM_STRENGTH * (gain - 1.0);
        let v = f64::from(gray.get_pixel(x, y).0[0]) * damped;
        *px = Luma([v.round().clamp(0.0, 255.0) as u8]);
    }
    out
}

/// Local-mean adaptive threshold (recall rung only): white where the
/// pixel reaches its block mean minus `ADAPTIVE_OFFSET`. Uniform paper
/// and uniform surroundings both stay white; the boundary leaves a dark
/// moat that closing + Canny turn into the page ring — the texture-
/// independent split global Otsu cannot make on trimodal histograms.
/// Integer-exact via an integral image (detection-scale, transient).
fn adaptive_binary(gray: &GrayImage, block_radius: i32, offset: u32) -> GrayImage {
    let (w, h) = (gray.width() as i32, gray.height() as i32);
    let stride = (w + 1) as usize;
    let mut integral = vec![0u32; stride * (h as usize + 1)];
    for y in 0..h {
        let mut row_sum = 0u32;
        for x in 0..w {
            row_sum += u32::from(gray.get_pixel(x as u32, y as u32).0[0]);
            let above = integral[y as usize * stride + (x + 1) as usize];
            integral[(y as usize + 1) * stride + (x + 1) as usize] = above + row_sum;
        }
    }
    // Integral border: anything outside the image sums to zero, so
    // `at(-1, *)` / `at(*, -1)` is the standard zero row/column.
    let at = |x: i32, y: i32| -> u32 {
        if x < 0 || y < 0 {
            0
        } else {
            integral[(y as usize + 1) * stride + (x + 1) as usize]
        }
    };
    let mut out = GrayImage::new(gray.width(), gray.height());
    for y in 0..h {
        for x in 0..w {
            let x0 = (x - block_radius).max(0);
            let y0 = (y - block_radius).max(0);
            let x1 = (x + block_radius).min(w - 1);
            let y1 = (y + block_radius).min(h - 1);
            // Box sum via the integral image (inclusive edges).
            let sum = u64::from(at(x1, y1)) + u64::from(at(x0 - 1, y0 - 1))
                - u64::from(at(x0 - 1, y1))
                - u64::from(at(x1, y0 - 1));
            let count = u64::from((x1 - x0 + 1) as u32) * u64::from((y1 - y0 + 1) as u32);
            // v + offset >= mean  ⟺  (v + offset) * count >= sum.
            let lhs = u64::from(gray.get_pixel(x as u32, y as u32).0[0]) + u64::from(offset);
            let white = lhs * count >= sum;
            out.put_pixel(x as u32, y as u32, Luma([if white { 255u8 } else { 0u8 }]));
        }
    }
    out
}

/// Adaptive block radius scales with the detection frame (≈1/16 of the
/// short edge) — big enough to see past ink strokes and pattern motifs,
/// small enough to stay local at live-tick (~160px) scale.
fn adaptive_radius(sw: u32, sh: u32) -> i32 {
    let short = i32::try_from(sw.min(sh)).unwrap_or(DETECT_LONG_EDGE as i32);
    (short / 16).clamp(8, 48)
}

/// Extracts area-ordered contour point loops from an edge map, with the
/// cheap prefilter (point count + bounding extent) keeping thousands
/// of tiny texture loops from ever being materialized as f64 vectors.
fn contours_from_edges(edges: &GrayImage) -> Vec<Vec<Point>> {
    let mut contours: Vec<Vec<Point>> = imageproc::contours::find_contours::<u32>(edges)
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
            .unwrap_or(Ordering::Equal)
    });
    contours.truncate(MAX_CONTOUR_CANDIDATES);
    contours
}

/// Fits every contour (bounded epsilon sweep, per-contour best) and
/// keeps quads passing the UNCHANGED gates: `validate_quad` + the
/// `MIN_EDGE_SUPPORT` support threshold. No gate weakening anywhere.
/// `map_idx` is stamped onto each candidate for support-map lookup.
fn collect_scored_candidates(
    contours: &[Vec<Point>],
    support_map: &GrayImage,
    sw: u32,
    sh: u32,
    frame_area: f64,
    map_idx: u8,
) -> Vec<ScoredCandidate> {
    let mut out = Vec::new();
    for pts in contours {
        if poly_area(pts) / frame_area < MIN_CONTOUR_AREA_FRAC {
            continue;
        }
        let perimeter = poly_perimeter(pts);
        let mut best: Option<ScoredCandidate> = None;
        for mult in EPSILON_SWEEP_MULTS {
            let eps = RDP_EPSILON_FRAC * perimeter * mult;
            let Some(corners) = approx_closed_quad(pts, eps) else {
                continue;
            };
            let quad = match order_corners(corners) {
                Ok(q) => q,
                Err(_) => continue,
            };
            let area_frac = match validate_quad(&quad, f64::from(sw), f64::from(sh)) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let support = edge_support(&quad, support_map);
            if support < MIN_EDGE_SUPPORT {
                continue;
            }
            let (rank, confidence) = rank_scores(area_frac, support, &quad);
            let cand = ScoredCandidate {
                quad,
                area_frac,
                support,
                rank,
                confidence,
                map_idx,
            };
            let better = match &best {
                None => true,
                Some(b) => cand.rank > b.rank + 1e-12,
            };
            if better {
                best = Some(cand);
            }
        }
        if let Some(b) = best {
            out.push(b);
        }
    }
    out
}

/// Weighted rank → blended confidence.
///
/// `support_norm`/`area_norm` map the passing ranges (0.5–1.0,
/// 0.05–0.99) to 0–1; angle/aspect already score 0–1. Confidence maps
/// the rank back to `MIN_EDGE_SUPPORT..=1.0` so every accepted
/// detection honors the gate while carrying shape information.
fn rank_scores(area_frac: f64, support: f64, quad: &Quad) -> (f64, f64) {
    let support_norm = ((support - MIN_EDGE_SUPPORT) / (1.0 - MIN_EDGE_SUPPORT)).clamp(0.0, 1.0);
    let area_norm = ((area_frac - 0.05) / (0.99 - 0.05)).clamp(0.0, 1.0);
    let angle = quad_angle_score(quad);
    let aspect = quad_aspect_score(quad);
    let rank = RANK_W_SUPPORT * support_norm
        + RANK_W_AREA * area_norm
        + RANK_W_ANGLE * angle
        + RANK_W_ASPECT * aspect;
    let rank = rank.clamp(0.0, 1.0);
    let confidence =
        (MIN_EDGE_SUPPORT + (1.0 - MIN_EDGE_SUPPORT) * rank).clamp(MIN_EDGE_SUPPORT, 1.0);
    (rank, confidence)
}

/// 90°-deviation plausibility: 1.0 for rectangles, decaying to 0 at a
/// mean 60° deviation (the `validate_quad` 30°–150° envelope edge).
fn quad_angle_score(quad: &Quad) -> f64 {
    let c = quad.corners();
    let mut dev_sum = 0.0;
    for i in 0..4 {
        let a = c[i];
        let b = c[(i + 1) % 4];
        let d = c[(i + 2) % 4];
        let abx = b.x - a.x;
        let aby = b.y - a.y;
        let len = abx.hypot(aby).max(1e-9);
        let bdx = d.x - b.x;
        let bdy = d.y - b.y;
        let blen = bdx.hypot(bdy).max(1e-9);
        let dot = ((abx * bdx + aby * bdy) / (len * blen)).clamp(-1.0, 1.0);
        let turn = dot.acos().to_degrees();
        let interior = 180.0 - turn;
        dev_sum += (interior - 90.0).abs();
    }
    (1.0 - (dev_sum / 4.0) / 60.0).clamp(0.0, 1.0)
}

/// Aspect sanity via paper-ratio bands (mild penalty only, never a veto).
/// Portrait/landscape invariant: `r = max(w/h, h/w)`.
/// A/Letter zone 1.15–1.8 scores 1.0; the broad 1.05–2.2 zone (spreads,
/// squarish captures) scores 0.85; outside decays mildly to a 0.5 floor.
fn quad_aspect_score(quad: &Quad) -> f64 {
    let (w, h) = quad.mean_size();
    if !(w.is_finite() && h.is_finite()) || w < 1e-9 || h < 1e-9 {
        return 0.5;
    }
    let r = (w / h).max(h / w);
    if !r.is_finite() {
        return 0.5;
    }
    if (1.15..=1.8).contains(&r) {
        1.0
    } else if (1.05..=2.2).contains(&r) {
        0.85
    } else if r < 1.05 {
        (0.85 * r / 1.05).clamp(0.5, 0.85)
    } else {
        (0.85 - (r - 2.2) * 0.15).clamp(0.5, 0.85)
    }
}

/// Rank-order comparator: higher rank first; near-ties (≤1e-9) break by
/// larger area, then lexicographic corners — fully deterministic.
fn compare_candidates(a: &ScoredCandidate, b: &ScoredCandidate) -> Ordering {
    if (a.rank - b.rank).abs() > 1e-9 {
        return b.rank.partial_cmp(&a.rank).unwrap_or(Ordering::Equal);
    }
    if (a.area_frac - b.area_frac).abs() > 1e-12 {
        return b
            .area_frac
            .partial_cmp(&a.area_frac)
            .unwrap_or(Ordering::Equal);
    }
    for (pa, pb) in a.quad.corners().iter().zip(b.quad.corners().iter()) {
        if (pa.x - pb.x).abs() > 1e-9 {
            return pa.x.partial_cmp(&pb.x).unwrap_or(Ordering::Equal);
        }
        if (pa.y - pb.y).abs() > 1e-9 {
            return pa.y.partial_cmp(&pb.y).unwrap_or(Ordering::Equal);
        }
    }
    Ordering::Equal
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

/// Otsu analysis: threshold + binary plus the already-built histogram
/// inputs for the bimodality guard (no second pixel pass).
struct OtsuAnalysis {
    binary: GrayImage,
    bimodal: bool,
}

/// Otsu's threshold: the gray level maximizing between-class variance.
/// Adapts to each photo's lighting (dark rooms, shade, bright desks).
fn otsu_analyze(gray: &GrayImage) -> OtsuAnalysis {
    let mut hist = [0u64; 256];
    for px in gray.pixels() {
        hist[px.0[0] as usize] += 1;
    }
    let total = (gray.width() as u64) * (gray.height() as u64);
    if total == 0 {
        return OtsuAnalysis {
            binary: gray.clone(),
            bimodal: false,
        };
    }
    let mut sum_all = 0u64;
    for (i, h) in hist.iter().enumerate() {
        sum_all += i as u64 * h;
    }
    let mut sum_bg = 0u64;
    let mut weight_bg = 0u64;
    let mut best_var = -1.0f64;
    let mut threshold = 128u8;
    let mut best_wbg = 0u64;
    let mut best_sbg = 0u64;
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
            best_wbg = weight_bg;
            best_sbg = sum_bg;
        }
    }
    let bimodal = otsu_is_bimodal(
        &hist, total, sum_all, threshold, best_wbg, best_sbg, best_var,
    );
    let mut out = GrayImage::new(gray.width(), gray.height());
    for (x, y, px) in out.enumerate_pixels_mut() {
        let v = gray.get_pixel(x, y).0[0];
        *px = Luma([if v > threshold { 255u8 } else { 0u8 }]);
    }
    OtsuAnalysis {
        binary: out,
        bimodal,
    }
}

/// Bimodality guard on the already-built Otsu histogram: both classes
/// need ≥5% weight, means ≥20 levels apart, effectiveness η ≥ 0.15.
/// Uniform/low-contrast histograms fail → the grayscale fallback runs.
fn otsu_is_bimodal(
    hist: &[u64; 256],
    total: u64,
    sum_all: u64,
    threshold: u8,
    weight_bg: u64,
    sum_bg: u64,
    best_var: f64,
) -> bool {
    if total == 0 || best_var < 0.0 {
        return false;
    }
    let weight_fg = total.saturating_sub(weight_bg);
    let wb = weight_bg as f64 / total as f64;
    let wf = weight_fg as f64 / total as f64;
    if wb.min(wf) < BIMODAL_MIN_CLASS_FRAC {
        return false;
    }
    if weight_bg == 0 || weight_fg == 0 {
        return false;
    }
    let mean_bg = sum_bg as f64 / weight_bg as f64;
    let mean_fg = (sum_all - sum_bg) as f64 / weight_fg as f64;
    if (mean_fg - mean_bg).abs() < BIMODAL_MIN_MEAN_SEP {
        return false;
    }
    let mean_all = sum_all as f64 / total as f64;
    let mut total_var = 0.0;
    for (i, h) in hist.iter().enumerate() {
        if *h == 0 {
            continue;
        }
        let d = i as f64 - mean_all;
        total_var += *h as f64 * d * d;
    }
    total_var /= total as f64;
    if total_var < 1e-9 {
        return false;
    }
    // best_var = wb_count*wf_count*(diff)^2; normalize to fractions.
    let between = best_var / (total as f64 * total as f64);
    let eta = between / total_var;
    if !eta.is_finite() || eta < BIMODAL_MIN_EFFECTIVENESS {
        return false;
    }
    let _ = threshold;
    true
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
/// quads) makes the open-polyline RDP converge to exactly 4 points.
/// RDP loops with 5–8 vertices (rounded corners, margin ticks, fold
/// kinks) are reduced to the most rectangular convex 4-subset; anything
/// else is not a clean quad. Validation + support gates in the caller
/// are unchanged.
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
                .unwrap_or(Ordering::Equal)
        })
        .map(|(i, _)| i)?;
    let mut looped = Vec::with_capacity(pts.len() + 1);
    looped.extend_from_slice(&pts[start..]);
    looped.extend_from_slice(&pts[..start]);
    looped.push(pts[start]);
    let approx = rdp(&looped, epsilon);
    // Drop the closing duplicate; require 4 corners, or 5–8 fitted down.
    let mut clean: Vec<Point> = approx;
    if clean.len() >= 2 && clean[0].dist(&clean[clean.len() - 1]) < epsilon.max(2.0) {
        clean.pop();
    }
    if clean.len() == 4 {
        return Some([clean[0], clean[1], clean[2], clean[3]]);
    }
    if (5..=8).contains(&clean.len()) {
        return fit_quad_from_polygon(&clean);
    }
    None
}

/// Reduces a 5–8-vertex RDP loop to its 4 dominant corners.
///
/// Enumerates the ≤70 four-subsets (bounded, deterministic) and keeps
/// the most rectangular convex quad (highest 90°-plausibility, then
/// largest area, then lexicographic). Rounded corners split into 45°
/// kinks lose to the four near-90° page corners; concave kinks (spiral
/// curls) and margin-writing bumps lose on convexity/rectangularity.
/// Returns corners in normalized order; the caller still runs the SAME
/// `validate_quad` + support gate (no weakening).
fn fit_quad_from_polygon(poly: &[Point]) -> Option<[Point; 4]> {
    if poly.len() == 4 {
        return Some([poly[0], poly[1], poly[2], poly[3]]);
    }
    if poly.len() < 5 || poly.len() > 8 {
        return None;
    }
    let n = poly.len();
    let mut best: Option<(Quad, f64, f64)> = None;
    for a in 0..n {
        for b in (a + 1)..n {
            for c in (b + 1)..n {
                for d in (c + 1)..n {
                    let pts = [poly[a], poly[b], poly[c], poly[d]];
                    // Distinct points only.
                    let mut dup = false;
                    for i in 0..4 {
                        for j in (i + 1)..4 {
                            if pts[i].dist(&pts[j]) < 1e-9 {
                                dup = true;
                                break;
                            }
                        }
                    }
                    if dup {
                        continue;
                    }
                    let quad = match order_corners(pts) {
                        Ok(q) => q,
                        Err(_) => continue,
                    };
                    if !quad_is_convex_plausible(&quad) {
                        continue;
                    }
                    let angle = quad_angle_score(&quad);
                    let area = quad.area();
                    let better = match &best {
                        None => true,
                        Some((_, ba, br)) => {
                            if (angle - *br).abs() > 1e-9 {
                                angle > *br
                            } else if (area - *ba).abs() > 1e-9 {
                                area > *ba
                            } else {
                                // Lexicographic for full determinism.
                                let cur = quad.corners();
                                let prev = best.as_ref().expect("some").0.corners();
                                cur.iter().zip(prev.iter()).any(|(p, q)| {
                                    (p.x - q.x).abs() > 1e-9 && p.x > q.x
                                        || (p.x - q.x).abs() <= 1e-9 && (p.y - q.y) > 1e-9
                                }) && cur != prev
                            }
                        }
                    };
                    if better {
                        best = Some((quad, area, angle));
                    }
                }
            }
        }
    }
    best.map(|(q, _, _)| q.corners())
}

/// Convexity + interior-angle plausibility without the area gate
/// (mirrors `validate_quad`'s geometric checks so `fit` never accepts
/// what validation would reject on shape grounds).
fn quad_is_convex_plausible(quad: &Quad) -> bool {
    let c = quad.corners();
    let mut sign = 0.0;
    for i in 0..4 {
        let a = c[i];
        let b = c[(i + 1) % 4];
        let d = c[(i + 2) % 4];
        let cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
        if cross.abs() < 1e-9 {
            return false;
        }
        if sign == 0.0 {
            sign = cross.signum();
        } else if cross.signum() != sign {
            return false;
        }
    }
    for i in 0..4 {
        let a = c[i];
        let b = c[(i + 1) % 4];
        let d = c[(i + 2) % 4];
        let abx = b.x - a.x;
        let aby = b.y - a.y;
        let len = abx.hypot(aby);
        if len < 1e-9 {
            return false;
        }
        let bdx = d.x - b.x;
        let bdy = d.y - b.y;
        let dot = ((abx * bdx + aby * bdy) / (len * bdx.hypot(bdy).max(1e-9))).clamp(-1.0, 1.0);
        let interior = 180.0 - dot.acos().to_degrees();
        if !(30.0..=150.0).contains(&interior) {
            return false;
        }
    }
    true
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
        assert!(d.confidence <= 1.0, "{}", d.confidence);
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
    fn detect_scale_never_upscales_live_frames_and_pins_1200() {
        // Live guidance ticks (long edge ~160–320px) run at NATIVE size:
        // 1200/320 > 1 clamps to 1.0, so raising the working edge from
        // 800 changes nothing for the live path.
        assert!((detection_scale(240, 320) - 1.0).abs() < 1e-12);
        assert!((detection_scale(160, 120) - 1.0).abs() < 1e-12);
        assert!((detection_scale(320, 320) - 1.0).abs() < 1e-12);
        // A 2500px capture runs at the 1200 working edge with the 0.48
        // round-trip: p/scale returns capture coordinates.
        assert_eq!(DETECT_LONG_EDGE, 1200);
        let s = detection_scale(2500, 1875);
        assert!((s - 0.48).abs() < 1e-12, "{s}");
        assert_eq!((2500.0 * s).round() as u32, DETECT_LONG_EDGE);
        assert_eq!((1875.0 * s).round() as u32, 900);
    }

    #[test]
    fn detects_document_on_2500px_capture_with_back_mapped_corners() {
        // Background-processing capture path: a 2500px full-res frame
        // detects at the 1200 working edge; returned corners must be
        // back-mapped (p / scale) into capture coordinates, not left in
        // detection coordinates.
        let (w, h) = (1875u32, 2500u32);
        let q = Quad::new(
            Point::new(150.0, 220.0),
            Point::new(1700.0, 180.0),
            Point::new(1745.0, 2300.0),
            Point::new(120.0, 2340.0),
        );
        let rgb = quad_fixture(w, h, &q);
        let d = detect_document(&rgb, w, h)
            .expect("runs")
            .expect("detects 2500px capture");
        assert!(d.confidence >= MIN_EDGE_SUPPORT, "{}", d.confidence);
        // 40px full-res ≈ 19px at the 1200 working edge.
        for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
            assert!(got.dist(want) < 40.0, "{got:?} vs {want:?}");
        }
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
        // Nested inner block: its "gap" is ~a full width negative and
        // must never merge into the page it sits inside.
        let page = Quad::new(
            Point::new(90.0, 130.0),
            Point::new(550.0, 130.0),
            Point::new(550.0, 670.0),
            Point::new(90.0, 670.0),
        );
        let block = Quad::new(
            Point::new(300.0, 300.0),
            Point::new(520.0, 300.0),
            Point::new(520.0, 500.0),
            Point::new(300.0, 500.0),
        );
        assert!(try_merge_horizontal(&page, &block).is_none());
    }

    #[test]
    fn merge_joins_soft_fold_halves_with_overlap() {
        // Soft folds shade each half's fitted corner a few px past the
        // fold core, so the fitted halves can overlap slightly at the
        // gutter. The overlap (small NEGATIVE gap) must still merge.
        let left = Quad::new(
            Point::new(90.0, 130.0),
            Point::new(322.0, 130.0),
            Point::new(322.0, 670.0),
            Point::new(90.0, 670.0),
        );
        let right = Quad::new(
            Point::new(316.0, 130.0),
            Point::new(550.0, 130.0),
            Point::new(550.0, 670.0),
            Point::new(316.0, 670.0),
        );
        let merged = try_merge_horizontal(&left, &right).expect("overlapping halves merge");
        assert_eq!(merged.tl, Point::new(90.0, 130.0));
        assert_eq!(merged.tr, Point::new(550.0, 130.0));
        assert_eq!(merged.br, Point::new(550.0, 670.0));
        assert_eq!(merged.bl, Point::new(90.0, 670.0));
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

    // ---- Weighted ranker ----

    #[test]
    fn ranker_prefers_supported_page_over_larger_table_edge() {
        // Table edge: larger area but weak support + skewed angles.
        let table = Quad::new(
            Point::new(20.0, 20.0),
            Point::new(620.0, 60.0),
            Point::new(600.0, 400.0),
            Point::new(40.0, 380.0),
        );
        // Page: smaller but rectangular with strong support.
        let page = Quad::new(
            Point::new(150.0, 150.0),
            Point::new(470.0, 150.0),
            Point::new(470.0, 620.0),
            Point::new(150.0, 620.0),
        );
        let table_area = table.area() / (640.0 * 800.0);
        let page_area = page.area() / (640.0 * 800.0);
        assert!(table_area > page_area, "{table_area} vs {page_area}");
        let (table_rank, _) = rank_scores(table_area, 0.56, &table);
        let (page_rank, _) = rank_scores(page_area, 0.95, &page);
        assert!(
            page_rank > table_rank,
            "page {page_rank} must beat table {table_rank}"
        );
    }

    #[test]
    fn ranker_prefers_page_over_large_pattern_patch() {
        // Patterned-vs-page (F-21 bedsheet class): a big light cartoon
        // patch fits as a clean near-square with strong support. It must
        // still lose to the page on the unchanged weights — evidence
        // that no weight retune is needed for this scene class.
        let patch = Quad::new(
            Point::new(40.0, 40.0),
            Point::new(340.0, 40.0),
            Point::new(340.0, 330.0),
            Point::new(40.0, 330.0),
        );
        let page = Quad::new(
            Point::new(120.0, 150.0),
            Point::new(560.0, 118.0),
            Point::new(580.0, 672.0),
            Point::new(100.0, 700.0),
        );
        let frame = 640.0 * 800.0;
        let (patch_rank, _) = rank_scores(patch.area() / frame, 0.88, &patch);
        let (page_rank, _) = rank_scores(page.area() / frame, 0.95, &page);
        assert!(
            page_rank > patch_rank,
            "page {page_rank} must beat patch {patch_rank}"
        );
    }

    #[test]
    fn aspect_sanity_is_mild_penalty_only() {
        // A4-ish portrait: 200x283 ≈ 1.414.
        let a4 = Quad::new(
            Point::new(100.0, 100.0),
            Point::new(300.0, 100.0),
            Point::new(300.0, 383.0),
            Point::new(100.0, 383.0),
        );
        // Extreme strip: 600x150 ≈ 4.0.
        let strip = Quad::new(
            Point::new(20.0, 300.0),
            Point::new(620.0, 300.0),
            Point::new(620.0, 450.0),
            Point::new(20.0, 450.0),
        );
        let a4_score = quad_aspect_score(&a4);
        let strip_score = quad_aspect_score(&strip);
        assert!((a4_score - 1.0).abs() < 1e-9, "{a4_score}");
        // Mild: never vetoes to zero, floor is 0.5.
        assert!(
            strip_score >= 0.5 && strip_score < a4_score,
            "{strip_score}"
        );
        // Rank impact of aspect alone is bounded by its 0.1 weight.
        let (r_good, _) = rank_scores(0.4, 0.9, &a4);
        let (r_bad, _) = rank_scores(0.4, 0.9, &strip);
        assert!((r_good - r_bad).abs() <= 0.06, "{r_good} vs {r_bad}");
    }

    #[test]
    fn rank_tie_breaks_are_deterministic() {
        let q = Quad::new(
            Point::new(100.0, 120.0),
            Point::new(540.0, 120.0),
            Point::new(540.0, 680.0),
            Point::new(100.0, 680.0),
        );
        let (rank, conf) = rank_scores(0.48, 0.9, &q);
        let a = ScoredCandidate {
            quad: q,
            area_frac: 0.48,
            support: 0.9,
            rank,
            confidence: conf,
            map_idx: 0,
        };
        let mut b = a.clone();
        // Nudge one corner by 2px: rank ties within ε, area decides.
        b.quad = Quad::new(
            Point::new(102.0, 120.0),
            Point::new(540.0, 120.0),
            Point::new(540.0, 680.0),
            Point::new(100.0, 680.0),
        );
        let order1 = compare_candidates(&a, &b);
        let order2 = compare_candidates(&a, &b);
        assert_eq!(order1, order2);
        // Identical ranks compare equal-or-ordered stably both ways.
        let c = a.clone();
        assert_eq!(compare_candidates(&a, &c), Ordering::Equal);
        assert_eq!(compare_candidates(&c, &a), Ordering::Equal);
    }

    #[test]
    fn confidence_is_blended_but_honors_gate() {
        let q = Quad::new(
            Point::new(100.0, 120.0),
            Point::new(540.0, 120.0),
            Point::new(540.0, 680.0),
            Point::new(100.0, 680.0),
        );
        let (_, conf) = rank_scores(0.48, 0.9, &q);
        assert!((MIN_EDGE_SUPPORT..=1.0).contains(&conf), "{conf}");
        // Higher support → higher confidence, all else equal.
        let (_, conf_low) = rank_scores(0.48, 0.6, &q);
        assert!(conf > conf_low, "{conf} vs {conf_low}");
    }

    // ---- Bimodality guard + grayscale fallback ----

    fn gray_image_from_hist_peaks(w: u32, h: u32, peaks: &[(u8, f64)]) -> GrayImage {
        // Deterministic synthetic gray image with the requested histogram
        // shape: `peaks` lists (level, fraction). Fractions sum to ~1.
        let mut img = GrayImage::new(w, h);
        let total = (w as usize) * (h as usize);
        let mut idx = 0usize;
        for (level, frac) in peaks {
            let count = ((*frac * total as f64).round() as usize).min(total - idx);
            for _ in 0..count {
                let x = (idx as u32) % w;
                let y = (idx as u32) / w;
                img.put_pixel(x, y, Luma([*level]));
                idx += 1;
            }
        }
        while idx < total {
            let x = (idx as u32) % w;
            let y = (idx as u32) / w;
            img.put_pixel(x, y, Luma([peaks[0].0]));
            idx += 1;
        }
        img
    }

    #[test]
    fn bimodality_guard_accepts_clean_two_tone() {
        let gray = gray_image_from_hist_peaks(100, 100, &[(20, 0.6), (230, 0.4)]);
        let analysis = otsu_analyze(&gray);
        assert!(analysis.bimodal, "two-tone must be bimodal");
    }

    #[test]
    fn bimodality_guard_rejects_uniform_and_low_separation() {
        let uniform = gray_image_from_hist_peaks(64, 64, &[(128, 1.0)]);
        assert!(!otsu_analyze(&uniform).bimodal, "uniform is not bimodal");
        // Means only 10 apart: below the 20-level separation floor.
        let flat = gray_image_from_hist_peaks(64, 64, &[(120, 0.5), (130, 0.5)]);
        assert!(!otsu_analyze(&flat).bimodal, "10-level sep is not bimodal");
    }

    #[test]
    fn grayscale_fallback_path_produces_edges_where_binary_is_blank() {
        // Uniform mid-gray: Otsu binary is blank (no boundary) so the
        // binary edge map is empty. The guard must flag non-bimodal, and
        // the test pins that decision — the fallback trigger — rather
        // than claiming magic detection on featureless input.
        let uniform = gray_image_from_hist_peaks(160, 160, &[(128, 1.0)]);
        let analysis = otsu_analyze(&uniform);
        assert!(!analysis.bimodal);
        let edges_bin = imageproc::edges::canny(&analysis.binary, 40.0, 120.0);
        let bin_count: u32 = edges_bin.pixels().map(|p| u32::from(p.0[0] > 0)).sum();
        assert_eq!(bin_count, 0, "binary of uniform has no edges");
        // A 3px dark frame on the same gray IS gradient-visible after the
        // detection blur: Canny on the grayscale sees it (fallback input),
        // proving the fallback operates on real gradients the blank
        // binary path lost. (1px lines blur below the high threshold.)
        let mut framed = GrayImage::from_pixel(160, 160, Luma([128u8]));
        for x in 28..132 {
            for t in 0..3 {
                framed.put_pixel(x, 28 + t, Luma([0u8]));
                framed.put_pixel(x, 129 + t, Luma([0u8]));
            }
        }
        for y in 28..132 {
            for t in 0..3 {
                framed.put_pixel(28 + t, y, Luma([0u8]));
                framed.put_pixel(129 + t, y, Luma([0u8]));
            }
        }
        let blurred = imageproc::filter::gaussian_blur_f32(&framed, 1.5);
        let edges_gray = imageproc::edges::canny(&blurred, 40.0, 120.0);
        let gray_count: u32 = edges_gray.pixels().map(|p| u32::from(p.0[0] > 0)).sum();
        assert!(gray_count > 50, "framed grayscale must have edges");
    }

    #[test]
    fn fallback_collect_finds_quad_from_grayscale_style_edges() {
        // Helper-level fallback fixture: a white quad border as an edge
        // map (what grayscale Canny yields around a page). The collector
        // — shared by both paths — must fit it with the unchanged gates.
        let (w, h) = (200u32, 200u32);
        let mut edges = GrayImage::new(w, h);
        for x in 40..160 {
            edges.put_pixel(x, 40, Luma([255u8]));
            edges.put_pixel(x, 159, Luma([255u8]));
        }
        for y in 40..160 {
            edges.put_pixel(40, y, Luma([255u8]));
            edges.put_pixel(159, y, Luma([255u8]));
        }
        let support = dilate(&edges, DILATE_RADIUS);
        let contours = contours_from_edges(&edges);
        assert!(!contours.is_empty(), "frame edges yield contours");
        let cands =
            collect_scored_candidates(&contours, &support, w, h, f64::from(w) * f64::from(h), 1);
        assert!(
            !cands.is_empty(),
            "fallback-style edges yield a passing quad"
        );
        assert!(cands[0].confidence >= MIN_EDGE_SUPPORT);
    }

    #[test]
    fn fallback_end_to_end_on_hollow_frame_triggers_guard_and_detects() {
        // Hollow frame: uniform bg + thin dark page border, interior same
        // as bg. The border is <5% of pixels so the Otsu guard flags
        // non-bimodal (fallback runs), yet the high-contrast frame is
        // gradient-clean and the full pipeline must still detect it.
        let (w, h) = (400u32, 400u32);
        let mut img = vec![128u8; w as usize * h as usize * 3];
        let page = Quad::new(
            Point::new(90.0, 80.0),
            Point::new(310.0, 80.0),
            Point::new(310.0, 330.0),
            Point::new(90.0, 330.0),
        );
        for x in 88..313 {
            for t in 0..3 {
                for (px, py) in [(x, 78 + t), (x, 330 + t)] {
                    let o = (py as usize * w as usize + px as usize) * 3;
                    img[o] = 0;
                    img[o + 1] = 0;
                    img[o + 2] = 0;
                }
            }
        }
        for y in 78..333 {
            for t in 0..3 {
                for (px, py) in [(88 + t, y), (310 + t, y)] {
                    let o = (py as usize * w as usize + px as usize) * 3;
                    img[o] = 0;
                    img[o + 1] = 0;
                    img[o + 2] = 0;
                }
            }
        }
        let d = detect_document(&img, w, h)
            .expect("runs")
            .expect("hollow frame detects");
        assert!(d.confidence >= MIN_EDGE_SUPPORT, "{}", d.confidence);
        for (got, want) in d.quad.corners().iter().zip(page.corners().iter()) {
            assert!(got.dist(want) < 14.0, "{got:?} vs {want:?}");
        }
    }

    // ---- 5–8-gon acceptance ----

    fn rounded_rect_loop(
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        r: f64,
        steps_per_corner: usize,
    ) -> Vec<Point> {
        // Perimeter loop of a rounded rectangle (straight edges sampled
        // sparsely, arcs densely) — RDP yields 6–8 vertices.
        let mut pts = Vec::new();
        let corners = [
            ((x1 - r, y0 + r), 270.0, 360.0),
            ((x1 - r, y1 - r), 0.0, 90.0),
            ((x0 + r, y1 - r), 90.0, 180.0),
            ((x0 + r, y0 + r), 180.0, 270.0),
        ];
        // Walk edges + arcs in order starting at top edge.
        for x in [x0 + r, (x0 + x1) / 2.0, x1 - r] {
            pts.push(Point::new(x, y0));
        }
        for (center, a0, a1) in corners {
            for i in 0..=steps_per_corner {
                let a = (a0 + (a1 - a0) * i as f64 / steps_per_corner as f64).to_radians();
                pts.push(Point::new(center.0 + r * a.cos(), center.1 + r * a.sin()));
                if !(a0 == 270.0 && a1 == 360.0) && i == 0 {
                    // interleave straight-edge samples between arcs
                }
            }
            match (a0, a1) {
                (270.0, 360.0) => {
                    for y in [y0 + r, f64::midpoint(y0, y1), y1 - r] {
                        pts.push(Point::new(x1, y));
                    }
                }
                (0.0, 90.0) => {
                    for x in [(x0 + x1) / 2.0, x0 + r] {
                        pts.push(Point::new(x, y1));
                    }
                }
                (90.0, 180.0) => {
                    for y in [y1 - r, f64::midpoint(y0, y1), y0 + r] {
                        pts.push(Point::new(x0, y));
                    }
                }
                _ => {
                    let x = (x0 + x1) / 2.0;
                    pts.push(Point::new(x, y0));
                }
            }
        }
        pts
    }

    #[test]
    fn five_to_eight_gon_fits_rounded_rect() {
        let pts = rounded_rect_loop(100.0, 120.0, 540.0, 680.0, 28.0, 6);
        let quad_pts =
            approx_closed_quad(&pts, 0.02 * poly_perimeter(&pts)).expect("rounded rect fits");
        let quad = order_corners(quad_pts).expect("orders");
        // SAME gates as exact quads — no weakening.
        assert!(validate_quad(&quad, 640.0, 800.0).is_ok());
        let want = Quad::new(
            Point::new(100.0, 120.0),
            Point::new(540.0, 120.0),
            Point::new(540.0, 680.0),
            Point::new(100.0, 680.0),
        );
        for (got, w) in quad.corners().iter().zip(want.corners().iter()) {
            assert!(got.dist(w) < 36.0, "{got:?} vs {w:?}");
        }
    }

    #[test]
    fn five_to_eight_gon_keeps_spiral_kink_out() {
        // Rectangle loop with an extra inward kink on the top edge plus
        // a filler point on the right edge (6 vertices after RDP).
        let poly = vec![
            Point::new(100.0, 120.0),
            Point::new(300.0, 120.0),
            Point::new(320.0, 145.0),
            Point::new(340.0, 120.0),
            Point::new(540.0, 120.0),
            Point::new(540.0, 400.0),
            Point::new(540.0, 680.0),
            Point::new(100.0, 680.0),
        ];
        let quad_pts = fit_quad_from_polygon(&poly).expect("kinked octagon fits");
        let quad = order_corners(quad_pts).expect("orders");
        assert!(validate_quad(&quad, 640.0, 800.0).is_ok());
        // Kink x=320 must not survive as a corner.
        for c in quad.corners() {
            assert!(
                c.dist(&Point::new(320.0, 145.0)) > 20.0,
                "kink leaked into quad: {c:?}"
            );
        }
    }

    #[test]
    fn five_to_eight_gon_recovers_margin_writing_bump() {
        // Margin writing: small outward rectangular bump on the left
        // edge (handwriting touching the border) → 8-gon; the fit must
        // return the outer page, still passing validation.
        let poly = vec![
            Point::new(100.0, 120.0),
            Point::new(540.0, 120.0),
            Point::new(540.0, 680.0),
            Point::new(100.0, 680.0),
            Point::new(100.0, 500.0),
            Point::new(78.0, 500.0),
            Point::new(78.0, 440.0),
            Point::new(100.0, 440.0),
        ];
        let quad_pts = fit_quad_from_polygon(&poly).expect("margin bump fits");
        let quad = order_corners(quad_pts).expect("orders");
        assert!(validate_quad(&quad, 640.0, 800.0).is_ok());
        // Outer left edge x≈100 must win over the bump x=78 excursion on
        // at least three of four corners (bump contributes ≤1 corner).
        let near_bump = quad
            .corners()
            .iter()
            .filter(|p| (p.x - 78.0).abs() < 8.0)
            .count();
        assert!(near_bump <= 1, "bump dominated quad: {quad:?}");
    }

    #[test]
    fn fit_rejects_non_quad_loops() {
        assert!(fit_quad_from_polygon(&[]).is_none());
        assert!(fit_quad_from_polygon(&[Point::new(0.0, 0.0); 3]).is_none());
        // 9+ vertices: not a quad-like loop.
        let many: Vec<Point> = (0..10)
            .map(|i| {
                let a = i as f64 * std::f64::consts::TAU / 10.0;
                Point::new(320.0 + 200.0 * a.cos(), 400.0 + 200.0 * a.sin())
            })
            .collect();
        assert!(fit_quad_from_polygon(&many).is_none());
    }

    #[test]
    fn epsilon_sweep_is_bounded_and_primary_first() {
        assert_eq!(EPSILON_SWEEP_MULTS.len(), 3);
        assert!((EPSILON_SWEEP_MULTS[0] - 1.0).abs() < 1e-12);
        // Rectangle converges at the primary epsilon already.
        let mut loop_pts = Vec::new();
        for x in (0..440).step_by(4) {
            loop_pts.push(Point::new(100.0 + x as f64, 120.0));
        }
        for y in (0..560).step_by(4) {
            loop_pts.push(Point::new(540.0, 120.0 + y as f64));
        }
        for x in (0..440).rev().step_by(4) {
            loop_pts.push(Point::new(100.0 + x as f64, 680.0));
        }
        for y in (0..560).rev().step_by(4) {
            loop_pts.push(Point::new(100.0, 120.0 + y as f64));
        }
        let perim = poly_perimeter(&loop_pts);
        assert!(approx_closed_quad(&loop_pts, RDP_EPSILON_FRAC * perim).is_some());
    }

    // ---- Field-scene fixtures (F-21 bedsheet wave, 2026-10-03) ----
    //
    // Synthetic replicas of the reported field scene and its isolations:
    // patterned bedsheet (trimodal histogram), open-book soft fold,
    // handwriting-dense paper, frame-touching page (H-A contact kill).

    /// Deterministic per-pixel noise (no rand dependency in tests).
    fn noise(x: u32, y: u32) -> u8 {
        ((x * 7919 + y * 104729) % 23) as u8
    }

    /// Bounds-checked pixel write (fixture drawing only).
    fn px_put(img: &mut [u8], w: u32, x: i32, y: i32, rgb: [u8; 3]) {
        if x < 0 || y < 0 {
            return;
        }
        let (x, y) = (x as u32, y as u32);
        let o = (y as usize * w as usize + x as usize) * 3;
        if o + 3 <= img.len() {
            img[o] = rgb[0];
            img[o + 1] = rgb[1];
            img[o + 2] = rgb[2];
        }
    }

    /// Deterministic 2D hash (fixture texture/dash pattern only).
    fn hash2(x: i32, y: i32) -> u32 {
        ((x as u32).wrapping_mul(374_761_393) ^ (y as u32).wrapping_mul(668_265_263))
            .wrapping_mul(1_274_126_177)
            >> 8
    }

    /// Filled disc (cartoon patch / curl blob).
    fn draw_disc(img: &mut [u8], w: u32, cx: i32, cy: i32, r: i32, rgb: [u8; 3]) {
        for dy in -r..=r {
            for dx in -r..=r {
                if dx * dx + dy * dy <= r * r {
                    px_put(img, w, cx + dx, cy + dy, rgb);
                }
            }
        }
    }

    /// Chunky plus+diamond star (bedsheet pattern motif).
    fn draw_star(img: &mut [u8], w: u32, cx: i32, cy: i32, r: i32, rgb: [u8; 3]) {
        let t = (r / 4).max(1);
        for d in -r..=r {
            for k in -t..=t {
                px_put(img, w, cx + d, cy + k, rgb);
                px_put(img, w, cx + k, cy + d, rgb);
            }
        }
        let q = (r as f64 * 0.7) as i32;
        for dy in -q..=q {
            for dx in -q..=q {
                if dx.abs() + dy.abs() <= q {
                    px_put(img, w, cx + dx, cy + dy, rgb);
                }
            }
        }
    }

    /// Dashed ink strokes inside a quad — pen-like handwriting density.
    /// `cov` is the on-stroke fraction along each ruled line. Text keeps
    /// a small margin from the paper edge (the fixtures model boundary
    /// interference separately via margin scribbles).
    fn write_handwriting(
        img: &mut [u8],
        w: u32,
        q: &Quad,
        ink: [u8; 3],
        step: u32,
        thick: u32,
        cov: u32,
    ) {
        let c = q.corners();
        let y0 = c.iter().map(|p| p.y).fold(f64::INFINITY, f64::min) as i32;
        let y1 = c.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max) as i32;
        for y in (y0 + 12..y1 - 8).step_by(step as usize) {
            for t in 0..thick {
                for x in 0..w as i32 {
                    let p = Point::new(f64::from(x) + 0.5, f64::from(y) + f64::from(t) + 0.5);
                    let inside_margin = point_in_convex(&p, &c)
                        && (0..4).all(|i| point_line_dist(&p, &c[i], &c[(i + 1) % 4]) > 6.0);
                    if inside_margin && hash2(x / 5, y) % 100 < cov {
                        px_put(img, w, x, y + t as i32, ink);
                    }
                }
            }
        }
    }

    #[test]
    fn detects_open_notebook_on_patterned_bedsheet() {
        // Field report 2026-10-03: open notebook (two-page spread, center
        // gutter, handwritten ink, slightly tilted, curling corners) on a
        // bright patterned bedsheet — pink/red base with yellow stars AND
        // light cartoon patches whose luma competes with paper — under a
        // soft hand/phone shadow. Trimodal histogram (research §11 H-B):
        // global Otsu must not split lit-vs-shadowed and lose the spread.
        let (img, w, h, outer) = bedsheet_fixture();
        let d = detect_document(&img, w, h)
            .expect("runs")
            .expect("detects spread on patterned sheet");
        for (got, want) in d.quad.corners().iter().zip(outer.corners().iter()) {
            assert!(got.dist(want) < 36.0, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn detects_open_notebook_on_patterned_bedsheet_at_live_scales() {
        // The field report comes from the LIVE guidance path, which
        // detects ~160px camera frames. At camera-frame scale the
        // gutter, ink and patch detail compress into a few pixels each
        // and the trimodal split tightens; 320px is the new live tick
        // size. Both run at NATIVE resolution (detection never
        // upscales), so tolerances are absolute at each size.
        let (big, bw, bh, outer) = bedsheet_fixture();
        let flat = rgb_samples(&big, bw, bh);
        let view = flat.as_view::<Rgb<u8>>().expect("view");
        let cases = [
            // 160px long edge: detail-starved (shadowed lower-right
            // paper sits at pattern luma after the 5x compress). The
            // live pill only needs "found a page": the baseline returns
            // a valid quad with three corners on the page and the
            // shadow side cut short. Pinned as presence + a tolerance
            // that only rejects gross drift, not the baseline cut.
            ((128u32, 160u32), 40.0),
            // 320px: the current/growing live tick size — full corner
            // accuracy expected.
            ((256u32, 320u32), 10.0),
        ];
        for ((w, h), tol) in cases {
            let small = imageops::resize(&view, w, h, imageops::FilterType::Triangle);
            let img = small.as_raw().clone();
            let s = f64::from(w) / f64::from(bw);
            let scale_p = |p: Point| Point::new(p.x * s, p.y * s);
            let q = Quad::new(
                scale_p(outer.tl),
                scale_p(outer.tr),
                scale_p(outer.br),
                scale_p(outer.bl),
            );
            let d = detect_document(&img, w, h)
                .expect("runs")
                .expect("detects spread at live scale");
            for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
                assert!(got.dist(want) < tol, "{w}x{h}: {got:?} vs {want:?}");
            }
        }
    }

    /// The field-report scene (see the test above): returns the RGB
    /// buffer, dims, and the ground-truth spread quad.
    fn bedsheet_fixture() -> (Vec<u8>, u32, u32, Quad) {
        let (w, h) = (640u32, 800u32);
        let outer = Quad::new(
            Point::new(96.0, 150.0),
            Point::new(556.0, 118.0),
            Point::new(578.0, 672.0),
            Point::new(84.0, 700.0),
        );
        let mut img = vec![0u8; w as usize * h as usize * 3];
        // Pink/red bedsheet base + sensor noise.
        for y in 0..h {
            for x in 0..w {
                let n = noise(x, y) / 3;
                let o = (y as usize * w as usize + x as usize) * 3;
                img[o] = 206u8.saturating_add(n);
                img[o + 1] = 92u8.saturating_add(n);
                img[o + 2] = 112u8.saturating_add(n);
            }
        }
        // Yellow stars (luma ~200) scattered on the sheet.
        for (sx, sy) in [
            (60, 60),
            (320, 60),
            (580, 70),
            (46, 400),
            (610, 380),
            (140, 760),
            (420, 770),
            (600, 720),
        ] {
            draw_star(&mut img, w, sx, sy, 22, [236, 216, 96]);
        }
        // Light cartoon patches (luma ~228) — paper-competitive in Otsu.
        // Several sit within a few px of the spread edge so bridging and
        // blob-merging mistakes are exercised too.
        for (px, py, pr) in [
            (300, 112, 20),
            (575, 260, 24),
            (60, 560, 22),
            (330, 748, 26),
            (200, 60, 18),
            (612, 560, 20),
        ] {
            draw_disc(&mut img, w, px, py, pr, [230, 224, 228]);
        }
        // The spread: white-ish paper on top of the sheet.
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if point_in_convex(&p, &outer.corners()) {
                    let n = noise(x, y) / 6;
                    let o = (y as usize * w as usize + x as usize) * 3;
                    img[o] = 238u8.saturating_sub(n);
                    img[o + 1] = 236u8.saturating_sub(n);
                    img[o + 2] = 231u8.saturating_sub(n);
                }
            }
        }
        // Soft center gutter: smooth shading valley along the fold line
        // (top-edge mid to bottom-edge mid), no hard spine bar.
        let (gx0, gy0) = (326.0f64, 134.0f64);
        let (gx1, gy1) = (331.0f64, 686.0f64);
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if !point_in_convex(&p, &outer.corners()) {
                    continue;
                }
                let t = ((p.y - gy0) / (gy1 - gy0)).clamp(0.0, 1.0);
                let gx = (gx1 - gx0).mul_add(t, gx0);
                let d = (p.x - gx).abs();
                if d < 16.0 {
                    let shade = (46.0 * (1.0 - d / 16.0)) as u8;
                    let o = (y as usize * w as usize + x as usize) * 3;
                    img[o] = img[o].saturating_sub(shade);
                    img[o + 1] = img[o + 1].saturating_sub(shade);
                    img[o + 2] = img[o + 2].saturating_sub(shade);
                }
            }
        }
        // Handwritten ink across both pages: dense enough to compete
        // with the paper-vs-background split in the global histogram
        // (research §11 H-B) without erasing the silhouette.
        write_handwriting(&mut img, w, &outer, [64, 58, 62], 12, 4, 78);
        // Curl shading at the bottom corners: a curled corner darkens
        // the paper inside the silhouette — it does not eat the edge.
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if !point_in_convex(&p, &outer.corners()) {
                    continue;
                }
                for (cx, cy, r) in [(96.0, 690.0, 44.0), (566.0, 662.0, 40.0)] {
                    let d = ((p.x - cx).powi(2) + (p.y - cy).powi(2)).sqrt();
                    if d < r {
                        let shade = (26.0 * (1.0 - d / r)) as u8;
                        let o = (y as usize * w as usize + x as usize) * 3;
                        img[o] = img[o].saturating_sub(shade);
                        img[o + 1] = img[o + 1].saturating_sub(shade);
                        img[o + 2] = img[o + 2].saturating_sub(shade);
                    }
                }
            }
        }
        // Soft hand/phone shadow across the lower right of sheet AND
        // spread: shadowed paper falls to sheet brightness, the H-B
        // "shadow makes the histogram trimodal" mode where global Otsu
        // splits lit-vs-shadowed and loses half the page.
        for y in 0..h {
            for x in 0..w {
                let d = 0.6 * f64::from(x) + 0.8 * f64::from(y);
                let shade = ((d - 540.0) / 220.0).clamp(0.0, 1.0) * 0.35;
                if shade > 0.0 {
                    let o = (y as usize * w as usize + x as usize) * 3;
                    for c in &mut img[o..o + 3] {
                        *c = (f64::from(*c) * (1.0 - shade)).round() as u8;
                    }
                }
            }
        }
        (img, w, h, outer)
    }

    #[test]
    fn detects_open_spread_with_soft_fold() {
        // Soft fold (gradual shading valley, no hard spine): Otsu cuts the
        // valley mid-slope and the binary splits into two page halves.
        // The halves must reunite into the outer spread boundary even
        // when their fitted quads overlap slightly at the fold.
        let (w, h) = (640u32, 800u32);
        let outer = Quad::new(
            Point::new(90.0, 130.0),
            Point::new(550.0, 120.0),
            Point::new(560.0, 672.0),
            Point::new(100.0, 682.0),
        );
        let mut img = vec![0u8; w as usize * h as usize * 3];
        for y in 0..h {
            for x in 0..w {
                let n = noise(x, y) / 3;
                let o = (y as usize * w as usize + x as usize) * 3;
                img[o] = 152u8.saturating_sub(n);
                img[o + 1] = 149u8.saturating_sub(n);
                img[o + 2] = 146u8.saturating_sub(n);
            }
        }
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if !point_in_convex(&p, &outer.corners()) {
                    continue;
                }
                let o = (y as usize * w as usize + x as usize) * 3;
                let n = noise(x, y) / 6;
                img[o] = 236u8.saturating_sub(n);
                img[o + 1] = 234u8.saturating_sub(n);
                img[o + 2] = 229u8.saturating_sub(n);
            }
        }
        // Smooth cosine shading valley across the fold: paper 236 → 108
        // at the core → 236 over ±14px. Soft, but dark enough that the
        // global threshold separates the halves.
        let (gx0, gx1) = (322.0f64, 330.0f64);
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if !point_in_convex(&p, &outer.corners()) {
                    continue;
                }
                let t = ((p.y - 125.0) / (677.0 - 125.0)).clamp(0.0, 1.0);
                let gx = (gx1 - gx0).mul_add(t, gx0);
                let d = (p.x - gx).abs();
                if d < 14.0 {
                    let k = (std::f64::consts::PI * (1.0 - d / 14.0) / 2.0).cos();
                    let shade = (128.0 * k) as u8;
                    let o = (y as usize * w as usize + x as usize) * 3;
                    img[o] = img[o].saturating_sub(shade);
                    img[o + 1] = img[o + 1].saturating_sub(shade);
                    img[o + 2] = img[o + 2].saturating_sub(shade);
                }
            }
        }
        write_handwriting(&mut img, w, &outer, [70, 66, 68], 22, 3, 40);

        let d = detect_document(&img, w, h)
            .expect("runs")
            .expect("detects soft-fold spread");
        // Outer spread found (not one of the halves): full width expected.
        let width = d.quad.tr.dist(&d.quad.tl);
        assert!(width > 380.0, "got half page instead of spread: {width}");
        for (got, want) in d.quad.corners().iter().zip(outer.corners().iter()) {
            assert!(got.dist(want) < 32.0, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn detects_handwriting_dense_page() {
        // Ink competes with the paper-vs-desk split inside the global
        // histogram (research §11 H-B handwriting mode): ~35% ink
        // coverage plus margin writing crossing the left edge.
        let (w, h) = (640u32, 800u32);
        let q = Quad::new(
            Point::new(130.0, 110.0),
            Point::new(520.0, 140.0),
            Point::new(500.0, 700.0),
            Point::new(110.0, 660.0),
        );
        let mut img = vec![0u8; w as usize * h as usize * 3];
        for y in 0..h {
            for x in 0..w {
                let n = noise(x, y) / 3;
                let o = (y as usize * w as usize + x as usize) * 3;
                img[o] = 118u8.saturating_add(n);
                img[o + 1] = 116u8.saturating_add(n);
                img[o + 2] = 112u8.saturating_add(n);
            }
        }
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if point_in_convex(&p, &q.corners()) {
                    let n = noise(x, y) / 6;
                    let o = (y as usize * w as usize + x as usize) * 3;
                    img[o] = 232u8.saturating_sub(n);
                    img[o + 1] = 230u8.saturating_sub(n);
                    img[o + 2] = 225u8.saturating_sub(n);
                }
            }
        }
        // Dense ruled ink + margin scribbles crossing the left edge:
        // ~35%+ coverage so ink competes with the paper-vs-desk split
        // inside the global histogram (research §11 H-B handwriting).
        write_handwriting(&mut img, w, &q, [58, 54, 58], 10, 4, 78);
        for y in (200..640).step_by(26) {
            for x in 100..132 {
                if hash2(x, y / 4) % 100 < 55 {
                    px_put(&mut img, w, x, y, [58, 54, 58]);
                    px_put(&mut img, w, x, y + 1, [58, 54, 58]);
                }
            }
        }
        let d = detect_document(&img, w, h)
            .expect("runs")
            .expect("detects dense handwriting page");
        for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
            assert!(got.dist(want) < 30.0, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn detects_frame_touching_page() {
        // H-A contact kill: the page's left edge lies ON the frame edge,
        // so its boundary ring is cut off at x=0 and no closed contour
        // exists at all. The page is still ≥5% and ≤99% of the frame and
        // must be found.
        let (w, h) = (640u32, 800u32);
        let q = Quad::new(
            Point::new(0.0, 100.0),
            Point::new(380.0, 100.0),
            Point::new(380.0, 700.0),
            Point::new(0.0, 700.0),
        );
        let mut img = vec![0u8; w as usize * h as usize * 3];
        for y in 0..h {
            for x in 0..w {
                let n = noise(x, y) / 3;
                let o = (y as usize * w as usize + x as usize) * 3;
                img[o] = 42u8.saturating_add(n);
                img[o + 1] = 40u8.saturating_add(n);
                img[o + 2] = 38u8.saturating_add(n);
            }
        }
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if point_in_convex(&p, &q.corners()) {
                    let n = noise(x, y) / 6;
                    let o = (y as usize * w as usize + x as usize) * 3;
                    img[o] = 234u8.saturating_sub(n);
                    img[o + 1] = 232u8.saturating_sub(n);
                    img[o + 2] = 228u8.saturating_sub(n);
                }
            }
        }
        write_handwriting(&mut img, w, &q, [66, 62, 64], 20, 3, 45);

        let d = detect_document(&img, w, h)
            .expect("runs")
            .expect("detects frame-touching page");
        for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
            assert!(got.dist(want) < 26.0, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn detects_frame_touching_page_on_bright_background() {
        // Polarity flip of the contact case: dark-ish page against a
        // bright desk, bottom edge flush with the frame. Whichever
        // polarity is the "white" Otsu class, the cut ring must close.
        let (w, h) = (640u32, 800u32);
        let q = Quad::new(
            Point::new(120.0, 140.0),
            Point::new(540.0, 120.0),
            Point::new(560.0, 800.0),
            Point::new(100.0, 800.0),
        );
        let mut img = vec![0u8; w as usize * h as usize * 3];
        for y in 0..h {
            for x in 0..w {
                let n = noise(x, y) / 3;
                let o = (y as usize * w as usize + x as usize) * 3;
                img[o] = 226u8.saturating_sub(n);
                img[o + 1] = 224u8.saturating_sub(n);
                img[o + 2] = 218u8.saturating_sub(n);
            }
        }
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if point_in_convex(&p, &q.corners()) {
                    let n = noise(x, y) / 6;
                    let o = (y as usize * w as usize + x as usize) * 3;
                    img[o] = 148u8.saturating_sub(n);
                    img[o + 1] = 146u8.saturating_sub(n);
                    img[o + 2] = 142u8.saturating_sub(n);
                }
            }
        }
        write_handwriting(&mut img, w, &q, [72, 70, 74], 22, 3, 35);

        let d = detect_document(&img, w, h)
            .expect("runs")
            .expect("detects bright-side frame-touching page");
        for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
            assert!(got.dist(want) < 30.0, "{got:?} vs {want:?}");
        }
    }

    // ---- Recall-sweep fixtures (2026-10-03, background-detect wave) ----
    //
    // The reported scene class (open notebook on a patterned bedsheet)
    // isolated into the remaining recall weaknesses: high-frequency
    // pattern edges hugging the page border, the gutter/spine split,
    // slight rotation, and a page NEAR (not touching) the frame edge.

    #[test]
    fn detects_page_with_high_frequency_stripes_hugging_border() {
        // Busy cloth: 3px diagonal stripes whose bright phase (224–252)
        // reaches past paper luma (~236), so Otsu cannot fully separate
        // pattern from page and texture blobs fuse into the page ring.
        // The pattern sits right against the border — a drifted quad
        // would happily ride a stripe. The page must still win.
        let (w, h) = (640u32, 800u32);
        let q = Quad::new(
            Point::new(130.0, 120.0),
            Point::new(520.0, 100.0),
            Point::new(545.0, 660.0),
            Point::new(105.0, 690.0),
        );
        let mut img = vec![0u8; w as usize * h as usize * 3];
        for y in 0..h {
            for x in 0..w {
                let stripe = ((x + 2 * y) / 3) % 2 == 0;
                let base = if stripe { 112u8 } else { 224 };
                let n = (hash2(x as i32, y as i32) % 28) as u8;
                let v = base.saturating_add(n);
                let o = (y as usize * w as usize + x as usize) * 3;
                img[o] = v;
                img[o + 1] = v.saturating_sub(6);
                img[o + 2] = v.saturating_sub(12);
            }
        }
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if point_in_convex(&p, &q.corners()) {
                    let n = noise(x, y) / 6;
                    let o = (y as usize * w as usize + x as usize) * 3;
                    img[o] = 236u8.saturating_sub(n);
                    img[o + 1] = 234u8.saturating_sub(n);
                    img[o + 2] = 229u8.saturating_sub(n);
                }
            }
        }
        write_handwriting(&mut img, w, &q, [64, 58, 62], 14, 3, 60);

        let d = detect_document(&img, w, h)
            .expect("runs")
            .expect("detects page on high-frequency stripes");
        for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
            assert!(got.dist(want) < 24.0, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn detects_slightly_rotated_notebook_gutter_on_patterned_sheet() {
        // ~9° rotated spread with a visible gutter line on a patterned
        // sheet. The gutter splits the Otsu binary into two page halves;
        // the outer boundary must win (directly or via the spine merge),
        // never a single half.
        let (w, h) = (640u32, 800u32);
        let outer = Quad::new(
            Point::new(120.0, 96.0),
            Point::new(556.0, 168.0),
            Point::new(500.0, 720.0),
            Point::new(64.0, 648.0),
        );
        let mut img = vec![0u8; w as usize * h as usize * 3];
        // Patterned sheet: pink base + speckle + stars/patches.
        for y in 0..h {
            for x in 0..w {
                let n = noise(x, y) / 3;
                let o = (y as usize * w as usize + x as usize) * 3;
                img[o] = 202u8.saturating_add(n);
                img[o + 1] = 92u8.saturating_add(n);
                img[o + 2] = 110u8.saturating_add(n);
            }
        }
        for (sx, sy) in [(70, 90), (560, 120), (90, 700), (580, 690), (320, 50)] {
            draw_star(&mut img, w, sx, sy, 22, [236, 216, 96]);
        }
        for (px, py, pr) in [(90, 380, 20), (560, 420, 22), (300, 760, 24)] {
            draw_disc(&mut img, w, px, py, pr, [230, 224, 228]);
        }
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if point_in_convex(&p, &outer.corners()) {
                    let n = noise(x, y) / 6;
                    let o = (y as usize * w as usize + x as usize) * 3;
                    img[o] = 237u8.saturating_sub(n);
                    img[o + 1] = 235u8.saturating_sub(n);
                    img[o + 2] = 230u8.saturating_sub(n);
                }
            }
        }
        // Gutter: dark band along the fold line joining the two edge
        // midpoints (top mid → bottom mid).
        let top_mid = Point::new(
            (outer.tl.x + outer.tr.x) / 2.0,
            (outer.tl.y + outer.tr.y) / 2.0,
        );
        let bot_mid = Point::new(
            (outer.bl.x + outer.br.x) / 2.0,
            (outer.bl.y + outer.br.y) / 2.0,
        );
        let dx = bot_mid.x - top_mid.x;
        let dy = bot_mid.y - top_mid.y;
        let len = dx.hypot(dy).max(1e-9);
        let nx = -dy / len;
        let ny = dx / len;
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if !point_in_convex(&p, &outer.corners()) {
                    continue;
                }
                let t = ((p.x - top_mid.x) * dx + (p.y - top_mid.y) * dy) / (len * len);
                if !(0.0..=1.0).contains(&t) {
                    continue;
                }
                let d = (p.x - top_mid.x) * nx + (p.y - top_mid.y) * ny;
                if d.abs() < 7.0 {
                    let shade = (58.0 * (1.0 - d.abs() / 7.0)) as u8;
                    let o = (y as usize * w as usize + x as usize) * 3;
                    img[o] = img[o].saturating_sub(shade);
                    img[o + 1] = img[o + 1].saturating_sub(shade);
                    img[o + 2] = img[o + 2].saturating_sub(shade);
                }
            }
        }
        write_handwriting(&mut img, w, &outer, [66, 60, 64], 13, 3, 62);

        let d = detect_document(&img, w, h)
            .expect("runs")
            .expect("detects rotated spread with gutter");
        let width = d.quad.tr.dist(&d.quad.tl);
        assert!(width > 360.0, "got half page instead of spread: {width}");
        for (got, want) in d.quad.corners().iter().zip(outer.corners().iter()) {
            assert!(got.dist(want) < 34.0, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn detects_page_near_but_not_touching_frame_edge() {
        // H-A contact-adjacent: the page's left edge sits 3px inside the
        // frame and the bottom edge 3px inside — close enough that the
        // pad+stroke runway and Canny's zero border nearly swallow the
        // edge, but no contact. The page must be found with corners on
        // the page, not on the frame.
        let (w, h) = (640u32, 800u32);
        let q = Quad::new(
            Point::new(3.0, 100.0),
            Point::new(430.0, 100.0),
            Point::new(430.0, 796.0),
            Point::new(3.0, 796.0),
        );
        let mut img = vec![0u8; w as usize * h as usize * 3];
        for y in 0..h {
            for x in 0..w {
                let n = noise(x, y) / 3;
                let o = (y as usize * w as usize + x as usize) * 3;
                img[o] = 46u8.saturating_add(n);
                img[o + 1] = 43u8.saturating_add(n);
                img[o + 2] = 40u8.saturating_add(n);
            }
        }
        for y in 0..h {
            for x in 0..w {
                let p = Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                if point_in_convex(&p, &q.corners()) {
                    let n = noise(x, y) / 6;
                    let o = (y as usize * w as usize + x as usize) * 3;
                    img[o] = 234u8.saturating_sub(n);
                    img[o + 1] = 232u8.saturating_sub(n);
                    img[o + 2] = 227u8.saturating_sub(n);
                }
            }
        }
        write_handwriting(&mut img, w, &q, [66, 62, 64], 20, 3, 45);

        let d = detect_document(&img, w, h)
            .expect("runs")
            .expect("detects page near frame edge");
        for (got, want) in d.quad.corners().iter().zip(q.corners().iter()) {
            assert!(got.dist(want) < 14.0, "{got:?} vs {want:?}");
        }
    }
}
