//! Scan enhancement: Original / Grayscale / Black & White.
//!
//! Deliberately mode-only — no tuning controls (v2.0 is not an image
//! editor). Grayscale is Rec. 601 luma; B&W is a local-mean adaptive
//! threshold via an integral image (handles uneven lighting better than
//! a global cutoff) with fixed, documented parameters.

/// B&W block radius as a fraction of the smaller image dimension.
const BW_BLOCK_FRAC: f64 = 1.0 / 24.0;
/// B&W threshold offset below the local mean (0–255).
const BW_OFFSET: f64 = 10.0;

/// Document enhancement mode (no tuning knobs in v2.0).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ScanMode {
    /// Warped color document, no enhancement.
    #[default]
    Original,
    /// Luminance only.
    Grayscale,
    /// Adaptive-threshold ink-on-paper.
    BlackWhite,
}

impl ScanMode {
    /// Parses the wire/UI string form.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "original" | "color" => Some(Self::Original),
            "grayscale" | "gray" | "grey" => Some(Self::Grayscale),
            "bw" | "blackwhite" | "black_white" | "black-and-white" => Some(Self::BlackWhite),
            _ => None,
        }
    }
}

/// Applies the mode to RGB pixels, returning RGB pixels (same dims).
/// B&W output is 0/255 triples — valid input for the PDF engine, which
/// already handles grayscale/RGB uniformly.
#[must_use]
pub fn apply_mode(rgb: &[u8], w: u32, h: u32, mode: ScanMode) -> Vec<u8> {
    match mode {
        ScanMode::Original => rgb.to_vec(),
        ScanMode::Grayscale => rgb
            .chunks_exact(3)
            .flat_map(|px| {
                let luma = (0.299f64.mul_add(
                    f64::from(px[0]),
                    0.587f64.mul_add(f64::from(px[1]), 0.114 * f64::from(px[2])),
                ))
                .round() as u8;
                [luma, luma, luma]
            })
            .collect(),
        ScanMode::BlackWhite => {
            let gray: Vec<u8> = rgb
                .chunks_exact(3)
                .map(|px| {
                    (0.299f64.mul_add(
                        f64::from(px[0]),
                        0.587f64.mul_add(f64::from(px[1]), 0.114 * f64::from(px[2])),
                    ))
                    .round() as u8
                })
                .collect();
            let mask = adaptive_threshold(&gray, w, h);
            mask.iter()
                .flat_map(|v| {
                    let b = if *v > 0 { 255u8 } else { 0u8 };
                    [b, b, b]
                })
                .collect()
        }
    }
}

/// Local-mean adaptive threshold via integral image. `mask` pixel is 255
/// when the pixel exceeds its neighborhood mean minus [`BW_OFFSET`].
fn adaptive_threshold(gray: &[u8], w: u32, h: u32) -> Vec<u8> {
    let (w, h) = (w as usize, h as usize);
    // Integral image with zero border (u64: no overflow at any size).
    let mut sat = vec![0u64; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row_sum = 0u64;
        for x in 0..w {
            row_sum += u64::from(gray[y * w + x]);
            sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row_sum;
        }
    }
    let block = ((w.min(h) as f64 * BW_BLOCK_FRAC).round() as usize / 2 * 2 + 1).max(3);
    let half = block / 2;
    let area = |x0: usize, y0: usize, x1: usize, y1: usize| -> (u64, usize) {
        let s = sat[y1 * (w + 1) + x1] + sat[y0 * (w + 1) + x0]
            - sat[y0 * (w + 1) + x1]
            - sat[y1 * (w + 1) + x0];
        (s, (x1 - x0) * (y1 - y0))
    };
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let (x0, y0) = (x.saturating_sub(half), y.saturating_sub(half));
            let (x1, y1) = ((x + half + 1).min(w), (y + half + 1).min(h));
            let (sum, count) = area(x0, y0, x1, y1);
            let mean = sum as f64 / count.max(1) as f64;
            out[y * w + x] = u8::from(f64::from(gray[y * w + x]) > mean - BW_OFFSET);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grayscale_equalizes_channels() {
        let rgb = vec![200u8, 100, 50, 10, 20, 30];
        let out = apply_mode(&rgb, 2, 1, ScanMode::Grayscale);
        assert_eq!(out.len(), 6);
        assert_eq!(out[0], out[1]);
        assert_eq!(out[1], out[2]);
        assert_eq!(out[3], out[4]);
        assert_eq!(out[4], out[5]);
    }

    #[test]
    fn blackwhite_is_binary_and_keeps_dark_text() {
        // White page, thin black bar, gray gradient wash (uneven lighting).
        // The bar is thinner than the local window so the window always
        // sees paper around ink (thick-stroke interiors legitimately
        // average to paper — correct adaptive behavior, not tested here).
        let (w, h) = (120u32, 120u32);
        let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
        for y in 0..h {
            for x in 0..w {
                // Gentle linear wash, no wraps: adaptive threshold must
                // see through it everywhere.
                let wash = 200 + ((x + y) / 8) as u8;
                let ink = (59..=61).contains(&x);
                let v = if ink { 10u8 } else { wash };
                rgb.extend_from_slice(&[v, v, v]);
            }
        }
        let out = apply_mode(&rgb, w, h, ScanMode::BlackWhite);
        assert!(out
            .chunks_exact(3)
            .all(|px| px == [0, 0, 0] || px == [255, 255, 255]));
        // Ink bar stays black, page stays white despite the wash.
        let at = |x: u32, y: u32| out[(y as usize * w as usize + x as usize) * 3];
        assert_eq!(at(60, 60), 0);
        assert_eq!(at(10, 10), 255);
        assert_eq!(at(110, 110), 255);
    }

    #[test]
    fn original_is_identity() {
        let rgb = vec![1u8, 2, 3, 4, 5, 6];
        assert_eq!(apply_mode(&rgb, 2, 1, ScanMode::Original), rgb);
    }

    #[test]
    fn mode_parses_known_names() {
        assert_eq!(ScanMode::parse("original"), Some(ScanMode::Original));
        assert_eq!(ScanMode::parse("GRAY"), Some(ScanMode::Grayscale));
        assert_eq!(
            ScanMode::parse("black-and-white"),
            Some(ScanMode::BlackWhite)
        );
        assert_eq!(ScanMode::parse("vivid"), None);
    }
}
