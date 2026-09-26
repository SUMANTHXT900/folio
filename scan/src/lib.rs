//! `folio-scan`: local-first document-scan core (v2.0 M1).
//!
//! Detects a rectangular document in a photo, normalizes its four
//! corners, warps it to a rectangle via a true perspective homography,
//! and optionally enhances it (grayscale / black & white). Everything
//! is deterministic, dependency-light (`image` + `imageproc` primitives
//! with default features off — no rayon, no threading), and testable
//! natively; the WASM/worker integration lands in M2.
//!
//! Pipeline (`pipeline::scan_document`):
//!
//! ```text
//! JPEG/PNG bytes → decode → detect (downscaled, borrowed)
//!   → warp (full-res) → enhance (mode) → JPEG bytes + corners + confidence
//! ```
//!
//! `ScanRequest::detect_only` stops after detection (corners/confidence,
//! no output bytes) — the live-guidance fast path.
//!
//! Detection failure is never fatal: the pipeline returns the original
//! bytes with `fallback: true` so the caller can offer "Use original".
//! No filesystem, no network, no parallelism — sequential by design.

pub mod detect;
pub mod enhance;
pub mod error;
pub mod geometry;
pub mod pipeline;
pub mod warp;

// WASM glue (M2): exports only; the M1 core stays glue-free natively.
#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use detect::{detect_document, Detection};
pub use enhance::ScanMode;
pub use error::{ScanError, ScanErrorKind};
pub use geometry::{homography, order_corners, validate_quad, Point, Quad};
pub use pipeline::{scan_document, ScanOutput, ScanRequest};
pub use warp::{warp_quad, warp_to_jpeg};
