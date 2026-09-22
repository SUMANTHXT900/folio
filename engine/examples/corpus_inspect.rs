//! Opt-in corpus testing and benchmarking for `pdf.inspect`.
//!
//! This is explicitly developer-invoked — it is NOT part of `cargo test`
//! and never scans anything automatically. Filesystem access lives here
//! only (reads); the core receives bytes, and nothing is ever written to
//! the corpus.
//!
//! Run with:
//!
//! ```sh
//! # Discover (default dir `../test pdfs` from `engine/`, default cap 25 files):
//! cargo run --example corpus_inspect
//! cargo run --example corpus_inspect -- --dir "../test pdfs" --filter merged --limit 5
//! # Explicit files (no discovery, no cap):
//! cargo run --example corpus_inspect -- "../test pdfs/a.pdf" "../test pdfs/b.pdf"
//! # Benchmark: repeat each file, detailed mode, JSON output:
//! cargo run --example corpus_inspect -- --limit 3 --repeat 3 --detailed --json
//! ```
//!
//! Timing is authoritative: every measurement uses the engine's monotonic
//! clock. All runs complete before anything is printed, so console output
//! never pollutes a measurement.

use std::path::PathBuf;

use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::inspect::{InspectInput, InspectOperation, InspectOptions};
use folio_engine::testing::pdf::{
    benchmark_operation, summarize_measurements, BenchmarkCase, BenchmarkMeasurement,
    BenchmarkReport,
};

/// Default discovery cap: an explicit `--limit 0` removes it. Discovery
/// never runs implicitly — reaching this example IS the opt-in.
const DEFAULT_LIMIT: usize = 25;

struct Args {
    files: Vec<PathBuf>,
    dir: PathBuf,
    filter: Option<String>,
    limit: usize,
    detailed: bool,
    repeats: usize,
    json: bool,
}

impl Args {
    fn parse() -> Self {
        let mut args = Args {
            files: Vec::new(),
            dir: PathBuf::from("../test pdfs"),
            filter: None,
            limit: DEFAULT_LIMIT,
            detailed: false,
            repeats: 1,
            json: false,
        };
        let mut raw = std::env::args().skip(1).peekable();
        while let Some(arg) = raw.next() {
            match arg.as_str() {
                "--dir" => {
                    args.dir = raw.next().map(PathBuf::from).unwrap_or_else(|| {
                        eprintln!("--dir needs a value");
                        std::process::exit(2);
                    });
                }
                "--filter" => {
                    args.filter = Some(raw.next().unwrap_or_else(|| {
                        eprintln!("--filter needs a value");
                        std::process::exit(2);
                    }));
                }
                "--limit" => {
                    args.limit = raw
                        .next()
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or_else(|| {
                            eprintln!("--limit needs a non-negative integer");
                            std::process::exit(2);
                        });
                }
                "--detailed" => args.detailed = true,
                "--repeat" => {
                    args.repeats = raw
                        .next()
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or_else(|| {
                            eprintln!("--repeat needs a positive integer");
                            std::process::exit(2);
                        })
                        .max(1);
                }
                "--json" => args.json = true,
                "-h" | "--help" => {
                    println!("usage: corpus_inspect [FILES]... [--dir DIR] [--filter SUB] [--limit N] [--detailed] [--repeat N] [--json]");
                    std::process::exit(0);
                }
                other => args.files.push(PathBuf::from(other)),
            }
        }
        args
    }
}

/// Discovers candidate PDFs: explicit files win; otherwise a sorted,
/// optionally filtered/capped directory listing. Returns `(label, path)`.
fn discover(args: &Args) -> Vec<(String, PathBuf)> {
    if !args.files.is_empty() {
        return args
            .files
            .iter()
            .map(|p| (p.to_string_lossy().into_owned(), p.clone()))
            .collect();
    }
    let entries = std::fs::read_dir(&args.dir).unwrap_or_else(|err| {
        eprintln!("cannot list {}: {err}", args.dir.display());
        std::process::exit(1);
    });
    let mut found: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        })
        .filter(|p| {
            args.filter.as_deref().is_none_or(|sub| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().contains(sub))
            })
        })
        .map(|p| (p.to_string_lossy().into_owned(), p))
        .collect();
    found.sort();
    if args.limit > 0 && found.len() > args.limit {
        found.truncate(args.limit);
    }
    found
}

fn main() {
    let args = Args::parse();
    let options = if args.detailed {
        InspectOptions::detailed()
    } else {
        InspectOptions::basic()
    };
    let engine = ExecutionEngine::new();
    let operation = InspectOperation;

    let targets = discover(&args);
    if targets.is_empty() {
        eprintln!("no PDF files selected");
        std::process::exit(1);
    }

    // Measure everything first; print only afterwards.
    let mut reports: Vec<BenchmarkReport> = Vec::with_capacity(targets.len());
    for (label, path) in &targets {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(err) => {
                reports.push(summarize_measurements(
                    "pdf.inspect",
                    label,
                    vec![BenchmarkMeasurement {
                        operation: "pdf.inspect".to_string(),
                        input_label: label.clone(),
                        file_bytes: 0,
                        page_count: None,
                        success: false,
                        engine_duration_ms: 0.0,
                        timestamp_unix_ms: 0,
                        error_code: Some("IO_ERROR".to_string()),
                        error_message: Some(format!("cannot read file: {err}")),
                    }],
                ));
                continue;
            }
        };
        let make_bytes = bytes.clone();
        let make_label = label.clone();
        reports.push(benchmark_operation(
            &engine,
            &operation,
            BenchmarkCase {
                input_label: label.clone(),
                file_bytes: bytes.len() as u64,
                make_input: Box::new(move || {
                    InspectInput::from_bytes(make_bytes.clone()).unwrap_or_else(|err| {
                        eprintln!("invalid input for {make_label}: {err}");
                        std::process::exit(1);
                    })
                }),
                options,
                repeats: args.repeats,
            },
            |outcome| outcome.as_ref().ok().map(|out| out.page_count),
        ));
    }

    if args.json {
        let body = reports
            .iter()
            .map(BenchmarkReport::to_json)
            .collect::<Vec<_>>()
            .join(",");
        println!("[{body}]");
        return;
    }

    for report in &reports {
        let first = report.measurements.first();
        let detail = match first {
            Some(m) if m.success => {
                let pages = m
                    .page_count
                    .map_or("? pages".to_string(), |n| format!("{n} pages"));
                let size_mb = m.file_bytes as f64 / 1_048_576.0;
                if report.repeats > 1 {
                    format!(
                        "{pages}, {size_mb:.1} MB, engine mean {:.1} ms (min {:.1}, max {:.1})",
                        report.mean_ms, report.min_ms, report.max_ms
                    )
                } else {
                    format!("{pages}, {size_mb:.1} MB, engine {:.1} ms", report.mean_ms)
                }
            }
            Some(m) => format!(
                "FAILED [{}] {}",
                m.error_code.as_deref().unwrap_or("?"),
                m.error_message.as_deref().unwrap_or("")
            ),
            None => "no runs".to_string(),
        };
        println!("{}: {detail}", report.input_label);
    }
    let failures: usize = reports.iter().map(|r| r.failures).sum();
    println!(
        "files: {}, failures: {}, repeats: {}, mode: {}",
        reports.len(),
        failures,
        args.repeats,
        if args.detailed { "detailed" } else { "basic" },
    );
    if failures > 0 {
        std::process::exit(1);
    }
}
