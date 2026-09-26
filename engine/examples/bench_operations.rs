//! Engine bench runner for PERFORMANCE.md P4 item 15.
//!
//! Benchmarks `pdf.merge` / `pdf.split` / `pdf.rotate` / `pdf.inspect`
//! (detailed) / `pdf.images_to_pdf` over synthetic in-memory documents at
//! {1, 10, 50 pages}, plus optional local corpus files via `--dir`.
//!
//! Filesystem access lives here (a dev-only example), never in the
//! processing core. Synthetic fixtures are built in memory with `lopdf`
//! (dev-dependency, test-only — same pattern as `tests/common`); corpus
//! files are only read, never written. The corpus directory is opt-in and
//! gitignored (`test pdfs/`); a missing corpus is never an error unless
//! `--dir` was explicitly given.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example bench_operations
//! cargo run --example bench_operations -- --repeat 3 --json
//! cargo run --example bench_operations -- --dir "../test pdfs" --repeat 3
//! ```
//!
//! Timing is authoritative: every measurement uses the engine's monotonic
//! clock via `testing::pdf` helpers. All runs complete before anything is
//! printed, so console output never pollutes a measurement.

use std::path::PathBuf;

use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::{load_pdf, PageNumber};
use folio_engine::processing::pdf::images_to_pdf::{
    ImageInput, ImagesToPdfInput, ImagesToPdfOperation, ImagesToPdfOptions,
};
use folio_engine::processing::pdf::inspect::{InspectInput, InspectOperation, InspectOptions};
use folio_engine::processing::pdf::merge::{MergeInput, MergeOperation, MergeOptions};
use folio_engine::processing::pdf::rotate::{RotateInput, RotateOperation, RotateOptions};
use folio_engine::processing::pdf::split::{SplitInput, SplitOperation, SplitOptions, SplitPart};
use folio_engine::testing::pdf::{
    benchmark_operation, summarize_measurements, BenchmarkCase, BenchmarkMeasurement,
    BenchmarkReport,
};

/// Synthetic document sizes (pages) benched for every operation.
const SYNTHETIC_SIZES: [u32; 3] = [1, 10, 50];

/// One bench target: label plus bytes plus known page count.
struct BenchDoc {
    label: String,
    bytes: Vec<u8>,
    pages: u32,
}

fn usage() -> ! {
    eprintln!(
        "usage: cargo run --example bench_operations -- [--dir DIR] [--repeat N] [--json]\n\
         \n\
         Without --dir only synthetic in-memory documents ({{1, 10, 50 pages}}) are benched.\n\
         With --dir DIR, every *.pdf in DIR is additionally benched (read-only)."
    );
    std::process::exit(2);
}

fn main() {
    let mut dir: Option<PathBuf> = None;
    let mut repeats: usize = 1;
    let mut json = false;

    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--dir" => {
                dir = Some(raw.next().map(PathBuf::from).unwrap_or_else(|| usage()));
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
            other => {
                eprintln!("unexpected argument: {other}");
                usage();
            }
        }
    }

    // Synthetic targets: N plain US Letter pages, empty content streams.
    let mut docs: Vec<BenchDoc> = SYNTHETIC_SIZES
        .iter()
        .map(|&n| {
            let bytes = synthetic_pdf(n);
            BenchDoc {
                label: format!("synthetic-{n}p"),
                bytes,
                pages: n,
            }
        })
        .collect();

    // Optional corpus targets (read-only). An explicitly given --dir that
    // cannot be listed is a usage error; otherwise files that fail to read
    // or parse are recorded as failed measurements, never fatal.
    let mut io_failures: Vec<BenchmarkReport> = Vec::new();
    if let Some(dir) = dir {
        for (label, bytes) in discover_pdfs(&dir) {
            match load_pdf(&bytes) {
                Ok(doc) => docs.push(BenchDoc {
                    label,
                    pages: doc.page_count(),
                    bytes,
                }),
                Err(err) => io_failures.push(summarize_measurements(
                    "pdf.inspect",
                    &label.clone(),
                    vec![BenchmarkMeasurement {
                        operation: "pdf.inspect".to_string(),
                        input_label: label,
                        file_bytes: bytes.len() as u64,
                        page_count: None,
                        success: false,
                        engine_duration_ms: 0.0,
                        timestamp_unix_ms: 0,
                        error_code: Some(err.code().code_str().to_string()),
                        error_message: Some(err.message().to_string()),
                    }],
                )),
            }
        }
    }

    let engine = ExecutionEngine::new();

    // Measure everything first; print only afterwards.
    let mut reports: Vec<BenchmarkReport> = Vec::new();
    reports.extend(io_failures);
    for doc in &docs {
        reports.push(bench_inspect(&engine, doc, repeats));
        reports.push(bench_rotate_all(&engine, doc, repeats));
        reports.push(bench_split_halves(&engine, doc, repeats));
        reports.push(bench_merge_self(&engine, doc, repeats));
    }
    for &n in &SYNTHETIC_SIZES {
        reports.push(bench_images_to_pdf(&engine, n, repeats));
    }

    if json {
        let body = reports
            .iter()
            .map(BenchmarkReport::to_json)
            .collect::<Vec<_>>()
            .join(",");
        println!("{{\"repeats\":{repeats},\"reports\":[{body}]}}");
        return;
    }

    for report in &reports {
        let first = report.measurements.first();
        let detail = match first {
            Some(m) if m.success => {
                let size = m.file_bytes;
                let pages = m
                    .page_count
                    .map_or("? pages".to_string(), |n| format!("{n} pages"));
                if report.repeats > 1 {
                    format!(
                        "{pages}, {size} bytes, engine mean {:.1} ms (min {:.1}, max {:.1}) over {} runs",
                        report.mean_ms, report.min_ms, report.max_ms, report.repeats,
                    )
                } else {
                    format!("{pages}, {size} bytes, engine {:.1} ms", report.mean_ms)
                }
            }
            Some(m) => format!(
                "FAILED [{}] {}",
                m.error_code.as_deref().unwrap_or("?"),
                m.error_message.as_deref().unwrap_or("")
            ),
            None => "no runs".to_string(),
        };
        println!("{} {}: {detail}", report.operation, report.input_label);
    }
    let failures: usize = reports.iter().map(|r| r.failures).sum();
    println!(
        "cases: {}, failures: {}, repeats: {}",
        reports.len(),
        failures,
        repeats,
    );
    if failures > 0 {
        std::process::exit(1);
    }
}

/// Builds an N-page synthetic PDF: plain US Letter pages with empty
/// content streams (same shape as the `tests/common` builders).
fn synthetic_pdf(pages: u32) -> Vec<u8> {
    use lopdf::{dictionary, Document, Object, Stream};

    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let mut kids = Vec::with_capacity(pages as usize);
    for _ in 0..pages {
        let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => content_id,
        });
        kids.push(Object::from(page_id));
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(kids),
            "Count" => Object::from(pages as i64),
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)
        .expect("synthetic fixture serializes");
    bytes
}

/// Builds one tiny deterministic PNG (8x8 RGB gradient) for the
/// `images_to_pdf` bench. Small on purpose: the bench measures engine
/// plumbing per page, not codec throughput on photos.
fn synthetic_png(seed: u32) -> Vec<u8> {
    use image::ImageEncoder;

    let (w, h) = (8u32, 8u32);
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            rgb.push((x * 32 + seed) as u8);
            rgb.push((y * 32 + seed * 3) as u8);
            rgb.push(128u8);
        }
    }
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&rgb, w, h, image::ExtendedColorType::Rgb8)
        .expect("synthetic png encodes");
    bytes
}

/// Lists `*.pdf` files directly inside `dir`, sorted by path. Read errors
/// surface here (explicit `--dir`); per-file failures surface as failed
/// measurements at the call site.
fn discover_pdfs(dir: &PathBuf) -> Vec<(String, Vec<u8>)> {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|err| {
        eprintln!("cannot list {}: {err}", dir.display());
        std::process::exit(1);
    });
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        })
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let label = path.to_string_lossy().into_owned();
            match std::fs::read(&path) {
                Ok(bytes) => (label, bytes),
                Err(err) => {
                    eprintln!("cannot read {}: {err}", path.display());
                    std::process::exit(1);
                }
            }
        })
        .collect()
}

fn bench_inspect(engine: &ExecutionEngine, doc: &BenchDoc, repeats: usize) -> BenchmarkReport {
    let operation = InspectOperation;
    let options = InspectOptions::detailed();
    let bytes = doc.bytes.clone();
    let label = doc.label.clone();
    let make_label = label.clone();
    benchmark_operation(
        engine,
        &operation,
        BenchmarkCase {
            input_label: label,
            file_bytes: bytes.len() as u64,
            make_input: Box::new(move || {
                InspectInput::from_bytes(bytes.clone()).unwrap_or_else(|err| {
                    eprintln!("invalid input for {make_label}: {err}");
                    std::process::exit(1);
                })
            }),
            options,
            repeats,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.page_count),
    )
}

fn bench_rotate_all(engine: &ExecutionEngine, doc: &BenchDoc, repeats: usize) -> BenchmarkReport {
    let operation = RotateOperation;
    let pages: Vec<PageNumber> = (1..=doc.pages).collect();
    let options = RotateOptions::new(pages, 90);
    let bytes = doc.bytes.clone();
    let label = doc.label.clone();
    let make_label = label.clone();
    benchmark_operation(
        engine,
        &operation,
        BenchmarkCase {
            input_label: label,
            file_bytes: bytes.len() as u64,
            make_input: Box::new(move || {
                RotateInput::from_bytes(bytes.clone()).unwrap_or_else(|err| {
                    eprintln!("invalid input for {make_label}: {err}");
                    std::process::exit(1);
                })
            }),
            options,
            repeats,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.page_count),
    )
}

fn bench_split_halves(engine: &ExecutionEngine, doc: &BenchDoc, repeats: usize) -> BenchmarkReport {
    let operation = SplitOperation;
    // Two halves (a 1-page doc splits into two single-page parts via the
    // duplicate-page path); every page is copied exactly once per part.
    let mid = (doc.pages.max(1) / 2).max(1);
    let options = if doc.pages <= 1 {
        SplitOptions::new(vec![SplitPart::new(vec![1]), SplitPart::new(vec![1])])
    } else {
        SplitOptions::new(vec![
            SplitPart::new((1..=mid).collect()),
            SplitPart::new((mid + 1..=doc.pages).collect()),
        ])
    };
    let bytes = doc.bytes.clone();
    let label = doc.label.clone();
    let make_label = label.clone();
    benchmark_operation(
        engine,
        &operation,
        BenchmarkCase {
            input_label: label,
            file_bytes: bytes.len() as u64,
            make_input: Box::new(move || {
                SplitInput::from_bytes(bytes.clone()).unwrap_or_else(|err| {
                    eprintln!("invalid input for {make_label}: {err}");
                    std::process::exit(1);
                })
            }),
            options,
            repeats,
        },
        |outcome| {
            outcome.as_ref().ok().map(|out| {
                out.parts
                    .iter()
                    .map(|part| part.document.page_count())
                    .sum()
            })
        },
    )
}

fn bench_merge_self(engine: &ExecutionEngine, doc: &BenchDoc, repeats: usize) -> BenchmarkReport {
    let operation = MergeOperation;
    let options = MergeOptions::new();
    let bytes = doc.bytes.clone();
    let label = doc.label.clone();
    let make_label = label.clone();
    benchmark_operation(
        engine,
        &operation,
        BenchmarkCase {
            input_label: label,
            file_bytes: (bytes.len() * 2) as u64,
            make_input: Box::new(move || {
                let load = |tag: &str| {
                    load_pdf(&bytes).unwrap_or_else(|err| {
                        eprintln!("invalid input for {make_label} ({tag}): {err}");
                        std::process::exit(1);
                    })
                };
                MergeInput::new(vec![load("first"), load("second")])
            }),
            options,
            repeats,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.output_page_count),
    )
}

fn bench_images_to_pdf(engine: &ExecutionEngine, count: u32, repeats: usize) -> BenchmarkReport {
    let operation = ImagesToPdfOperation;
    let options = ImagesToPdfOptions::default_options();
    let images: Vec<Vec<u8>> = (0..count).map(synthetic_png).collect();
    let total_bytes: u64 = images.iter().map(|b| b.len() as u64).sum();
    let label = format!("synthetic-{count}i");
    let make_label = label.clone();
    benchmark_operation(
        engine,
        &operation,
        BenchmarkCase {
            input_label: label,
            file_bytes: total_bytes,
            make_input: Box::new(move || {
                let inputs: Vec<ImageInput> = images
                    .iter()
                    .enumerate()
                    .map(|(i, bytes)| {
                        ImageInput::new(format!("bench-{i}.png"), bytes.clone()).unwrap_or_else(
                            |err| {
                                eprintln!("invalid input for {make_label}: {err}");
                                std::process::exit(1);
                            },
                        )
                    })
                    .collect();
                ImagesToPdfInput::new(inputs)
            }),
            options,
            repeats,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.page_count),
    )
}
