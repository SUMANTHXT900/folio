//! WASM glue for `folio-scan` (M2).
//!
//! Compiled only for `wasm32-unknown-unknown` (see `Cargo.toml` target
//! deps). Thin translation over [`crate::pipeline`]: bytes in, JSON
//! control plane + output bytes out. No detection/warp semantics here —
//! the M1 core owns them unchanged.
//!
//! Envelope convention (mirrors `folio-wasm`, scan-flavored):
//!
//! ```text
//! scan_process(input: Vec<u8>, mode: &str, detect_only: bool)
//!   → { result_json: string, output: Uint8Array | null }
//!
//! result_json = {
//!   status: "processed" | "detected" | "original" | "error",
//!   width, height, mode,
//!   corners: [[x,y] × 4] | null, confidence: number,
//!   reason?: "no-document-detected",            // status "original"
//!   code?: string, message?: string             // status "error"
//! }
//! ```
//!
//! `detect_only` is the live-guidance fast path: detection runs, warp and
//! JPEG encoding do not (`status: "detected"`, `output: null`). The
//! shutter always uses the full pipeline.
//!
//! `scan_process_with_quad` re-warps caller-supplied quads (crop review):
//! same `processed` / `error` envelope shape, no `detect_only`, no
//! `original` fallback. Corners stay in full-resolution capture pixels.
//!
//! "No document detected" is NOT an error: it returns status
//! `"original"` with `output: null`, and the caller falls back to the
//! input bytes it already holds. Only malformed inputs and internal
//! failures are errors.

use serde_json::json;
use wasm_bindgen::prelude::*;

use crate::enhance::ScanMode;
use crate::error::{ScanError, ScanErrorKind};
use crate::geometry::{order_corners, validate_quad, Point};
use crate::pipeline::{scan_document, ScanRequest, MAX_OUTPUT_LONG_EDGE};
use crate::warp::warp_to_jpeg;

/// Installs readable panic messages; idempotent.
#[wasm_bindgen]
pub fn scan_init() {
    console_error_panic_hook::set_once();
}

/// Runs one scan job over owned image bytes.
///
/// `input`: JPEG/PNG bytes. Ownership moves into WASM (wasm-bindgen
/// copies the JS buffer once, straight into the owned `Vec` — no second
/// copy).
/// `mode`: `"original" | "grayscale" | "blackwhite"` (see
/// [`ScanMode::parse`]).
/// `detect_only`: skip warp + JPEG; answer with status `"detected"` and
/// no output bytes (live guidance).
///
/// Returns the envelope object described above. Engine errors surface as
/// a JS throw carrying a short code string — transport failure, not scan
/// semantics.
#[wasm_bindgen]
pub fn scan_process(input: Vec<u8>, mode: &str, detect_only: bool) -> Result<JsValue, JsValue> {
    let mode = ScanMode::parse(mode).ok_or_else(|| {
        JsValue::from_str("unknown scan mode (expected original|grayscale|blackwhite)")
    })?;
    let mode_name = mode_name(mode);
    let outcome = scan_document(&ScanRequest {
        bytes: input,
        mode,
        detect_only,
    });
    let output = match outcome {
        Ok(done) => {
            let corners = done.corners.map(|cs| {
                cs.iter()
                    .map(|p| json!([round1(p.x), round1(p.y)]))
                    .collect::<Vec<_>>()
            });
            if done.fallback {
                return Ok(envelope(
                    &json!({
                        "status": "original",
                        "width": done.width,
                        "height": done.height,
                        "mode": mode_name,
                        "corners": null,
                        "confidence": 0.0,
                        "reason": "no-document-detected",
                    }),
                    None,
                ));
            }
            if detect_only {
                // Live guidance: corners/confidence only — never bytes.
                return Ok(envelope(
                    &json!({
                        "status": "detected",
                        "width": done.width,
                        "height": done.height,
                        "mode": mode_name,
                        "corners": corners,
                        "confidence": round3(done.confidence),
                    }),
                    None,
                ));
            }
            let bytes = done.bytes;
            let envelope = json!({
                "status": "processed",
                "width": done.width,
                "height": done.height,
                "mode": mode_name,
                "corners": corners,
                "confidence": round3(done.confidence),
            });
            (envelope, Some(bytes))
        }
        Err(err) => {
            let code = match err.kind() {
                ScanErrorKind::InvalidInput => "invalid-input",
                ScanErrorKind::UnsupportedDimensions => "unsupported-dimensions",
                ScanErrorKind::NoDocument => "no-document",
                ScanErrorKind::WarpFailed => "warp-failed",
                ScanErrorKind::EncodeFailed => "encode-failed",
            };
            // NoDocument from validation paths is still a hard error here
            // (detection-absence returns fallback before it can surface);
            // the caller's fallback branch keys on status, not absence.
            return Ok(envelope(
                &json!({
                    "status": "error",
                    "code": code,
                    "message": err.message(),
                }),
                None,
            ));
        }
    };
    Ok(envelope(&output.0, output.1))
}

/// Re-warps owned image bytes with a caller-supplied quad (crop review).
///
/// `input`: same JPEG/PNG bytes as [`scan_process`] (ownership moves in).
/// `quad`: four corners in FULL-RESOLUTION capture pixel coordinates —
/// the same space as `result.corners` and the `warp_quad` input.
/// `[{x, y} × 4]` (the worker's shape) or `[[x, y] × 4]` pairs (the
/// glue's own corner shape) are accepted; anything else is an
/// `invalid-input` error envelope.
///
/// The product scans in color only (no mode knob — the shutter's
/// `Original` path), so this runs the identical warp→JPEG step the
/// shutter runs for `Original` (same long-edge cap, same JPEG quality):
/// behavior is byte-comparable with a shutter scan of the same quad,
/// though callers must not assume byte-identity (detection rounding,
/// encoder state).
///
/// Validation uses the existing [`ScanError`] path — never warps garbage:
/// malformed/non-finite points and out-of-bounds corners are
/// `InvalidInput`; degenerate quads (duplicates, non-convex winding via
/// [`validate_quad`]) surface as the validator reports them. There is no
/// `original` fallback here: the caller already holds the bytes.
///
/// Returns the `processed` envelope (`width`, `height`, `mode`,
/// `corners` echoing the ordered quad, `confidence: 1.0` for the
/// user-confirmed quad) plus the output JPEG bytes.
#[wasm_bindgen]
pub fn scan_process_with_quad(input: Vec<u8>, quad: JsValue) -> Result<JsValue, JsValue> {
    match rewarp_document(&input, &quad) {
        Ok((value, bytes)) => Ok(envelope(&value, Some(bytes))),
        Err(err) => {
            let code = match err.kind() {
                ScanErrorKind::InvalidInput => "invalid-input",
                ScanErrorKind::UnsupportedDimensions => "unsupported-dimensions",
                ScanErrorKind::NoDocument => "no-document",
                ScanErrorKind::WarpFailed => "warp-failed",
                ScanErrorKind::EncodeFailed => "encode-failed",
            };
            Ok(envelope(
                &json!({
                    "status": "error",
                    "code": code,
                    "message": err.message(),
                }),
                None,
            ))
        }
    }
}

/// Rewarp core: parse → decode → normalize → bounds → validate → warp.
/// Each stage rejects through [`ScanError`]; the caller maps kinds to the
/// envelope's `code` exactly like [`scan_process`].
fn rewarp_document(
    input: &[u8],
    quad: &JsValue,
) -> Result<(serde_json::Value, Vec<u8>), ScanError> {
    let points = parse_rewarp_quad(quad)?;
    let rgb = decode_rewarp_input(input)?;
    let (w, h) = (rgb.width(), rgb.height());
    // Normalize winding first: rejects duplicates/ambiguity, and lets
    // the bounds + convexity gates below assume tl→tr→br→bl order.
    let ordered = order_corners(points)?;
    for (i, p) in ordered.corners().iter().enumerate() {
        if !(0.0..=f64::from(w)).contains(&p.x) || !(0.0..=f64::from(h)).contains(&p.y) {
            return Err(ScanError::new(
                ScanErrorKind::InvalidInput,
                "rewrap quad corner is outside the image bounds",
            )
            .with_details(format!("index={i} x={} y={} image={w}x{h}", p.x, p.y)));
        }
    }
    // Same geometric gate detection passed (convexity, angles, area).
    validate_quad(&ordered, f64::from(w), f64::from(h))?;
    // Identical warp→JPEG step as the shutter's Original path.
    //
    // Resolution fidelity: the FULL capture bytes were decoded above at
    // native size and the warp runs at the quad's own native resolution
    // (`warp::output_dims` caps at 3600 but never downscales a region
    // below its own pixel count). No verify-preview path exists
    // in this crate — that downscale lives app-side and only feeds the
    // debounced preview URL, never accepted pages — and the long-edge
    // cap is applied exactly once, here.
    let (bytes, out_w, out_h) = warp_to_jpeg(rgb.as_raw(), w, h, &ordered, MAX_OUTPUT_LONG_EDGE)?;
    let corners = ordered
        .corners()
        .iter()
        .map(|p| json!([round1(p.x), round1(p.y)]))
        .collect::<Vec<_>>();
    let value = json!({
        "status": "processed",
        "width": out_w,
        "height": out_h,
        "mode": "original",
        "corners": corners,
        // User-confirmed quad, not earned detection: fixed at full.
        "confidence": 1.0,
    });
    Ok((value, bytes))
}

/// Parses a rewrap quad from JS: `[{x, y} × 4]` or `[[x, y] × 4]`.
/// Non-finite coordinates degrade to `null` under `JSON.stringify`, so
/// they (and every other non-numeric shape) fail here as `InvalidInput`.
/// Degeneracy (duplicates, non-convex winding) is rejected downstream by
/// `order_corners` / `validate_quad`, not here.
fn parse_rewarp_quad(quad: &JsValue) -> Result<[Point; 4], ScanError> {
    let invalid = |details: String| {
        ScanError::new(
            ScanErrorKind::InvalidInput,
            "rewrap quad must be four {x, y} points in capture pixel coordinates",
        )
        .with_details(details)
    };
    let text = js_sys::JSON::stringify(quad)
        .ok()
        .and_then(|v| v.as_string())
        .ok_or_else(|| invalid("quad is not JSON-serializable".to_string()))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|err| invalid(err.to_string()))?;
    let entries = match value.as_array() {
        Some(entries) if entries.len() == 4 => entries,
        _ => return Err(invalid("expected an array of four points".to_string())),
    };
    let mut points = [Point::new(0.0, 0.0); 4];
    for (i, entry) in entries.iter().enumerate() {
        let (x, y) = if let Some(pair) = entry.as_array() {
            if pair.len() != 2 {
                return Err(invalid(format!("index={i}: expected [x, y]")));
            }
            (pair[0].as_f64(), pair[1].as_f64())
        } else {
            (
                entry.get("x").and_then(|v| v.as_f64()),
                entry.get("y").and_then(|v| v.as_f64()),
            )
        };
        match (x, y) {
            (Some(x), Some(y)) => points[i] = Point::new(x, y),
            _ => return Err(invalid(format!("index={i}: non-numeric coordinates"))),
        }
    }
    Ok(points)
}

/// Decodes rewrap input bytes to RGB8 (same acceptance as the shutter
/// path: empty/undecodable/zero-size inputs are errors, never warped).
fn decode_rewarp_input(input: &[u8]) -> Result<image::RgbImage, ScanError> {
    if input.is_empty() {
        return Err(ScanError::new(
            ScanErrorKind::InvalidInput,
            "scan input bytes must not be empty",
        ));
    }
    let decoded = image::load_from_memory(input).map_err(|err| {
        ScanError::new(
            ScanErrorKind::InvalidInput,
            "scan input is not a readable JPEG/PNG image",
        )
        .with_details(err.to_string())
    })?;
    let rgb = decoded.into_rgb8();
    if rgb.width() == 0 || rgb.height() == 0 {
        return Err(ScanError::new(
            ScanErrorKind::UnsupportedDimensions,
            "scan input has zero dimensions",
        ));
    }
    Ok(rgb)
}

fn mode_name(mode: ScanMode) -> &'static str {
    match mode {
        ScanMode::Original => "original",
        ScanMode::Grayscale => "grayscale",
        ScanMode::BlackWhite => "blackwhite",
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn envelope(value: &serde_json::Value, output: Option<Vec<u8>>) -> JsValue {
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(
        &obj,
        &"result_json".into(),
        &JsValue::from_str(&value.to_string()),
    )
    .expect("reflect result_json");
    match output {
        Some(bytes) => {
            js_sys::Reflect::set(
                &obj,
                &"output".into(),
                &js_sys::Uint8Array::from(bytes.as_slice()),
            )
            .expect("reflect output");
        }
        None => {
            js_sys::Reflect::set(&obj, &"output".into(), &JsValue::NULL).expect("reflect null");
        }
    }
    obj.into()
}
