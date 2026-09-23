//! Scan benchmark: stage timings on generated document photos.
//!
//! No corpus, no camera — deterministic synthetic fixtures only.
//! Filesystem access lives here (dev-only example), never in the core.
//!
//! Run with:
//!
//! ```sh
//! cargo run --release --example scan_bench
//! ```
//!
//! Measures decode / detect / warp / enhance / encode on three sizes
//! (12 MP phone-class, medium document, webcam) plus a low-light
//! variant, guiding the M1 output-resolution decision (correction 5).

use std::time::Instant;

use folio_scan::enhance::ScanMode;
use folio_scan::{detect_document, scan_document, ScanRequest};

/// Paints a white perspective document on a dark noisy background.
fn doc_photo(w: u32, h: u32, light: u8) -> Vec<u8> {
    let corners = [
        (0.19 * w as f64, 0.11 * h as f64),
        (0.81 * w as f64, 0.16 * h as f64),
        (0.73 * w as f64, 0.88 * h as f64),
        (0.13 * w as f64, 0.83 * h as f64),
    ];
    let mut rgb = vec![0u8; w as usize * h as usize * 3];
    for y in 0..h {
        for x in 0..w {
            let n = ((x * 7919 + y * 104729) % 23) as u8;
            let o = (y as usize * w as usize + x as usize) * 3;
            let base = light.saturating_add(n / 3);
            rgb[o] = base;
            rgb[o + 1] = base;
            rgb[o + 2] = base;
        }
    }
    // Scanline fill between interpolated left/right edges.
    let (tl, tr, br, bl) = (corners[0], corners[1], corners[2], corners[3]);
    let top = 0.11 * h as f64;
    let bottom = 0.88 * h as f64;
    for y in 0..h {
        let t = y as f64 / h as f64;
        let lx = bl.0 + (tl.0 - bl.0) * ((0.83 - t) / 0.72).clamp(0.0, 1.0);
        let rx = br.0 + (tr.0 - br.0) * ((0.88 - t) / 0.72).clamp(0.0, 1.0);
        if y as f64 >= top && y as f64 <= bottom {
            for x in (lx as u32)..=(rx as u32).min(w - 1) {
                let o = (y as usize * w as usize + x as usize) * 3;
                rgb[o] = 242;
                rgb[o + 1] = 242;
                rgb[o + 2] = 242;
            }
        }
    }
    // Encode once: the pipeline input is JPEG bytes like a camera frame.
    let mut bytes = Vec::new();
    use image::ImageEncoder;
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 92)
        .write_image(&rgb, w, h, image::ExtendedColorType::Rgb8)
        .expect("encodes");
    bytes
}

fn bench(name: &str, w: u32, h: u32, light: u8, mode: ScanMode) {
    let input = doc_photo(w, h, light);
    // Decode (shared input cost, measured once here for context).
    let t = Instant::now();
    let decoded = image::load_from_memory(&input).expect("decodes").to_rgb8();
    let decode_ms = t.elapsed().as_secs_f64() * 1000.0;
    // Detect (timed separately for the stage table).
    let t = Instant::now();
    detect_document(decoded.as_raw(), w, h).expect("detects");
    let detect_ms = t.elapsed().as_secs_f64() * 1000.0;
    // Full pipeline (decode + detect + warp + enhance + encode).
    let t = Instant::now();
    let out = scan_document(&ScanRequest {
        bytes: input.clone(),
        mode,
    })
    .expect("scans");
    let total_ms = t.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{name:22} {w}x{h}  decode={decode_ms:7.1}ms  detect={detect_ms:7.1}ms  \
         total={total_ms:8.1}ms  out={}x{}  fallback={}  conf={:.2}  bytes={}",
        out.width,
        out.height,
        out.fallback,
        out.confidence,
        out.bytes.len(),
    );
}

fn main() {
    println!("folio-scan benchmark (release, synthetic fixtures)");
    bench("phone 12MP original", 4000, 3000, 18, ScanMode::Original);
    bench("phone 12MP b/w", 4000, 3000, 18, ScanMode::BlackWhite);
    bench("medium document", 1280, 960, 18, ScanMode::Original);
    bench("webcam", 640, 480, 18, ScanMode::Original);
    bench("low-light medium", 1280, 960, 8, ScanMode::Original);
    bench("low-light b/w", 1280, 960, 8, ScanMode::BlackWhite);
}
