//! Developer CLI for `pdf.reorder`.
//!
//! Filesystem access lives here (a dev-only example), never in the
//! processing core. The core receives bytes plus a structured permutation
//! and returns a new document; reading, writing, and verification happen
//! below.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example reorder_pdf -- path/to/input.pdf --order 5,2,4,1,3
//! cargo run --example reorder_pdf -- path/to/input.pdf --order 3,2,1 --out out.pdf
//! cargo run --example reorder_pdf -- path/to/input.pdf --order 2,1 --repeat 3 --json
//! ```
//!
//! The order is a comma-separated list of 1-based page numbers covering
//! every source page exactly once. This tiny CLI syntax is parsed here
//! only; permutation validation stays in the core.

use std::path::PathBuf;

use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::loader::load_pdf;
use folio_engine::processing::pdf::core::PageNumber;
use folio_engine::processing::pdf::reorder::{ReorderInput, ReorderOperation, ReorderOptions};
use folio_engine::testing::pdf::{measure_result, summarize_measurements};

fn usage() -> ! {
    eprintln!(
        "usage: cargo run --example reorder_pdf -- <input.pdf> --order <pages> [--out out.pdf] [--repeat N] [--json]"
    );
    std::process::exit(2);
}

/// Parses the `--order` spec (`"5,2,4,1,3"`) into a structured permutation.
fn parse_order(spec: &str) -> Vec<PageNumber> {
    let order: Vec<PageNumber> = spec
        .split(',')
        .filter(|entry| !entry.trim().is_empty())
        .map(|entry| {
            entry.trim().parse::<PageNumber>().unwrap_or_else(|_| {
                eprintln!("invalid page number in --order {spec:?} (expected 1-based integers)");
                std::process::exit(2);
            })
        })
        .collect();
    if order.is_empty() {
        eprintln!("--order {spec:?} selects no pages");
        std::process::exit(2);
    }
    order
}

fn main() {
    let mut input_path: Option<PathBuf> = None;
    let mut order: Vec<PageNumber> = Vec::new();
    let mut out_path: Option<PathBuf> = None;
    let mut repeats: usize = 1;
    let mut json = false;

    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--order" => {
                let spec = raw.next().unwrap_or_else(|| usage());
                order = parse_order(&spec);
            }
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
            "--json" => json = true,
            "-h" | "--help" => usage(),
            other if input_path.is_none() && !other.starts_with('-') => {
                input_path = Some(PathBuf::from(other));
            }
            other => {
                eprintln!("unexpected argument: {other}");
                usage();
            }
        }
    }
    let input_path = input_path.unwrap_or_else(|| usage());
    if order.is_empty() {
        eprintln!("provide --order with one entry per document page");
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
        PathBuf::from(format!("{stem}-reordered.pdf"))
    });

    let engine = ExecutionEngine::new();
    let label = input_path.to_string_lossy().into_owned();
    let options = ReorderOptions::new(order.clone());

    // Measure (possibly repeated) runs first; the file is written from the
    // final run, and console output never pollutes engine timing.
    let mut measurements = Vec::with_capacity(repeats);
    let mut saved_bytes: Vec<u8> = Vec::new();
    let mut saved_pages: u32 = 0;
    for _ in 0..repeats {
        let input = ReorderInput::from_bytes(bytes.clone()).unwrap_or_else(|err| {
            eprintln!("invalid input: {err}");
            std::process::exit(1);
        });
        let result = engine.execute(&ReorderOperation, input, options.clone());
        measurements.push(measure_result(
            &result,
            &label,
            bytes.len() as u64,
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

    let report = summarize_measurements("pdf.reorder", &label, measurements);
    if json {
        println!(
            "{{\
             \"operation\":\"pdf.reorder\",\
             \"input\":{},\
             \"input_bytes\":{},\
             \"input_page_count\":{},\
             \"order\":[{}],\
             \"output_page_count\":{},\
             \"report\":{} \
             }}",
            json_string(&label),
            bytes.len(),
            verified.page_count(),
            order
                .iter()
                .map(PageNumber::to_string)
                .collect::<Vec<_>>()
                .join(","),
            saved_pages,
            report.to_json(),
        );
        return;
    }

    println!(
        "input:  {} ({} bytes, {} pages)",
        label,
        bytes.len(),
        verified.page_count()
    );
    println!("order:  {order:?}");
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

fn json_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}
