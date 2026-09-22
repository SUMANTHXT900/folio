//! Developer CLI for `pdf.split`.
//!
//! Filesystem access lives here (a dev-only example), never in the
//! processing core. The core receives bytes plus a structured split plan
//! and returns new documents; reading, writing, and verification happen
//! below.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example split_pdf -- path/to/input.pdf --part 1,2,3 --part 4,5
//! cargo run --example split_pdf -- path/to/input.pdf --part 1,2:cover --part 3 --out-dir out
//! cargo run --example split_pdf -- path/to/input.pdf --part 1,2 --repeat 3 --json
//! ```
//!
//! Part specs are comma-separated 1-based page numbers with an optional
//! `:name` suffix. This tiny CLI syntax is parsed here only; range
//! validation stays in the core.

use std::path::PathBuf;

use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::loader::load_pdf;
use folio_engine::processing::pdf::core::PageNumber;
use folio_engine::processing::pdf::split::{SplitInput, SplitOperation, SplitOptions, SplitPart};
use folio_engine::testing::pdf::{measure_result, summarize_measurements};

fn usage() -> ! {
    eprintln!(
        "usage: cargo run --example split_pdf -- <input.pdf> --part <pages[:name]> [--part ...] [--out-dir DIR] [--repeat N] [--json]"
    );
    std::process::exit(2);
}

/// Parses one `--part` spec (`"1,2,3"` or `"1,2,3:cover"`) into a [`SplitPart`].
fn parse_part(spec: &str) -> SplitPart {
    let (pages_spec, name) = match spec.split_once(':') {
        Some((pages, name)) if !name.is_empty() => (pages, Some(name.to_string())),
        _ => (spec, None),
    };
    let pages: Vec<PageNumber> = pages_spec
        .split(',')
        .filter(|entry| !entry.trim().is_empty())
        .map(|entry| {
            entry.trim().parse::<PageNumber>().unwrap_or_else(|_| {
                eprintln!("invalid page number in --part {spec:?} (expected 1-based integers)");
                std::process::exit(2);
            })
        })
        .collect();
    if pages.is_empty() {
        eprintln!("--part {spec:?} selects no pages");
        std::process::exit(2);
    }
    match name {
        Some(name) => SplitPart::named(pages, name),
        None => SplitPart::new(pages),
    }
}

/// Keeps output filenames filesystem-safe without interpreting names.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "part".to_string()
    } else {
        trimmed
    }
}

fn main() {
    let mut input_path: Option<PathBuf> = None;
    let mut parts: Vec<SplitPart> = Vec::new();
    let mut out_dir: Option<PathBuf> = None;
    let mut repeats: usize = 1;
    let mut json = false;

    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--part" => {
                let spec = raw.next().unwrap_or_else(|| usage());
                parts.push(parse_part(&spec));
            }
            "--out-dir" => {
                out_dir = Some(raw.next().map(PathBuf::from).unwrap_or_else(|| usage()));
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
    if parts.is_empty() {
        eprintln!("provide at least one --part");
        std::process::exit(2);
    }

    let bytes = std::fs::read(&input_path).unwrap_or_else(|err| {
        eprintln!("cannot read {}: {err}", input_path.display());
        std::process::exit(1);
    });
    let out_dir = out_dir.unwrap_or_else(|| {
        std::env::temp_dir().join(format!("folio-split-{}", std::process::id()))
    });
    std::fs::create_dir_all(&out_dir).unwrap_or_else(|err| {
        eprintln!("cannot create {}: {err}", out_dir.display());
        std::process::exit(1);
    });
    let stem = input_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_string());

    let engine = ExecutionEngine::new();
    let label = input_path.to_string_lossy().into_owned();
    let options = SplitOptions::new(parts);

    // Measure (possibly repeated) runs first; files are written from the
    // final run, and console output never pollutes engine timing.
    let mut measurements = Vec::with_capacity(repeats);
    let mut saved: Vec<(PathBuf, u32)> = Vec::new();
    let mut input_page_count: u32 = 0;
    for _ in 0..repeats {
        let input = SplitInput::from_bytes(bytes.clone()).unwrap_or_else(|err| {
            eprintln!("invalid input: {err}");
            std::process::exit(1);
        });
        let result = engine.execute(&SplitOperation, input, options.clone());
        measurements.push(measure_result(
            &result,
            &label,
            bytes.len() as u64,
            |outcome| {
                outcome.as_ref().ok().map(|out| {
                    out.parts
                        .iter()
                        .map(|part| part.document.page_count())
                        .sum()
                })
            },
        ));
        match result.into_outcome() {
            Ok(mut output) => {
                input_page_count = output.input_page_count;
                saved.clear();
                for (index, mut part) in output.parts.drain(..).enumerate() {
                    let file_name = match part.name.as_deref() {
                        Some(name) => {
                            format!("{stem}-part-{}-{}.pdf", index + 1, sanitize(name))
                        }
                        None => format!("{stem}-part-{}.pdf", index + 1),
                    };
                    let path = out_dir.join(file_name);
                    let part_bytes = part.document.save_to_bytes().unwrap_or_else(|err| {
                        eprintln!("cannot serialize part {}: {err}", index + 1);
                        std::process::exit(1);
                    });
                    std::fs::write(&path, &part_bytes).unwrap_or_else(|err| {
                        eprintln!("cannot write {}: {err}", path.display());
                        std::process::exit(1);
                    });
                    // Verify the written file re-loads as a valid PDF.
                    let verify_bytes = std::fs::read(&path).unwrap_or_else(|err| {
                        eprintln!("cannot re-read {}: {err}", path.display());
                        std::process::exit(1);
                    });
                    let verified = load_pdf(&verify_bytes).unwrap_or_else(|err| {
                        eprintln!(
                            "part {} failed to re-load: [{code}] {message}",
                            index + 1,
                            code = err.code(),
                            message = err.message()
                        );
                        std::process::exit(1);
                    });
                    saved.push((path, verified.page_count()));
                }
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

    let report = summarize_measurements("pdf.split", &label, measurements);
    let output_page_counts: Vec<u32> = saved.iter().map(|(_, count)| *count).collect();
    if json {
        println!(
            "{{\
             \"operation\":\"pdf.split\",\
             \"input\":{},\
             \"input_bytes\":{},\
             \"input_page_count\":{},\
             \"part_count\":{},\
             \"output_page_counts\":[{}],\
             \"report\":{} \
             }}",
            json_string(&label),
            bytes.len(),
            input_page_count,
            saved.len(),
            output_page_counts
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(","),
            report.to_json(),
        );
        return;
    }

    println!(
        "input:  {} ({} bytes, {} pages)",
        label,
        bytes.len(),
        input_page_count
    );
    for (index, (path, count)) in saved.iter().enumerate() {
        println!(
            "part {}:  {} ({} pages, verified {})",
            index + 1,
            path.display(),
            count,
            count
        );
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
