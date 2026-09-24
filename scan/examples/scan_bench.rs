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

/// Paints a perspective document on a dark noisy background.
fn doc_photo_styled(
    w: u32,
    h: u32,
    light: u8,
    paper: [u8; 3],
    clutter: bool,
    text_lines: bool,
) -> Vec<u8> {
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
                let mut px = paper;
                // Printed text lines: dark bars inset from the edges.
                if text_lines {
                    let lx_u = lx as u32;
                    let rx_u = rx as u32;
                    let row_in_doc = y - top as u32;
                    if x > lx_u + 12 && x < rx_u.saturating_sub(12) && row_in_doc % 14 < 3 {
                        px = [40, 40, 40];
                    }
                }
                rgb[o] = px[0];
                rgb[o + 1] = px[1];
                rgb[o + 2] = px[2];
            }
        }
    }
    // Background clutter: dark rectangles outside the document.
    if clutter {
        for (rx, ry, rw, rh) in [(30u32, 40u32, 90u32, 60u32), (520u32, 700u32, 80u32, 50u32)] {
            for y in ry..(ry + rh).min(h) {
                for x in rx..(rx + rw).min(w) {
                    let o = (y as usize * w as usize + x as usize) * 3;
                    rgb[o] = 60;
                    rgb[o + 1] = 55;
                    rgb[o + 2] = 50;
                }
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
    bench_styled(name, w, h, light, [242, 242, 242], false, false, mode);
}

#[allow(clippy::too_many_arguments)]
fn bench_styled(
    name: &str,
    w: u32,
    h: u32,
    light: u8,
    paper: [u8; 3],
    clutter: bool,
    text_lines: bool,
    mode: ScanMode,
) {
    let input = doc_photo_styled(w, h, light, paper, clutter, text_lines);
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
    // Representative evaluation (synthetic stand-ins, NOT real-device
    // photos — see WORKLOG M3): receipt aspect, colored paper, clutter,
    // printed text, perspective-heavy framing.
    bench_styled(
        "receipt tall",
        600,
        1400,
        18,
        [242, 242, 242],
        false,
        false,
        ScanMode::Original,
    );
    bench_styled(
        "colored paper",
        1280,
        960,
        18,
        [232, 220, 198],
        false,
        false,
        ScanMode::Original,
    );
    bench_styled(
        "cluttered background",
        1280,
        960,
        18,
        [242, 242, 242],
        true,
        false,
        ScanMode::Original,
    );
    bench_styled(
        "printed text page",
        1280,
        960,
        18,
        [242, 242, 242],
        false,
        true,
        ScanMode::BlackWhite,
    );
    bench_styled(
        "perspective-heavy b/w",
        4000,
        3000,
        18,
        [242, 242, 242],
        true,
        true,
        ScanMode::BlackWhite,
    );
}
