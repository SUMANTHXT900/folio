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
//! "No document detected" is NOT an error: it returns status
//! `"original"` with `output: null`, and the caller falls back to the
//! input bytes it already holds. Only malformed inputs and internal
//! failures are errors.

use serde_json::json;
use wasm_bindgen::prelude::*;

use crate::enhance::ScanMode;
use crate::error::ScanErrorKind;
use crate::pipeline::{scan_document, ScanRequest};

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
