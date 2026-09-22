//! Developer CLI for `pdf.rotate`.
//!
//! Filesystem access lives here (a dev-only example), never in the
//! processing core. The core receives bytes plus a structured page list
//! and angle, and returns a new document; reading, writing, and
//! verification happen below.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example rotate_pdf -- path/to/input.pdf --pages 2,4 --angle 90
//! cargo run --example rotate_pdf -- path/to/input.pdf --pages 1 --angle -90 --out out.pdf
//! cargo run --example rotate_pdf -- path/to/input.pdf --pages 2 --angle 90 --repeat 3 --json
//! ```
//!
//! Page and angle specs are comma-separated integers parsed here only;
//! rotation validation stays in the core.

use std::path::PathBuf;

use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::loader::load_pdf;
use folio_engine::processing::pdf::core::PageNumber;
use folio_engine::processing::pdf::rotate::{RotateInput, RotateOperation, RotateOptions};
use folio_engine::testing::pdf::{measure_result, summarize_measurements};

fn usage() -> ! {
    eprintln!(
        "usage: cargo run --example rotate_pdf -- <input.pdf> --pages <pages> --angle <deg> [--out out.pdf] [--repeat N] [--json]"
    );
    std::process::exit(2);
}

/// Parses a comma-separated integer list (`"2,4"` / `"90"` / `"-90"`).
fn parse_int_list(spec: &str, flag: &str) -> Vec<i32> {
    spec.split(',')
        .filter(|entry| !entry.trim().is_empty())
        .map(|entry| {
            entry.trim().parse::<i32>().unwrap_or_else(|_| {
                eprintln!("invalid integer in {flag} {spec:?} (expected integers)");
                std::process::exit(2);
            })
        })
        .collect()
}

fn main() {
    let mut input_path: Option<PathBuf> = None;
    let mut pages: Vec<PageNumber> = Vec::new();
    let mut angle: Option<i32> = None;
    let mut out_path: Option<PathBuf> = None;
    let mut repeats: usize = 1;
    let mut json = false;

    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--pages" => {
                let spec = raw.next().unwrap_or_else(|| usage());
                pages = parse_int_list(&spec, "--pages")
                    .into_iter()
                    .map(|entry| {
                        u32::try_from(entry).unwrap_or_else(|_| {
                            eprintln!("invalid page number {entry} (expected 1-based integers)");
                            std::process::exit(2);
                        })
                    })
                    .collect();
            }
            "--angle" => {
                let spec = raw.next().unwrap_or_else(|| usage());
                let values = parse_int_list(&spec, "--angle");
                if values.len() != 1 {
                    eprintln!("--angle expects a single integer, got {spec:?}");
                    std::process::exit(2);
                }
                angle = Some(values[0]);
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
    let angle = angle.unwrap_or_else(|| {
        eprintln!("provide --angle with the relative rotation in degrees");
        std::process::exit(2);
    });

    let bytes = std::fs::read(&input_path).unwrap_or_else(|err| {
        eprintln!("cannot read {}: {err}", input_path.display());
        std::process::exit(1);
    });
    let out_path = out_path.unwrap_or_else(|| {
        let stem = input_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "output".to_string());
        PathBuf::from(format!("{stem}-rotated.pdf"))
    });

    let engine = ExecutionEngine::new();
    let label = input_path.to_string_lossy().into_owned();
    let options = RotateOptions::new(pages.clone(), angle);

    // Measure (possibly repeated) runs first; the file is written from the
    // final run, and console output never pollutes engine timing.
    let mut measurements = Vec::with_capacity(repeats);
    let mut saved_bytes: Vec<u8> = Vec::new();
    let mut saved_pages: u32 = 0;
    for _ in 0..repeats {
        let input = RotateInput::from_bytes(bytes.clone()).unwrap_or_else(|err| {
            eprintln!("invalid input: {err}");
            std::process::exit(1);
        });
        let result = engine.execute(&RotateOperation, input, options.clone());
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

    // Verify the written file re-loads as a valid PDF and report the
    // effective rotation of every output page (truncated for huge docs).
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
    let rotations: Vec<i32> = (1..=verified.page_count())
        .map(|n| {
            verified.effective_rotation(n).unwrap_or_else(|err| {
                eprintln!("cannot read rotation of output page {n}: {err}");
                std::process::exit(1);
            })
        })
        .collect();

    let report = summarize_measurements("pdf.rotate", &label, measurements);
    if json {
        println!(
            "{{\
             \"operation\":\"pdf.rotate\",\
             \"input\":{},\
             \"input_bytes\":{},\
             \"input_page_count\":{},\
             \"selected_pages\":[{}],\
             \"selected_page_count\":{},\
             \"angle_deg\":{},\
             \"output_page_count\":{},\
             \"report\":{} \
             }}",
            json_string(&label),
            bytes.len(),
            verified.page_count(),
            pages
                .iter()
                .map(PageNumber::to_string)
                .collect::<Vec<_>>()
                .join(","),
            pages.len(),
            angle,
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
    println!("pages:  {pages:?}");
    println!("angle:  {angle}°");
    println!(
        "output: {} ({} pages, verified {})",
        out_path.display(),
        saved_pages,
        verified.page_count()
    );
    const PREVIEW: usize = 20;
    let preview: Vec<String> = rotations
        .iter()
        .take(PREVIEW)
        .enumerate()
        .map(|(index, rotation)| format!("{}:{}°", index + 1, rotation))
        .collect();
    if rotations.len() > PREVIEW {
        println!(
            "rotations: {} … ({} more pages)",
            preview.join(" "),
            rotations.len() - PREVIEW
        );
    } else {
        println!("rotations: {}", preview.join(" "));
    }
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
