//! Manual developer harness for the real-world `test pdfs/` corpus.
//!
//! Filesystem access lives here (a dev-only example), never in the
//! processing core. The core receives only bytes and returns structured
//! data; all human formatting happens below.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example inspect_pdf -- path/to/file.pdf          # basic
//! cargo run --example inspect_pdf -- path/to/file.pdf --pages  # detailed
//! ```

use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::inspect::{InspectInput, InspectOperation, InspectOptions};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| {
        eprintln!("usage: cargo run --example inspect_pdf -- <path-to-pdf> [--pages]");
        std::process::exit(2);
    });
    let detailed = args.any(|arg| arg == "--pages" || arg == "-p");
    let options = if detailed {
        InspectOptions::detailed()
    } else {
        InspectOptions::basic()
    };

    let bytes = std::fs::read(&path).unwrap_or_else(|err| {
        eprintln!("cannot read {path}: {err}");
        std::process::exit(1);
    });

    let input = InspectInput::from_bytes(bytes).unwrap_or_else(|err| {
        eprintln!("invalid input: {err}");
        std::process::exit(1);
    });

    let engine = ExecutionEngine::new();
    let result = engine.execute(&InspectOperation, input, options);

    // Timing below is authoritative: it comes from the engine's monotonic
    // clock, not from any harness stopwatch.
    println!("PDF: {path}");
    println!("Status: {:?}", result.status());
    println!("Engine duration: {:?}", result.duration());
    println!("Started:   {:?}", result.started_at());
    println!("Completed: {:?}", result.completed_at());

    match result.into_outcome() {
        Ok(out) => {
            println!("Pages: {}", out.page_count);
            println!("PDF version: {}", out.pdf_version);
            println!("Encrypted: {}", out.encrypted);
            if let Some(title) = out.metadata.title.as_deref() {
                println!("Title: {title}");
            }
            if let Some(author) = out.metadata.author.as_deref() {
                println!("Author: {author}");
            }
            if let Some(producer) = out.metadata.producer.as_deref() {
                println!("Producer: {producer}");
            }
            match out.pages.as_ref() {
                Some(pages) => {
                    let preview = pages.len().min(10);
                    for page in &pages[..preview] {
                        println!(
                            "Page {}: {:.2} x {:.2} pt, rotation {}°",
                            page.page_number, page.width_pt, page.height_pt, page.rotation_deg
                        );
                    }
                    if pages.len() > preview {
                        println!("… ({} more pages)", pages.len() - preview);
                    }
                }
                None => println!("(basic inspection — rerun with --pages for page details)"),
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
