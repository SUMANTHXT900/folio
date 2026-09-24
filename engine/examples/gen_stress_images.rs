//! Stress-fixture generator for the Image → PDF audit (temporary).
//!
//! Writes deterministic photographic-noise JPEGs (~12 MP, tuned toward
//! ~3 MB each) for browser stress runs. No private photos committed.
//!
//! Run with:
//!
//! ```sh
//! cargo run --release --example gen_stress_images -- <out-dir> [<count>]
//! ```

use std::path::PathBuf;

use image::ImageEncoder;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: gen_stress_images <out-dir> [<count>]");
        std::process::exit(2);
    }
    let dir = PathBuf::from(&args[1]);
    let count: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(30);
    std::fs::create_dir_all(&dir).expect("mkdir");
    // 4000×3000 ≈ 12 MP, phone-class.
    let (w, h) = (4000u32, 3000u32);
    // Deterministic photographic-ish content: sky gradient + textured
    // ground + shapes + high-frequency noise (JPEG-hostile → real sizes).
    let mut rgb = vec![0u8; w as usize * h as usize * 3];
    for y in 0..h {
        for x in 0..w {
            let o = (y as usize * w as usize + x as usize) * 3;
            let sky = ((h - y) as f64 / h as f64 * 90.0) as u8;
            let n = ((x * 7919 + y * 104729 + x * y) % 61) as u8;
            let mut r = 60u8.saturating_add(sky / 2).saturating_add(n / 4);
            let mut g = 90u8.saturating_add(sky / 3).saturating_add(n / 4);
            let mut b = 120u8.saturating_add(sky).saturating_add(n / 5);
            // Ground band with texture blocks.
            if y > h * 2 / 3 {
                let t = ((x / 37 + y / 29) % 5) as u8 * 14;
                r = 70 + t + n / 6;
                g = 60 + t + n / 6;
                b = 45 + t / 2;
            }
            // A few solid shapes (sky sun, dark rectangles).
            let dx = x as i64 - 3200;
            let dy = y as i64 - 500;
            if dx * dx + dy * dy < 200 * 200 {
                r = 240;
                g = 220;
                b = 150;
            }
            if x > 300 && x < 900 && y > 1900 && y < 2600 {
                r = 25;
                g = 25;
                b = 30;
            }
            rgb[o] = r;
            rgb[o + 1] = g;
            rgb[o + 2] = b;
        }
    }
    // Quality/size tradeoff probe on image 0 (audit Part 9).
    for q in [92u8, 95, 98] {
        let t = std::time::Instant::now();
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, q)
            .write_image(&rgb, w, h, image::ExtendedColorType::Rgb8)
            .expect("encodes");
        println!(
            "quality q={q}: {} bytes in {:.0}ms",
            bytes.len(),
            t.elapsed().as_secs_f64() * 1000.0
        );
    }
    {
        let t = std::time::Instant::now();
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&rgb, w, h, image::ExtendedColorType::Rgb8)
            .expect("encodes");
        println!(
            "png: {} bytes in {:.0}ms",
            bytes.len(),
            t.elapsed().as_secs_f64() * 1000.0
        );
    }
    for i in 0..count {
        // Per-image deterministic variation (seeded offset) so pages differ.
        let mut varied = rgb.clone();
        let seed = (i as u32).wrapping_mul(2654435761);
        for (k, px) in varied.iter_mut().enumerate() {
            let n = ((k as u32).wrapping_add(seed) % 17) as u8;
            *px = px.saturating_add(n / 6);
        }
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90)
            .write_image(&varied, w, h, image::ExtendedColorType::Rgb8)
            .expect("encodes");
        let path = dir.join(format!("stress-{i:03}.jpg"));
        std::fs::write(&path, &bytes).expect("writes");
        if i == 0 {
            println!("first image: {} bytes", bytes.len());
        }
    }
    println!("wrote {count} fixtures to {}", dir.display());
}
