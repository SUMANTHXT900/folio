//! Developer CLI for `pdf.merge`.
//!
//! Filesystem access lives here (a dev-only example), never in the
//! processing core. The core receives parsed documents plus an empty
//! options struct and returns a new document; reading, parsing, writing,
//! and verification happen below.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example merge_pdf -- a.pdf b.pdf c.pdf --out merged.pdf
//! cargo run --example merge_pdf -- a.pdf b.pdf --repeat 3 --json
//! ```
//!
//! Inputs are positional file paths in merge order. No argument syntax
//! beyond paths and flags is parsed; page-level selection stays in the
//! core operations that own it.

use std::path::PathBuf;

use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::loader::load_pdf;
use folio_engine::processing::pdf::merge::{MergeInput, MergeOperation, MergeOptions};
use folio_engine::testing::pdf::{measure_result, summarize_measurements};

fn usage() -> ! {
    eprintln!(
        "usage: cargo run --example merge_pdf -- <input.pdf> [<input.pdf> ...] [--out out.pdf] [--repeat N] [--json]"
    );
    std::process::exit(2);
}

fn main() {
    let mut input_paths: Vec<PathBuf> = Vec::new();
    let mut out_path: Option<PathBuf> = None;
    let mut repeats: usize = 1;
    let mut json = false;

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
        eprintln!("provide at least one input PDF");
        std::process::exit(2);
    }

    let out_path = out_path.unwrap_or_else(|| PathBuf::from("merged.pdf"));

    // Parse every input up front so a malformed file fails the whole run
    // before anything is constructed, with its index identified.
    let mut parsed: Vec<(String, Vec<u8>)> = Vec::with_capacity(input_paths.len());
    let mut input_bytes: u64 = 0;
    for (index, path) in input_paths.iter().enumerate() {
        let bytes = std::fs::read(path).unwrap_or_else(|err| {
            eprintln!("cannot read {}: {err}", path.display());
            std::process::exit(1);
        });
        if load_pdf(&bytes).is_err() {
            eprintln!(
                "input document {} ({}) is not a readable PDF; merge aborted",
                index + 1,
                path.display(),
            );
            std::process::exit(1);
        }
        input_bytes += bytes.len() as u64;
        parsed.push((path.to_string_lossy().into_owned(), bytes));
    }
    let label = parsed
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>()
        .join(" + ");

    let engine = ExecutionEngine::new();
    let options = MergeOptions::new();

    // Measure (possibly repeated) runs first; the file is written from the
    // final run, and console output never pollutes engine timing.
    let mut measurements = Vec::with_capacity(repeats);
    let mut saved_bytes: Vec<u8> = Vec::new();
    let mut saved_input_documents: u32 = 0;
    let mut saved_input_pages: u32 = 0;
    let mut saved_output_pages: u32 = 0;
    for _ in 0..repeats {
        let documents = parsed
            .iter()
            .map(|(_, bytes)| {
                load_pdf(bytes).unwrap_or_else(|err| {
                    eprintln!("invalid input: {err}");
                    std::process::exit(1);
                })
            })
            .collect();
        let input = MergeInput::new(documents);
        let result = engine.execute(&MergeOperation, input, options);
        measurements.push(measure_result(&result, &label, input_bytes, |outcome| {
            outcome.as_ref().ok().map(|out| out.output_page_count)
        }));
        match result.into_outcome() {
            Ok(mut output) => {
                saved_input_documents = output.input_document_count;
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

    let report = summarize_measurements("pdf.merge", &label, measurements);
    if json {
        println!(
            "{{\
             \"operation\":\"pdf.merge\",\
             \"inputs\":[{}],\
             \"input_bytes\":{},\
             \"input_document_count\":{},\
             \"input_page_count\":{},\
             \"output_page_count\":{},\
             \"report\":{} \
             }}",
            parsed
                .iter()
                .map(|(name, _)| json_string(name))
                .collect::<Vec<_>>()
                .join(","),
            input_bytes,
            saved_input_documents,
            saved_input_pages,
            saved_output_pages,
            report.to_json(),
        );
        return;
    }

    println!("inputs: {label}");
    println!("input:  {input_bytes} bytes, {saved_input_pages} pages across {saved_input_documents} documents");
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
