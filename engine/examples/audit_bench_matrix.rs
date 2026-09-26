//! Audit benchmark matrix (additive extension of `bench_operations`).
//!
//! Covers the matrix `bench_operations` does not: image-heavy synthetic
//! PDFs, a many-image set, a 12MP-class synthetic image, the
//! single-call-vs-sharded `images_to_pdf` path (mirroring the app's
//! `imageSharding.ts` orchestration), worst-case cancel latency with a
//! 50 ms cancel trigger, and a parse-vs-execute split for the document
//! ops. Small/medium plain synthetic PDFs are included as the baseline
//! every other row compares against.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example audit_bench_matrix
//! cargo run --example audit_bench_matrix -- --repeat 3 --json
//! ```
//!
//! Timing is authoritative: operation rows use the engine's monotonic
//! clock via `testing::pdf`; parse rows use a wall timer around the
//! `load_pdf` boundary only. All runs complete before anything is
//! printed, so console output never pollutes a measurement. Numbers are
//! indicative (debug or release build on the machine at hand) — never
//! present them as canonical benchmarks.

use std::time::{Duration, Instant};

use folio_engine::execution::cancellation::CancellationSource;
use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::processing::pdf::core::{load_pdf, PdfDocument};
use folio_engine::processing::pdf::images_to_pdf::{
    ImageInput, ImagesToPdfInput, ImagesToPdfOperation, ImagesToPdfOptions,
};
use folio_engine::processing::pdf::inspect::{InspectInput, InspectOperation, InspectOptions};
use folio_engine::processing::pdf::merge::{MergeInput, MergeOperation, MergeOptions};
use folio_engine::testing::pdf::{
    benchmark_operation, summarize_measurements, BenchmarkCase, BenchmarkMeasurement,
    BenchmarkReport,
};

/// Default repeats: the matrix reports min/mean/median, which needs ≥3.
const DEFAULT_REPEATS: usize = 3;

/// 12MP-class frame: 4000×3000 (matches the engine's incremental-embed
/// comment scale; generated as JPEG so setup stays fast).
const BIG_W: u32 = 4000;
const BIG_H: u32 = 3000;

fn usage() -> ! {
    eprintln!("usage: cargo run --example audit_bench_matrix -- [--repeat N] [--json]");
    std::process::exit(2);
}

fn main() {
    let mut repeats: usize = DEFAULT_REPEATS;
    let mut json = false;
    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
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

    // Fixtures are built once up front; every repeat clones fresh inputs
    // out of them, so setup cost never leaks into a measurement.
    let plain_10 = synthetic_pdf(10);
    let plain_50 = synthetic_pdf(50);
    let heavy_10 = image_heavy_pdf(10);
    let many_pngs: Vec<Vec<u8>> = (0..24).map(|s| synthetic_png(s, 32, 32)).collect();
    let big_jpeg = synthetic_jpeg(BIG_W, BIG_H);

    let engine = ExecutionEngine::new();

    // A. Baselines: small/medium plain synthetic PDFs.
    // B. Image-heavy synthetic PDF (every page carries an image XObject).
    // C. Many-image set: 24 small PNGs in one call.
    // D. 12MP-class single image.
    let mut reports = vec![
        bench_inspect(&engine, "synthetic-10p", &plain_10, repeats),
        bench_inspect(&engine, "synthetic-50p", &plain_50, repeats),
        bench_merge_self(&engine, "synthetic-10p", &plain_10, repeats),
        bench_merge_self(&engine, "synthetic-50p", &plain_50, repeats),
        bench_inspect(&engine, "image-heavy-10p", &heavy_10, repeats),
        bench_merge_self(&engine, "image-heavy-10p", &heavy_10, repeats),
        bench_images(&engine, "many-24i", &many_pngs, repeats),
        bench_images(&engine, "12mp-1i", std::slice::from_ref(&big_jpeg), repeats),
    ];

    // E. Single call vs sharded (2 shards of 4 + merge), 8 mid-size PNGs.
    let shard_images: Vec<Vec<u8>> = (0..8).map(|s| synthetic_png(s, 128, 128)).collect();
    reports.push(bench_images(
        &engine,
        "shard-single-8i",
        &shard_images,
        repeats,
    ));
    reports.push(bench_sharded(&engine, &shard_images, repeats));

    // F + G print their own lines (custom timing, not BenchmarkReports).
    let cancel_lines = bench_cancel_at_50ms(&engine, repeats);
    let split_lines = bench_parse_vs_execute(&plain_50, &heavy_10, repeats);

    if json {
        let body = reports
            .iter()
            .map(BenchmarkReport::to_json)
            .collect::<Vec<_>>()
            .join(",");
        println!("{{\"repeats\":{repeats},\"reports\":[{body}]}}");
        for line in cancel_lines.iter().chain(split_lines.iter()) {
            println!("{line}");
        }
        return;
    }

    for report in &reports {
        println!("{} | {}", report.operation, summarize_report(report));
    }
    for line in cancel_lines.iter().chain(split_lines.iter()) {
        println!("{line}");
    }
    let failures: usize = reports.iter().map(|r| r.failures).sum();
    println!(
        "cases: {}, failures: {}, repeats: {}",
        reports.len(),
        failures,
        repeats
    );
    if failures > 0 {
        std::process::exit(1);
    }
}

fn summarize_report(report: &BenchmarkReport) -> String {
    let first = report.measurements.first();
    match first {
        Some(m) if m.success => {
            let size = m.file_bytes;
            let pages = m
                .page_count
                .map_or("? pages".to_string(), |n| format!("{n} pages"));
            format!(
                "{}: {pages}, {size} bytes, min {:.1} ms, mean {:.1} ms, median {:.1} ms over {} runs",
                report.input_label, report.min_ms, report.mean_ms, report.median_ms, report.repeats,
            )
        }
        Some(m) => format!(
            "{}: FAILED [{}] {}",
            report.input_label,
            m.error_code.as_deref().unwrap_or("?"),
            m.error_message.as_deref().unwrap_or("")
        ),
        None => format!("{}: no runs", report.input_label),
    }
}

/// N plain US Letter pages with empty content streams.
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

/// N pages, each carrying a small raw-RGB image XObject: measures the
/// image-presence path (resource walks, XObject copies) without any real
/// photo bytes.
fn image_heavy_pdf(pages: u32) -> Vec<u8> {
    use lopdf::{dictionary, Document, Object, Stream};

    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let mut kids = Vec::with_capacity(pages as usize);
    for i in 0..pages {
        let pixels = vec![(i * 7) as u8; 8 * 8 * 3];
        let image_id = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => Object::from(8),
                "Height" => Object::from(8),
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => Object::from(8),
            },
            pixels,
        ));
        let resources_id = doc.add_object(dictionary! {
            "XObject" => dictionary! {
                "Im1" => image_id,
            },
        });
        let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => resources_id,
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
        .expect("image-heavy fixture serializes");
    bytes
}

/// Deterministic gradient PNG (decode path, never passthrough).
fn synthetic_png(seed: u32, width: u32, height: u32) -> Vec<u8> {
    use image::ImageEncoder;

    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            rgb.push((x.wrapping_add(seed * 13)) as u8);
            rgb.push((y.wrapping_add(seed * 29)) as u8);
            rgb.push(128u8);
        }
    }
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .expect("synthetic png encodes");
    bytes
}

/// Deterministic gradient JPEG (12MP-class: exercises the incremental
/// single-image-retention path at photo scale).
fn synthetic_jpeg(width: u32, height: u32) -> Vec<u8> {
    use image::ImageEncoder;

    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            rgb.push((x % 251) as u8);
            rgb.push((y % 251) as u8);
            rgb.push(((x + y) % 251) as u8);
        }
    }
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 85)
        .write_image(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .expect("synthetic jpeg encodes");
    bytes
}

fn images_input(images: &[Vec<u8>]) -> ImagesToPdfInput {
    ImagesToPdfInput::new(
        images
            .iter()
            .enumerate()
            .map(|(i, bytes)| {
                ImageInput::new(format!("audit-{i}.png"), bytes.clone())
                    .expect("bench input builds")
            })
            .collect(),
    )
}

fn bench_inspect(
    engine: &ExecutionEngine,
    label: &str,
    bytes: &[u8],
    repeats: usize,
) -> BenchmarkReport {
    let operation = InspectOperation;
    let options = InspectOptions::detailed();
    let owned = bytes.to_vec();
    let case_label = label.to_string();
    benchmark_operation(
        engine,
        &operation,
        BenchmarkCase {
            input_label: case_label,
            file_bytes: owned.len() as u64,
            make_input: Box::new(move || {
                InspectInput::from_bytes(owned.clone()).expect("bench input parses")
            }),
            options,
            repeats,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.page_count),
    )
}

fn bench_merge_self(
    engine: &ExecutionEngine,
    label: &str,
    bytes: &[u8],
    repeats: usize,
) -> BenchmarkReport {
    let operation = MergeOperation;
    let options = MergeOptions::new();
    let owned = bytes.to_vec();
    let case_label = format!("{label}-merge-self");
    benchmark_operation(
        engine,
        &operation,
        BenchmarkCase {
            input_label: case_label,
            file_bytes: (owned.len() * 2) as u64,
            make_input: Box::new(move || {
                MergeInput::new(vec![
                    load_pdf(&owned).expect("bench input parses"),
                    load_pdf(&owned).expect("bench input parses"),
                ])
            }),
            options,
            repeats,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.output_page_count),
    )
}

fn bench_images(
    engine: &ExecutionEngine,
    label: &str,
    images: &[Vec<u8>],
    repeats: usize,
) -> BenchmarkReport {
    let operation = ImagesToPdfOperation;
    let options = ImagesToPdfOptions::default_options();
    let owned = images.to_vec();
    let total_bytes: u64 = owned.iter().map(|b| b.len() as u64).sum();
    benchmark_operation(
        engine,
        &operation,
        BenchmarkCase {
            input_label: label.to_string(),
            file_bytes: total_bytes,
            make_input: Box::new(move || images_input(&owned)),
            options,
            repeats,
        },
        |outcome| outcome.as_ref().ok().map(|out| out.page_count),
    )
}

/// Sharded path: two sequential 4-image `images_to_pdf` calls plus a
/// merge of the two sub-PDFs (the app shards concurrently; the engine
/// measures the same work sequentially, so this is the orchestration
/// overhead ceiling, not app wall time). The reported duration is the
/// sum of the three engine-authoritative durations.
fn bench_sharded(engine: &ExecutionEngine, images: &[Vec<u8>], repeats: usize) -> BenchmarkReport {
    use std::time::{SystemTime, UNIX_EPOCH};

    let owned = images.to_vec();
    let total_bytes: u64 = owned.iter().map(|b| b.len() as u64).sum();
    let mut measurements = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let first = engine.execute(
            &ImagesToPdfOperation,
            images_input(&owned[..owned.len() / 2]),
            ImagesToPdfOptions::default_options(),
        );
        let second = engine.execute(
            &ImagesToPdfOperation,
            images_input(&owned[owned.len() / 2..]),
            ImagesToPdfOptions::default_options(),
        );
        let first_ms = first.duration().as_secs_f64() * 1000.0;
        let second_ms = second.duration().as_secs_f64() * 1000.0;
        let mut engine_ms = first_ms + second_ms;
        let mut success = false;
        let mut page_count: Option<u32> = None;
        let mut error: Option<(String, String)> = None;
        match (first.into_outcome(), second.into_outcome()) {
            (Ok(a), Ok(b)) => {
                let merged = engine.execute(
                    &MergeOperation,
                    MergeInput::new(vec![a.document, b.document]),
                    MergeOptions::new(),
                );
                engine_ms += merged.duration().as_secs_f64() * 1000.0;
                match merged.into_outcome() {
                    Ok(out) => {
                        success = true;
                        page_count = Some(out.output_page_count);
                    }
                    Err(err) => {
                        error =
                            Some((err.code().code_str().to_string(), err.message().to_string()));
                    }
                }
            }
            (a, b) => {
                let err = a.err().or_else(|| b.err()).expect("one side failed");
                error = Some((err.code().code_str().to_string(), err.message().to_string()));
            }
        }
        let (error_code, error_message) = error
            .map(|(code, message)| (Some(code), Some(message)))
            .unwrap_or((None, None));
        measurements.push(BenchmarkMeasurement {
            operation: "pdf.images_to_pdf+merge".to_string(),
            input_label: "shard-2x4i-sequential".to_string(),
            file_bytes: total_bytes,
            page_count,
            success,
            engine_duration_ms: engine_ms,
            timestamp_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
                .unwrap_or(0),
            error_code,
            error_message,
        });
    }
    summarize_measurements(
        "pdf.images_to_pdf+merge",
        "shard-2x4i-sequential",
        measurements,
    )
}

/// Worst-case cancel latency: a heavy run (4 mid-size PNG decodes, well
/// over 50 ms in debug) with a spawner thread flipping the token after
/// 50 ms. Reports the engine-measured time until the run observes
/// cancellation — the worst case a 50 ms UI cancel budget must absorb.
fn bench_cancel_at_50ms(engine: &ExecutionEngine, repeats: usize) -> Vec<String> {
    let images: Vec<Vec<u8>> = (0..4).map(|s| synthetic_png(s, 1500, 1000)).collect();
    let total_bytes: u64 = images.iter().map(|b| b.len() as u64).sum();
    let mut durations: Vec<f64> = Vec::with_capacity(repeats);
    let mut states: Vec<String> = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let source = CancellationSource::new();
        let token = source.token();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            token.cancel();
        });
        let result = engine.execute_with_cancellation(
            &ImagesToPdfOperation,
            images_input(&images),
            ImagesToPdfOptions::default_options(),
            source.token(),
        );
        durations.push(result.duration().as_secs_f64() * 1000.0);
        states.push(format!("{:?}", result.status()));
    }
    durations.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mean = durations.iter().sum::<f64>() / durations.len() as f64;
    let median = durations[durations.len() / 2];
    vec![format!(
        "cancel-at-50ms pdf.images_to_pdf 4x1500x1000png ({} bytes): states [{}], time-to-observe min {:.1} ms, mean {:.1} ms, median {:.1} ms over {} runs",
        total_bytes,
        states.join(","),
        durations[0],
        mean,
        median,
        repeats,
    )]
}

/// Parse-vs-execute split: wall time around the `load_pdf` boundary vs
/// the engine-measured `inspect` execute on the same bytes.
fn bench_parse_vs_execute(plain_50: &[u8], heavy_10: &[u8], repeats: usize) -> Vec<String> {
    let engine = ExecutionEngine::new();
    let mut lines = Vec::new();
    for (label, bytes) in [("synthetic-50p", plain_50), ("image-heavy-10p", heavy_10)] {
        let mut parse_ms: Vec<f64> = Vec::new();
        let mut exec_ms: Vec<f64> = Vec::new();
        for _ in 0..repeats {
            let started = Instant::now();
            let doc: PdfDocument = load_pdf(bytes).expect("bench input parses");
            parse_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            let pages = doc.page_count();
            let result = engine.execute(
                &InspectOperation,
                InspectInput::from_bytes(bytes.to_vec()).expect("bench input builds"),
                InspectOptions::detailed(),
            );
            assert!(result.is_success());
            let _ = pages;
            exec_ms.push(result.duration().as_secs_f64() * 1000.0);
        }
        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        lines.push(format!(
            "parse-vs-execute {label} ({} bytes): parse mean {:.2} ms, execute mean {:.2} ms over {} runs",
            bytes.len(),
            mean(&parse_ms),
            mean(&exec_ms),
            repeats,
        ));
    }
    lines
}
