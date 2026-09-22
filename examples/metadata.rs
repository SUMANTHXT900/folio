//! Developer CLI for `pdf.read_metadata` + `pdf.set_metadata`.
//!
//! Filesystem access lives here (a dev-only example), never in the
//! processing core. With no `--set`/`--clear` flags the example reads and
//! prints metadata; with flags it applies the patch, writes the output,
//! and re-reads the result to prove the round-trip.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example metadata -- path/to/input.pdf
//! cargo run --example metadata -- path/to/input.pdf --set title="New Title" --clear author
//! cargo run --example metadata -- path/to/input.pdf --set title=T --out out.pdf --repeat 3
//! ```
//!
//! Field names: title, author, subject, keywords, creator, producer,
//! creation_date, modification_date. Dates accept full PDF date strings
//! (`D:YYYYMMDDHHmmSS+HH'mm'`); anything unparseable fails with a clear
//! error before the engine runs.

use std::path::PathBuf;

use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::loader::load_pdf;
use folio_engine::processing::pdf::metadata::{
    format_pdf_date, parse_pdf_date, FieldPatch, MetadataPatch, PdfDate, ReadMetadataInput,
    ReadMetadataOperation, ReadMetadataOptions, SetMetadataInput, SetMetadataOperation,
    SetMetadataOptions,
};
use folio_engine::testing::pdf::{measure_result, summarize_measurements};

const FIELDS: [&str; 8] = [
    "title",
    "author",
    "subject",
    "keywords",
    "creator",
    "producer",
    "creation_date",
    "modification_date",
];

fn usage() -> ! {
    eprintln!(
        "usage: cargo run --example metadata -- <input.pdf> [--set field=value ...] [--clear field ...] [--out out.pdf] [--repeat N]"
    );
    eprintln!("fields: {}", FIELDS.join(", "));
    std::process::exit(2);
}

fn print_metadata(label: &str, meta: &folio_engine::processing::pdf::metadata::DocumentMetadata) {
    println!("{label}:");
    println!(
        "  title:             {}",
        meta.title.as_deref().unwrap_or("-")
    );
    println!(
        "  author:            {}",
        meta.author.as_deref().unwrap_or("-")
    );
    println!(
        "  subject:           {}",
        meta.subject.as_deref().unwrap_or("-")
    );
    println!(
        "  keywords:         {}",
        meta.keywords.as_deref().unwrap_or("-")
    );
    println!(
        "  creator:           {}",
        meta.creator.as_deref().unwrap_or("-")
    );
    println!(
        "  producer:          {}",
        meta.producer.as_deref().unwrap_or("-")
    );
    println!(
        "  creation_date:    {}",
        meta.creation_date
            .as_ref()
            .map(format_pdf_date)
            .unwrap_or("-".to_string())
    );
    println!(
        "  modification_date: {}",
        meta.modification_date
            .as_ref()
            .map(format_pdf_date)
            .unwrap_or("-".to_string())
    );
}

fn parse_date(field: &str, raw: &str) -> PdfDate {
    parse_pdf_date(raw).unwrap_or_else(|| {
        eprintln!("invalid PDF date for {field}: {raw:?} (expected D:YYYYMMDDHHmmSS+HH'mm')");
        std::process::exit(2);
    })
}

fn main() {
    let mut input_path: Option<PathBuf> = None;
    let mut patch = MetadataPatch::default();
    let mut out_path: Option<PathBuf> = None;
    let mut repeats: usize = 1;

    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--set" => {
                let assignment = raw.next().unwrap_or_else(|| usage());
                let (field, value) = assignment.split_once('=').unwrap_or_else(|| usage());
                match field {
                    "title" => patch.title = FieldPatch::Set(value.to_string()),
                    "author" => patch.author = FieldPatch::Set(value.to_string()),
                    "subject" => patch.subject = FieldPatch::Set(value.to_string()),
                    "keywords" => patch.keywords = FieldPatch::Set(value.to_string()),
                    "creator" => patch.creator = FieldPatch::Set(value.to_string()),
                    "producer" => patch.producer = FieldPatch::Set(value.to_string()),
                    "creation_date" => {
                        patch.creation_date = FieldPatch::Set(parse_date(field, value));
                    }
                    "modification_date" => {
                        patch.modification_date = FieldPatch::Set(parse_date(field, value));
                    }
                    _ => {
                        eprintln!(
                            "unknown field: {field} (expected one of {})",
                            FIELDS.join(", ")
                        );
                        std::process::exit(2);
                    }
                }
            }
            "--clear" => {
                let field = raw.next().unwrap_or_else(|| usage());
                match field.as_str() {
                    "title" => patch.title = FieldPatch::Clear,
                    "author" => patch.author = FieldPatch::Clear,
                    "subject" => patch.subject = FieldPatch::Clear,
                    "keywords" => patch.keywords = FieldPatch::Clear,
                    "creator" => patch.creator = FieldPatch::Clear,
                    "producer" => patch.producer = FieldPatch::Clear,
                    "creation_date" => patch.creation_date = FieldPatch::Clear,
                    "modification_date" => patch.modification_date = FieldPatch::Clear,
                    _ => {
                        eprintln!(
                            "unknown field: {field} (expected one of {})",
                            FIELDS.join(", ")
                        );
                        std::process::exit(2);
                    }
                }
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
            "-h" | "--help" => usage(),
            other => {
                if input_path.is_none() {
                    input_path = Some(PathBuf::from(other));
                } else {
                    usage();
                }
            }
        }
    }
    let input_path = input_path.unwrap_or_else(|| usage());
    let bytes = std::fs::read(&input_path).unwrap_or_else(|err| {
        eprintln!("cannot read {}: {err}", input_path.display());
        std::process::exit(1);
    });

    let engine = ExecutionEngine::new();
    let label = input_path.to_string_lossy().into_owned();

    // Read-only path: print metadata with engine timing.
    if patch.is_empty() {
        let input = ReadMetadataInput::from_bytes(bytes.clone()).unwrap_or_else(|err| {
            eprintln!("invalid input: {err}");
            std::process::exit(1);
        });
        let result = engine.execute(&ReadMetadataOperation, input, ReadMetadataOptions::new());
        match result.into_outcome() {
            Ok(out) => {
                print_metadata(&format!("metadata for {label}"), &out.metadata);
                println!("pages: {}", out.page_count);
            }
            Err(err) => {
                eprintln!(
                    "failed [{code}]: {message}",
                    code = err.code(),
                    message = err.message()
                );
                std::process::exit(1);
            }
        }
        return;
    }

    let out_path = out_path.unwrap_or_else(|| {
        let stem = input_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "output".to_string());
        PathBuf::from(format!("{stem}-metadata.pdf"))
    });

    // Measure (possibly repeated) runs first; the saved file comes from the
    // final run, and console output never pollutes engine timing.
    let mut saved_bytes: Vec<u8> = Vec::new();
    let mut page_count: u32 = 0;
    let mut measurements = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let input = SetMetadataInput::from_bytes(bytes.clone()).unwrap_or_else(|err| {
            eprintln!("invalid input: {err}");
            std::process::exit(1);
        });
        let result = engine.execute(
            &SetMetadataOperation,
            input,
            SetMetadataOptions::new(patch.clone()),
        );
        measurements.push(measure_result(
            &result,
            &label,
            bytes.len() as u64,
            |outcome| outcome.as_ref().ok().map(|out| out.page_count),
        ));
        match result.into_outcome() {
            Ok(mut out) => {
                page_count = out.page_count;
                saved_bytes = out.document.save_to_bytes().unwrap_or_else(|err| {
                    eprintln!("serialization failed: {err}");
                    std::process::exit(1);
                });
            }
            Err(err) => {
                eprintln!(
                    "failed [{code}]: {message}",
                    code = err.code(),
                    message = err.message()
                );
                std::process::exit(1);
            }
        }
    }
    std::fs::write(&out_path, &saved_bytes).unwrap_or_else(|err| {
        eprintln!("cannot write {}: {err}", out_path.display());
        std::process::exit(1);
    });

    // Prove the round-trip: reopen the written file and print its metadata.
    let reloaded = load_pdf(&saved_bytes).unwrap_or_else(|err| {
        eprintln!("written file does not re-parse: {err}");
        std::process::exit(1);
    });
    print_metadata(
        &format!("metadata for {} (re-read)", out_path.display()),
        &folio_engine::processing::pdf::metadata::DocumentMetadata::from_raw(&reloaded.metadata()),
    );
    println!("pages: {page_count}");
    let report = summarize_measurements("pdf.set_metadata", &label, measurements);
    if repeats > 1 {
        println!(
            "engine:   mean {:.1} ms (min {:.1}, max {:.1}) over {repeats} runs",
            report.mean_ms, report.min_ms, report.max_ms
        );
    } else {
        println!("engine:   {:.1} ms", report.mean_ms);
    }
}
