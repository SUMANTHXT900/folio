//! Developer CLI for `pdf.images_to_pdf`.
//!
//! Filesystem access lives here (a dev-only example), never in the
//! processing core. The core receives image bytes plus structured options
//! and returns a new document; reading, writing, and verification happen
//! below.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example images_to_pdf -- a.jpg b.png --out images.pdf
//! cargo run --example images_to_pdf -- a.jpg b.png --page-size standard --repeat 3 --json
//! ```
//!
//! Inputs are positional image paths in page order. Page-size policy and
//! background are parsed here only; layout semantics stay in the core.

use std::path::PathBuf;

use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::loader::load_pdf;
use folio_engine::processing::pdf::images_to_pdf::{
    ImageInput, ImagesToPdfInput, ImagesToPdfOperation, ImagesToPdfOptions, PageSizePolicy,
};
use folio_engine::testing::pdf::{measure_result, summarize_measurements};

fn usage() -> ! {
    eprintln!(
        "usage: cargo run --example images_to_pdf -- <image> [<image> ...] [--out out.pdf] [--page-size fit|standard] [--background RRGGBB] [--repeat N] [--json]"
    );
    std::process::exit(2);
}

fn parse_background(spec: &str) -> [u8; 3] {
    let hex = spec.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        eprintln!("invalid --background {spec:?} (expected 6 hex digits, e.g. FFFFFF)");
        std::process::exit(2);
    }
    let byte = |range: std::ops::Range<usize>| {
        u8::from_str_radix(&hex[range], 16).unwrap_or_else(|_| usage())
    };
    [byte(0..2), byte(2..4), byte(4..6)]
}

fn main() {
    let mut input_paths: Vec<PathBuf> = Vec::new();
    let mut out_path: Option<PathBuf> = None;
    let mut page_size = PageSizePolicy::FitImage;
    let mut background_rgb = [255u8, 255, 255];
    let mut repeats: usize = 1;
    let mut json = false;

    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--out" => {
                out_path = Some(raw.next().map(PathBuf::from).unwrap_or_else(|| usage()));
            }
            "--page-size" => {
                let spec = raw.next().unwrap_or_else(|| usage());
                page_size = PageSizePolicy::parse(&spec).unwrap_or_else(|| {
                    eprintln!("invalid --page-size {spec:?} (expected fit|standard)");
                    std::process::exit(2);
                });
            }
            "--background" => {
                let spec = raw.next().unwrap_or_else(|| usage());
                background_rgb = parse_background(&spec);
            }
            "--repeat" => {
                repeats = raw
                    .next()
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or_else(|| usage())
                    .max(1);
            }
            "--json" => json = true,
            "-h" | "--help" => usage(),
            other if !other.starts_with('-') => {
                input_paths.push(PathBuf::from(other));
            }
            other => {
                eprintln!("unexpected argument: {other}");
                usage();
            }
        }
    }
    if input_paths.is_empty() {
        usage();
    }

    // Read every image up front so a missing file fails before the engine runs.
    let mut names: Vec<String> = Vec::with_capacity(input_paths.len());
    let mut blobs: Vec<Vec<u8>> = Vec::with_capacity(input_paths.len());
    let mut total_input_bytes: u64 = 0;
    for path in &input_paths {
        let bytes = std::fs::read(path).unwrap_or_else(|err| {
            eprintln!("cannot read {}: {err}", path.display());
            std::process::exit(1);
        });
        total_input_bytes += bytes.len() as u64;
        names.push(
            path.file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        );
        blobs.push(bytes);
    }
    let out_path = out_path.unwrap_or_else(|| PathBuf::from("images.pdf"));
    let options = ImagesToPdfOptions::new(page_size, background_rgb);
    let engine = ExecutionEngine::new();
    let label = names.join(" + ");

    let mut measurements = Vec::with_capacity(repeats);
    let mut saved_bytes: Vec<u8> = Vec::new();
    let mut saved_pages: u32 = 0;
    for _ in 0..repeats {
        let images: Vec<ImageInput> = names
            .iter()
            .zip(blobs.iter())
            .map(|(name, bytes)| {
                ImageInput::new(name.clone(), bytes.clone()).unwrap_or_else(|err| {
                    eprintln!("invalid input: {err}");
                    std::process::exit(1);
                })
            })
            .collect();
        let result = engine.execute(
            &ImagesToPdfOperation,
            ImagesToPdfInput::new(images),
            options,
        );
        measurements.push(measure_result(
            &result,
            &label,
            total_input_bytes,
            |outcome| outcome.as_ref().ok().map(|out| out.page_count),
        ));
        match result.into_outcome() {
            Ok(mut output) => {
                saved_pages = output.page_count;
                saved_bytes = output.document.save_to_bytes().unwrap_or_else(|err| {
                    eprintln!("cannot serialize output: {err}");
                    std::process::exit(1);
                });
            }
            Err(err) => {
                eprintln!(
                    "error: [{code}] {message}",
                    code = err.code(),
                    message = err.message()
                );
                if let Some(details) = err.details() {
                    eprintln!("details: {details}");
                }
                std::process::exit(1);
            }
        }
    }

    std::fs::write(&out_path, &saved_bytes).unwrap_or_else(|err| {
        eprintln!("cannot write {}: {err}", out_path.display());
        std::process::exit(1);
    });

    let verify_bytes = std::fs::read(&out_path).unwrap_or_else(|err| {
        eprintln!("cannot re-read {}: {err}", out_path.display());
        std::process::exit(1);
    });
    let verified = load_pdf(&verify_bytes).unwrap_or_else(|err| {
        eprintln!(
            "output failed to re-load: [{code}] {message}",
            code = err.code(),
            message = err.message()
        );
        std::process::exit(1);
    });

    let report = summarize_measurements("pdf.images_to_pdf", &label, measurements);
    if json {
        println!(
            "{{\
             \"operation\":\"pdf.images_to_pdf\",\
             \"inputs\":[{}],\
             \"input_bytes\":{},\
             \"image_count\":{},\
             \"output_page_count\":{},\
             \"page_size\":\"{}\",\
             \"report\":{} \
             }}",
            names
                .iter()
                .map(|name| format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\"")))
                .collect::<Vec<_>>()
                .join(","),
            total_input_bytes,
            names.len(),
            saved_pages,
            match page_size {
                PageSizePolicy::FitImage => "fit",
                PageSizePolicy::StandardPage => "standard",
            },
            report.to_json(),
        );
        return;
    }

    println!(
        "inputs: {} ({} bytes, {} images)",
        label,
        total_input_bytes,
        names.len()
    );
    println!(
        "page-size: {}",
        match page_size {
            PageSizePolicy::FitImage => "fit",
            PageSizePolicy::StandardPage => "standard",
        }
    );
    println!(
        "output: {} ({} pages, verified {})",
        out_path.display(),
        saved_pages,
        verified.page_count()
    );
    if repeats > 1 {
        println!(
            "engine: mean {:.1} ms (min {:.1}, max {:.1}) over {repeats} runs",
            report.mean_ms, report.min_ms, report.max_ms
        );
    } else {
        println!("engine: {:.1} ms", report.mean_ms);
    }
}
