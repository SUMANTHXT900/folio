//! Developer CLI for `pdf.extract_pages`.
//!
//! Filesystem access lives here (a dev-only example), never in the
//! processing core. The core receives bytes plus a structured page list
//! and returns a new document; reading, writing, and verification happen
//! below.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example extract_pages -- path/to/input.pdf 1 3 5
//! cargo run --example extract_pages -- path/to/input.pdf 5 2 4 --out out.pdf
//! cargo run --example extract_pages -- path/to/input.pdf 1 3 --repeat 3
//! ```
//!
//! Page numbers are 1-based. The example parses CLI integers into a
//! structured selection; range validation stays in the core.

use std::path::PathBuf;

use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::loader::load_pdf;
use folio_engine::processing::pdf::extract::{
    ExtractPagesInput, ExtractPagesOperation, ExtractPagesOptions,
};
use folio_engine::testing::pdf::{measure_result, summarize_measurements};

fn usage() -> ! {
    eprintln!("usage: cargo run --example extract_pages -- <input.pdf> <page...> [--out out.pdf] [--repeat N]");
    std::process::exit(2);
}

fn main() {
    let mut input_path: Option<PathBuf> = None;
    let mut pages: Vec<u32> = Vec::new();
    let mut out_path: Option<PathBuf> = None;
    let mut repeats: usize = 1;

    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--out" => {
                out_path = Some(raw.next().map(PathBuf::from).unwrap_or_else(|| usage()));
            }
            "--repeat" => {
                repeats = raw
                    .next()
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or_else(|| usage())
                    .max(1);
            }
            "-h" | "--help" => usage(),
            other => {
                if input_path.is_none() {
                    input_path = Some(PathBuf::from(other));
                } else {
                    pages.push(other.parse::<u32>().unwrap_or_else(|_| {
                        eprintln!("invalid page number: {other} (expected 1-based integers)");
                        std::process::exit(2);
                    }));
                }
            }
        }
    }
    let input_path = input_path.unwrap_or_else(|| usage());
    if pages.is_empty() {
        eprintln!("select at least one page");
        std::process::exit(2);
    }

    let bytes = std::fs::read(&input_path).unwrap_or_else(|err| {
        eprintln!("cannot read {}: {err}", input_path.display());
        std::process::exit(1);
    });
    let out_path = out_path.unwrap_or_else(|| {
        let stem = input_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "output".to_string());
        PathBuf::from(format!("{stem}_extracted.pdf"))
    });

    let engine = ExecutionEngine::new();
    let label = input_path.to_string_lossy().into_owned();

    // Measure (possibly repeated) runs first; the saved file comes from the
    // final run, and console output never pollutes engine timing.
    let mut saved_bytes: Vec<u8> = Vec::new();
    let mut last_pages: u32 = 0;
    let mut measurements = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let input = ExtractPagesInput::from_bytes(bytes.clone()).unwrap_or_else(|err| {
            eprintln!("invalid input: {err}");
            std::process::exit(1);
        });
        let result = engine.execute(
            &ExtractPagesOperation,
            input,
            ExtractPagesOptions::new(pages.clone()),
        );
        measurements.push(measure_result(
            &result,
            &label,
            bytes.len() as u64,
            |outcome| outcome.as_ref().ok().map(|out| out.document.page_count()),
        ));
        match result.into_outcome() {
            Ok(mut output) => {
                last_pages = output.document.page_count();
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

    // Verify the written file re-loads as a valid PDF.
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

    let report = summarize_measurements("pdf.extract_pages", &label, measurements);
    println!("input:    {}", input_path.display());
    println!("selected: {pages:?}");
    println!(
        "output:   {} ({} pages, verified {})",
        out_path.display(),
        last_pages,
        verified.page_count()
    );
    if repeats > 1 {
        println!(
            "engine:   mean {:.1} ms (min {:.1}, max {:.1}) over {repeats} runs",
            report.mean_ms, report.min_ms, report.max_ms
        );
    } else {
        println!("engine:   {:.1} ms", report.mean_ms);
    }
}
