//! Developer CLI for `pdf.delete_pages`.
//!
//! Filesystem access lives here (a dev-only example), never in the
//! processing core. The core receives bytes plus a structured deletion
//! list and returns a new document; reading, writing, and verification
//! happen below.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example delete_pages -- path/to/input.pdf --pages 2,4,7
//! cargo run --example delete_pages -- path/to/input.pdf --pages 5 --out out.pdf
//! cargo run --example delete_pages -- path/to/input.pdf --pages 2 --repeat 3 --json
//! ```
//!
//! The deletion list is a comma-separated list of 1-based page numbers.
//! This tiny CLI syntax is parsed here only; deletion validation stays in
//! the core.

use std::path::PathBuf;

use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::loader::load_pdf;
use folio_engine::processing::pdf::core::PageNumber;
use folio_engine::processing::pdf::delete::{
    DeletePagesInput, DeletePagesOperation, DeletePagesOptions,
};
use folio_engine::testing::pdf::{measure_result, summarize_measurements};

fn usage() -> ! {
    eprintln!(
        "usage: cargo run --example delete_pages -- <input.pdf> --pages <pages> [--out out.pdf] [--repeat N] [--json]"
    );
    std::process::exit(2);
}

/// Parses the `--pages` spec (`"2,4,7"`) into a structured deletion list.
fn parse_pages(spec: &str) -> Vec<PageNumber> {
    spec.split(',')
        .filter(|entry| !entry.trim().is_empty())
        .map(|entry| {
            entry.trim().parse::<PageNumber>().unwrap_or_else(|_| {
                eprintln!("invalid page number in --pages {spec:?} (expected 1-based integers)");
                std::process::exit(2);
            })
        })
        .collect()
}

fn main() {
    let mut input_path: Option<PathBuf> = None;
    let mut pages: Vec<PageNumber> = Vec::new();
    let mut pages_given = false;
    let mut out_path: Option<PathBuf> = None;
    let mut repeats: usize = 1;
    let mut json = false;

    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--pages" => {
                let spec = raw.next().unwrap_or_else(|| usage());
                pages = parse_pages(&spec);
                pages_given = true;
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
    if !pages_given {
        eprintln!("provide --pages with the 1-based pages to delete (may be empty)");
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
        PathBuf::from(format!("{stem}-deleted.pdf"))
    });

    let engine = ExecutionEngine::new();
    let label = input_path.to_string_lossy().into_owned();
    let options = DeletePagesOptions::new(pages.clone());

    // Measure (possibly repeated) runs first; the file is written from the
    // final run, and console output never pollutes engine timing.
    let mut measurements = Vec::with_capacity(repeats);
    let mut saved_bytes: Vec<u8> = Vec::new();
    let mut saved_input_pages: u32 = 0;
    let mut saved_output_pages: u32 = 0;
    for _ in 0..repeats {
        let input = DeletePagesInput::from_bytes(bytes.clone()).unwrap_or_else(|err| {
            eprintln!("invalid input: {err}");
            std::process::exit(1);
        });
        let result = engine.execute(&DeletePagesOperation, input, options.clone());
        measurements.push(measure_result(
            &result,
            &label,
            bytes.len() as u64,
            |outcome| outcome.as_ref().ok().map(|out| out.output_page_count),
        ));
        match result.into_outcome() {
            Ok(mut output) => {
                saved_input_pages = output.input_page_count;
                saved_output_pages = output.output_page_count;
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

    let report = summarize_measurements("pdf.delete_pages", &label, measurements);
    if json {
        println!(
            "{{\
             \"operation\":\"pdf.delete_pages\",\
             \"input\":{},\
             \"input_bytes\":{},\
             \"input_page_count\":{},\
             \"deleted_pages\":[{}],\
             \"deleted_page_count\":{},\
             \"output_page_count\":{},\
             \"report\":{} \
             }}",
            json_string(&label),
            bytes.len(),
            saved_input_pages,
            pages
                .iter()
                .map(PageNumber::to_string)
                .collect::<Vec<_>>()
                .join(","),
            pages.len(),
            saved_output_pages,
            report.to_json(),
        );
        return;
    }

    println!(
        "input:  {} ({} bytes, {} pages)",
        label,
        bytes.len(),
        saved_input_pages
    );
    println!("deleted: {pages:?}");
    println!(
        "output: {} ({} pages, verified {})",
        out_path.display(),
        saved_output_pages,
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
