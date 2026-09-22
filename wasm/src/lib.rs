//! Thin WASM API layer over the real `folio-engine` core.
//!
//! ```text
//! Web Worker
//!    │  execute(operation, names, blobs, options_json, emit)
//!    ▼
//! WasmEngine (this file: translation ONLY)
//!    │  typed Input/Options + ExecutionEngine::execute_with_cancellation
//!    ▼
//! Real Rust Engine → lopdf
//! ```
//!
//! This layer contains NO PDF processing logic: it converts JS values to
//! the engine's typed inputs, forwards REAL progress/log events to a JS
//! callback, and converts the typed outcome (plus serialized output PDFs)
//! back to JS. Validation, timing, errors, and cancellation semantics are
//! 100% the engine's — identical to native/CLI behavior.
//!
//! Threading model: the worker calls `execute` synchronously on its own
//! thread, so blocking the worker during a run is by design (the UI thread
//! never blocks). One `WasmEngine` is constructed per worker lifecycle and
//! serves many sequential jobs; it is never re-created per operation.
//!
//! Cancellation: cooperative in-engine cancellation cannot be triggered
//! from JS mid-run (the worker thread is inside the synchronous call, so
//! no message can be processed until it returns). The frontend therefore
//! cancels by terminating and recreating the worker; the token below is a
//! fresh uncancelled one per execution. See the worker/adapter docs.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use folio_engine::core::error::{EngineError, ErrorCode};
use folio_engine::execution::cancellation::CancellationToken;
use folio_engine::execution::job::JobId;
use folio_engine::execution::progress::{ProgressEvent, ProgressSink};
use folio_engine::execution::scheduler::ExecutionEngine;
use folio_engine::observability::event::EngineEvent;
use folio_engine::observability::logger::EventSink;
use folio_engine::processing::pdf::core::load_pdf;
use folio_engine::processing::pdf::core::PdfDocument;
use folio_engine::processing::pdf::delete::{
    DeletePagesInput, DeletePagesOperation, DeletePagesOptions,
};
use folio_engine::processing::pdf::extract::{
    ExtractPagesInput, ExtractPagesOperation, ExtractPagesOptions,
};
use folio_engine::processing::pdf::images_to_pdf::{
    ImageInput, ImagesToPdfInput, ImagesToPdfOperation, ImagesToPdfOptions, PageSizePolicy,
};
use folio_engine::processing::pdf::inspect::{
    InspectInput, InspectLevel, InspectOperation, InspectOptions, PdfPageInspection,
};
use folio_engine::processing::pdf::merge::{MergeInput, MergeOperation, MergeOptions};
use folio_engine::processing::pdf::metadata::{
    DocumentMetadata, FieldPatch, MetadataPatch, PdfDate, ReadMetadataInput, ReadMetadataOperation,
    ReadMetadataOptions, SetMetadataInput, SetMetadataOperation, SetMetadataOptions,
};
use folio_engine::processing::pdf::reorder::{ReorderInput, ReorderOperation, ReorderOptions};
use folio_engine::processing::pdf::rotate::{RotateInput, RotateOperation, RotateOptions};
use folio_engine::processing::pdf::split::{SplitInput, SplitOperation, SplitOptions, SplitPart};
use js_sys::{Array, Function, Uint8Array};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// Successful dispatch: JSON summary, produced documents (name + doc), and
/// the authoritative monotonic engine duration (captured from the
/// `OperationResult` BEFORE `into_outcome()` consumes it).
type DispatchOk = (Value, Vec<(String, PdfDocument)>, Duration);

/// The engine handle owned by one Web Worker for its whole lifetime.
///
/// Stateless by design: every `execute` builds a fresh `ExecutionEngine`
/// (engines are cheap — three `Arc`s) wired to that call's emit callback.
/// The once-per-worker cost is the WASM *module* instantiation, not this
/// handle — so "initialize once, execute many jobs" holds without sharing
/// mutable engine state across calls.
#[wasm_bindgen]
pub struct WasmEngine {}

#[wasm_bindgen]
impl WasmEngine {
    /// Creates the handle (once per worker). Installs readable panic
    /// messages for the browser console.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Executes one operation synchronously.
    ///
    /// - `operation`: e.g. `"pdf.extract_pages"`.
    /// - `input_names`: `Array<string>`, human labels parallel to blobs.
    /// - `input_blobs`: `Array<Uint8Array>`, real file bytes (transferred;
    ///   PDFs for document ops, images for `pdf.images_to_pdf`).
    /// - `options_json`: JSON string of per-operation options
    ///   (`{level}`, `{pages}`, `{order}`, `{pages,angle_deg}`,
    ///   `{parts:[{pages,name?}]`, `{page_size,background_rgb?}`, `{}`).
    /// - `emit`: JS function called with one JSON string per REAL engine
    ///   progress/log event, in emission order.
    ///
    /// Returns `{ result_json, outputs }`: the terminal result envelope
    /// (same shapes as the former dev bridge: state/timing/summary/error)
    /// plus `outputs: Array<Uint8Array>` of real generated PDFs, aligned
    /// with `result.outputs[].index`. Engine errors are encoded INSIDE the
    /// envelope; this throws only for glue-level misuse (bad arg shapes).
    pub fn execute(
        &self,
        operation: &str,
        input_names: &Array,
        input_blobs: &Array,
        options_json: &str,
        emit: &Function,
    ) -> Result<JsValue, JsValue> {
        let names = read_string_array(input_names, "input_names")?;
        let blobs = read_blob_array(input_blobs)?;
        if names.len() != blobs.len() {
            return Err(glue_error(
                "input_names and input_blobs must be parallel arrays",
            ));
        }
        let options: Value = serde_json::from_str(options_json)
            .map_err(|err| glue_error(&format!("options_json is not valid JSON: {err}")))?;

        let sink = std::sync::Arc::new(CallbackSink::new(emit.clone()));
        let engine = ExecutionEngine::new()
            .with_progress(sink.clone())
            .with_events(sink.clone());
        // Fresh uncancelled token per execution (see module docs: JS cannot
        // flip a flag mid-run on the blocked worker thread; the frontend
        // cancels by worker termination instead).
        let token = CancellationToken::new();

        let outcome: Result<DispatchOk, (EngineError, Duration)> =
            dispatch(&engine, operation, &names, &blobs, &options, token);

        let completed_at_ms = system_millis(crate::clock_now());
        let (envelope, outputs) = match outcome {
            Ok((summary, docs, engine_duration)) => {
                let mut outputs_json = Vec::with_capacity(docs.len());
                let mut outputs_bin = Vec::with_capacity(docs.len());
                for (index, (name, mut document)) in docs.into_iter().enumerate() {
                    let page_count = document.page_count();
                    let bytes = document.save_to_bytes().map_err(|err| {
                        glue_error(&format!("output serialization failed: {err}"))
                    })?;
                    outputs_json.push(json!({
                        "index": index,
                        "name": name,
                        "byte_length": bytes.len(),
                        "page_count": page_count,
                    }));
                    outputs_bin.push(bytes);
                }
                let envelope = json!({
                    "engine_job_id": sink.job_id(),
                    "operation": operation,
                    "state": "completed",
                    "started_at_ms": sink.started_ms(),
                    "completed_at_ms": completed_at_ms,
                    "duration_ms": engine_duration.as_secs_f64() * 1000.0,
                    "progress": 1.0,
                    "result": { "summary": summary, "outputs": outputs_json },
                    "error": Value::Null,
                    "event_count": sink.event_count(),
                });
                (envelope, outputs_bin)
            }
            Err((err, engine_duration)) => {
                let state = if err.code() == ErrorCode::Cancelled {
                    "cancelled"
                } else {
                    "failed"
                };
                let envelope = json!({
                    "engine_job_id": sink.job_id(),
                    "operation": operation,
                    "state": state,
                    "started_at_ms": sink.started_ms(),
                    "completed_at_ms": completed_at_ms,
                    "duration_ms": engine_duration.as_secs_f64() * 1000.0,
                    "progress": Value::Null,
                    "result": Value::Null,
                    "error": {
                        "code": err.code().code_str(),
                        "message": err.message(),
                        "details": err.details(),
                    },
                    "event_count": sink.event_count(),
                });
                (envelope, Vec::new())
            }
        };

        let result_json = serde_json::to_string(&envelope)
            .map_err(|err| glue_error(&format!("result serialization failed: {err}")))?;
        let out_array = Array::new();
        for bytes in &outputs {
            out_array.push(&Uint8Array::from(bytes.as_slice()));
        }
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"result_json".into(), &result_json.into())
            .map_err(|_| glue_error("failed to build return value"))?;
        js_sys::Reflect::set(&obj, &"outputs".into(), &out_array.into())
            .map_err(|_| glue_error("failed to build return value"))?;
        Ok(obj.into())
    }
}

impl Default for WasmEngine {
    fn default() -> Self {
        console_error_panic_hook::set_once();
        Self {}
    }
}

// ---------------------------------------------------------------------------
// Engine dispatch: JS values → typed engine calls (translation only)
// ---------------------------------------------------------------------------

/// Shared per-execution glue state: the emit callback, an event counter,
/// the worker-side start mark, and the real engine job id once observed.
///
/// One `Arc` instance implements BOTH sink traits, so progress and log
/// events share the counter and job capture. Atomics + mutex (not
/// `Cell`/`RefCell`): the sink traits require `Send + Sync`, and
/// single-threaded WASM still checks the bounds.
struct CallbackSink {
    emit: Function,
    count: std::sync::atomic::AtomicUsize,
    started_ms: u64,
    job_id: std::sync::Mutex<Option<String>>,
}

impl CallbackSink {
    fn new(emit: Function) -> Self {
        Self {
            emit,
            count: std::sync::atomic::AtomicUsize::new(0),
            started_ms: system_millis(crate::clock_now()),
            job_id: std::sync::Mutex::new(None),
        }
    }

    fn send(&self, payload: Value) {
        self.count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let text = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
        // A throwing emit callback must never fail the engine run: the
        // event is already recorded conceptually; dropping it is safer
        // than aborting a successful execution.
        let _ = self.emit.call1(&JsValue::NULL, &text.into());
    }

    fn note_job(&self, id: &JobId) {
        let mut slot = self.job_id.lock().expect("glue job-id lock");
        if slot.is_none() {
            *slot = Some(id.to_string());
        }
    }

    fn job_id(&self) -> Value {
        match &*self.job_id.lock().expect("glue job-id lock") {
            Some(id) => Value::from(id.clone()),
            None => Value::Null,
        }
    }

    fn started_ms(&self) -> u64 {
        self.started_ms
    }

    fn event_count(&self) -> usize {
        self.count.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl ProgressSink for CallbackSink {
    fn emit(&self, event: ProgressEvent) {
        self.note_job(event.job_id());
        self.send(json!({
            "timestamp_ms": system_millis(event.timestamp()),
            "kind": "progress",
            "phase": event.phase(),
            "completed": event.completed(),
            "total": event.total(),
            "percentage": event.percentage().map(|p| p / 100.0),
            "message": event.message(),
            "engine_job_id": event.job_id().to_string(),
        }));
    }
}

impl EventSink for CallbackSink {
    fn record(&self, event: EngineEvent) {
        if let Some(id) = event.job_id() {
            self.note_job(id);
        }
        self.send(json!({
            "timestamp_ms": system_millis(event.timestamp()),
            "kind": "log",
            "level": event.level().to_string().to_lowercase(),
            "phase": event.phase(),
            "message": event.message(),
            "operation": event.operation(),
            "engine_job_id": event.job_id().map(JobId::to_string),
        }));
    }
}

/// Decodes a JSON page list. Structural problems are `INVALID_OPTIONS`;
/// range/duplicates semantics stay with the engine (so `999999` reaches
/// it and returns as a real `PAGE_OUT_OF_RANGE`).
fn decode_pages(value: Option<&Value>) -> Result<Vec<u32>, EngineError> {
    let Some(array) = value.and_then(Value::as_array) else {
        return Err(EngineError::new(
            ErrorCode::InvalidOptions,
            "options must include a page list",
        ));
    };
    let mut pages = Vec::with_capacity(array.len());
    for (index, entry) in array.iter().enumerate() {
        match entry.as_u64().and_then(|n| u32::try_from(n).ok()) {
            Some(page) => pages.push(page),
            None => {
                return Err(EngineError::new(
                    ErrorCode::InvalidOptions,
                    format!("page entry {} is not a non-negative integer", index + 1),
                ));
            }
        }
    }
    Ok(pages)
}

/// Decodes a `[r, g, b]` background array. Structural problems are
/// `INVALID_OPTIONS`; the engine owns all image semantics.
fn decode_background(value: &Value) -> Result<[u8; 3], (EngineError, Duration)> {
    let fail = |message: &str| {
        (
            EngineError::new(ErrorCode::InvalidOptions, message),
            Duration::ZERO,
        )
    };
    let Some(array) = value.as_array() else {
        return Err(fail(
            "background_rgb must be an array of three 0-255 integers",
        ));
    };
    if array.len() != 3 {
        return Err(fail(
            "background_rgb must be an array of three 0-255 integers",
        ));
    }
    let mut rgb = [255u8; 3];
    for (index, entry) in array.iter().enumerate() {
        match entry.as_u64().and_then(|n| u8::try_from(n).ok()) {
            Some(byte) => rgb[index] = byte,
            None => {
                return Err(fail(
                    "background_rgb must be an array of three 0-255 integers",
                ));
            }
        }
    }
    Ok(rgb)
}

/// Serializes authoritative metadata for the `pdf.read_metadata`
/// summary. Strings pass through; dates become structured objects (or
/// `null` when absent/unrepresentable).
fn metadata_json(metadata: &DocumentMetadata) -> Value {
    json!({
        "title": metadata.title,
        "author": metadata.author,
        "subject": metadata.subject,
        "keywords": metadata.keywords,
        "creator": metadata.creator,
        "producer": metadata.producer,
        "creation_date": metadata.creation_date.as_ref().map(pdf_date_json),
        "modification_date": metadata.modification_date.as_ref().map(pdf_date_json),
    })
}

fn pdf_date_json(date: &PdfDate) -> Value {
    json!({
        "year": date.year,
        "month": date.month,
        "day": date.day,
        "hour": date.hour,
        "minute": date.minute,
        "second": date.second,
        "tz_offset_minutes": date.tz_offset_minutes,
    })
}

/// Decodes the `pdf.set_metadata` patch object. Wire shape per field:
/// absent = unchanged, `{"op":"clear"}` = clear,
/// `{"op":"set","value":…}` = set (string, or a 7-field date object).
/// Structural problems are `INVALID_OPTIONS`; semantic ones (empty
/// strings, out-of-range date parts) are `INVALID_INPUT` from the
/// engine's own validation.
fn decode_metadata_patch(value: Option<&Value>) -> Result<MetadataPatch, EngineError> {
    let Some(obj) = value.and_then(Value::as_object) else {
        return Err(EngineError::new(
            ErrorCode::InvalidOptions,
            "options must include a patch object",
        ));
    };
    Ok(MetadataPatch {
        title: decode_string_field(obj, "title")?,
        author: decode_string_field(obj, "author")?,
        subject: decode_string_field(obj, "subject")?,
        keywords: decode_string_field(obj, "keywords")?,
        creator: decode_string_field(obj, "creator")?,
        producer: decode_string_field(obj, "producer")?,
        creation_date: decode_date_field(obj, "creation_date")?,
        modification_date: decode_date_field(obj, "modification_date")?,
    })
}

fn decode_string_field(
    obj: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<FieldPatch<String>, EngineError> {
    let Some(entry) = obj.get(field) else {
        return Ok(FieldPatch::Unchanged);
    };
    let op = entry.get("op").and_then(Value::as_str);
    match op {
        Some("clear") => Ok(FieldPatch::Clear),
        Some("set") => match entry.get("value").and_then(Value::as_str) {
            Some("") => Err(EngineError::new(
                ErrorCode::InvalidInput,
                format!("metadata field {field} cannot be set to an empty string (use Clear)"),
            )
            .with_details(format!("field={field}"))),
            Some(text) => Ok(FieldPatch::Set(text.to_string())),
            None => Err(EngineError::new(
                ErrorCode::InvalidOptions,
                format!("metadata field {field} set operation needs a string value"),
            )),
        },
        _ => Err(EngineError::new(
            ErrorCode::InvalidOptions,
            format!("metadata field {field} must be {{\"op\":\"set\"|\"clear\"}}"),
        )),
    }
}

fn decode_date_field(
    obj: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<FieldPatch<PdfDate>, EngineError> {
    let Some(entry) = obj.get(field) else {
        return Ok(FieldPatch::Unchanged);
    };
    let op = entry.get("op").and_then(Value::as_str);
    match op {
        Some("clear") => Ok(FieldPatch::Clear),
        Some("set") => {
            let value = entry.get("value").ok_or_else(|| {
                EngineError::new(
                    ErrorCode::InvalidOptions,
                    format!("metadata field {field} set operation needs a date object"),
                )
            })?;
            Ok(FieldPatch::Set(decode_pdf_date(field, value)?))
        }
        _ => Err(EngineError::new(
            ErrorCode::InvalidOptions,
            format!("metadata field {field} must be {{\"op\":\"set\"|\"clear\"}}"),
        )),
    }
}

/// Decodes the 7-field date object. Missing/non-integer fields are
/// structural (`INVALID_OPTIONS`); range violations are semantic
/// (`INVALID_INPUT` via [`PdfDate::new`]).
fn decode_pdf_date(field: &str, value: &Value) -> Result<PdfDate, EngineError> {
    let bad_structure = || {
        EngineError::new(
            ErrorCode::InvalidOptions,
            format!(
                "metadata field {field} needs {{year, month, day, hour, minute, second, tz_offset_minutes}} integers"
            ),
        )
    };
    let part = |key: &str| -> Result<i64, EngineError> {
        value
            .get(key)
            .and_then(Value::as_i64)
            .ok_or_else(bad_structure)
    };
    let narrow =
        |v: i64| -> Result<i32, EngineError> { i32::try_from(v).map_err(|_| bad_structure()) };
    let year = narrow(part("year")?)?;
    let month = u32::try_from(part("month")?).map_err(|_| bad_structure())?;
    let day = u32::try_from(part("day")?).map_err(|_| bad_structure())?;
    let hour = u32::try_from(part("hour")?).map_err(|_| bad_structure())?;
    let minute = u32::try_from(part("minute")?).map_err(|_| bad_structure())?;
    let second = u32::try_from(part("second")?).map_err(|_| bad_structure())?;
    let tz = narrow(part("tz_offset_minutes")?)?;
    PdfDate::new(year, month, day, hour, minute, second, tz)
}

fn dispatch(
    engine: &ExecutionEngine,
    operation: &str,
    names: &[String],
    blobs: &[Vec<u8>],
    options: &Value,
    token: CancellationToken,
) -> Result<DispatchOk, (EngineError, Duration)> {
    let input_at = |index: usize| (names[index].clone(), blobs[index].clone());
    let fail = |err: EngineError| (err, Duration::ZERO);

    // Single-document operations require exactly one input; multi-input
    // operations (merge, images_to_pdf) require ≥ 1. (Length mismatches
    // are glue-level, but they flow through the result envelope as
    // INVALID_INPUT so the UI renders them like engine errors.)
    let multi_input = operation == "pdf.merge" || operation == "pdf.images_to_pdf";
    if !multi_input && blobs.len() != 1 {
        return Err(fail(EngineError::new(
            ErrorCode::InvalidInput,
            "this operation requires exactly one input document",
        )));
    }
    if multi_input && blobs.is_empty() {
        return Err(fail(EngineError::new(
            ErrorCode::InvalidInput,
            "this operation requires at least one input file",
        )));
    }

    match operation {
        "pdf.inspect" => {
            let level = match options.get("level").and_then(Value::as_str) {
                Some("detailed") => InspectLevel::Detailed,
                _ => InspectLevel::Basic,
            };
            let (name, data) = input_at(0);
            let input = InspectInput {
                data,
                name: Some(name),
            };
            let result = engine.execute_with_cancellation(
                &InspectOperation,
                input,
                InspectOptions { level },
                token,
            );
            let duration = result.duration();
            result.into_outcome().map(|out| {
                let summary = json!({
                    "page_count": out.page_count,
                    "pdf_version": out.pdf_version,
                    "encrypted": out.encrypted,
                    "metadata": {
                        "title": out.metadata.title,
                        "author": out.metadata.author,
                        "subject": out.metadata.subject,
                        "keywords": out.metadata.keywords,
                        "creator": out.metadata.creator,
                        "producer": out.metadata.producer,
                        "creation_date": out.metadata.creation_date,
                        "modification_date": out.metadata.modification_date,
                    },
                    "pages": out.pages.map(|pages| pages.iter().map(page_json).collect::<Vec<_>>()),
                });
                (summary, Vec::new(), duration)
            }).map_err(|err| (err, duration))
        }
        "pdf.extract_pages" => {
            let pages = decode_pages(options.get("pages")).map_err(|err| (err, Duration::ZERO))?;
            let (name, data) = input_at(0);
            let input = ExtractPagesInput {
                data,
                name: Some(name.clone()),
            };
            let result = engine.execute_with_cancellation(
                &ExtractPagesOperation,
                input,
                ExtractPagesOptions::new(pages),
                token,
            );
            let duration = result.duration();
            result
                .into_outcome()
                .map(|out| {
                    let page_count = out.document.page_count();
                    let summary = json!({ "page_count": page_count });
                    let filename = format!("{}-extracted.pdf", stem_of(&name));
                    (summary, vec![(filename, out.document)], duration)
                })
                .map_err(|err| (err, duration))
        }
        "pdf.split" => {
            let parts_value = options
                .get("parts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if parts_value.is_empty() {
                return Err(fail(EngineError::new(
                    ErrorCode::InvalidInput,
                    "split plan must contain at least one part",
                )));
            }
            let mut parts = Vec::with_capacity(parts_value.len());
            for part in &parts_value {
                let pages = decode_pages(part.get("pages")).map_err(|err| (err, Duration::ZERO))?;
                let name = part.get("name").and_then(Value::as_str).map(str::to_string);
                parts.push(match name {
                    Some(name) => SplitPart::named(pages, name),
                    None => SplitPart::new(pages),
                });
            }
            let (name, data) = input_at(0);
            let input = SplitInput {
                data,
                name: Some(name.clone()),
            };
            let result = engine.execute_with_cancellation(
                &SplitOperation,
                input,
                SplitOptions::new(parts),
                token,
            );
            let duration = result.duration();
            result
                .into_outcome()
                .map(|out| {
                    let stem = stem_of(&name);
                    let summary = json!({
                        "input_page_count": out.input_page_count,
                        "parts": out.parts.iter().enumerate().map(|(i, p)| {
                            json!({
                                "name": p.name.clone().unwrap_or_else(|| format!("part-{}", i + 1)),
                                "page_count": p.document.page_count(),
                            })
                        }).collect::<Vec<_>>(),
                    });
                    let mut docs = Vec::with_capacity(out.parts.len());
                    for (i, part) in out.parts.into_iter().enumerate() {
                        let filename = match &part.name {
                            Some(n) => format!("{stem}-part-{}-{}.pdf", i + 1, sanitize_name(n)),
                            None => format!("{stem}-part-{}.pdf", i + 1),
                        };
                        docs.push((filename, part.document));
                    }
                    (summary, docs, duration)
                })
                .map_err(|err| (err, duration))
        }
        "pdf.reorder" => {
            let order = decode_pages(options.get("order")).map_err(|err| (err, Duration::ZERO))?;
            let (name, data) = input_at(0);
            let input = ReorderInput {
                data,
                name: Some(name.clone()),
            };
            let result = engine.execute_with_cancellation(
                &ReorderOperation,
                input,
                ReorderOptions::new(order),
                token,
            );
            let duration = result.duration();
            result
                .into_outcome()
                .map(|out| {
                    let page_count = out.document.page_count();
                    let summary = json!({ "page_count": page_count });
                    let filename = format!("{}-reordered.pdf", stem_of(&name));
                    (summary, vec![(filename, out.document)], duration)
                })
                .map_err(|err| (err, duration))
        }
        "pdf.delete_pages" => {
            let pages = decode_pages(options.get("pages")).map_err(|err| (err, Duration::ZERO))?;
            let (name, data) = input_at(0);
            let input = DeletePagesInput {
                data,
                name: Some(name.clone()),
            };
            let result = engine.execute_with_cancellation(
                &DeletePagesOperation,
                input,
                DeletePagesOptions::new(pages),
                token,
            );
            let duration = result.duration();
            result
                .into_outcome()
                .map(|out| {
                    let summary = json!({
                        "page_count": out.output_page_count,
                        "input_page_count": out.input_page_count,
                        "output_page_count": out.output_page_count,
                    });
                    let filename = format!("{}-deleted.pdf", stem_of(&name));
                    (summary, vec![(filename, out.document)], duration)
                })
                .map_err(|err| (err, duration))
        }
        "pdf.rotate" => {
            let pages = decode_pages(options.get("pages")).map_err(|err| (err, Duration::ZERO))?;
            let angle_deg = options
                .get("angle_deg")
                .and_then(Value::as_i64)
                .and_then(|n| i32::try_from(n).ok())
                .unwrap_or(0);
            let (name, data) = input_at(0);
            let input = RotateInput {
                data,
                name: Some(name.clone()),
            };
            let result = engine.execute_with_cancellation(
                &RotateOperation,
                input,
                RotateOptions::new(pages, angle_deg),
                token,
            );
            let duration = result.duration();
            result
                .into_outcome()
                .map(|out| {
                    let summary = json!({ "page_count": out.page_count });
                    let filename = format!("{}-rotated.pdf", stem_of(&name));
                    (summary, vec![(filename, out.document)], duration)
                })
                .map_err(|err| (err, duration))
        }
        "pdf.merge" => {
            // Parse each input up front (same policy as the merge CLI: a
            // malformed file fails the run with its index). Parse errors
            // carry the REAL loader error with zero engine duration — the
            // engine never ran.
            let mut documents = Vec::with_capacity(blobs.len());
            for (index, bytes) in blobs.iter().enumerate() {
                match load_pdf(bytes) {
                    Ok(document) => documents.push(document),
                    Err(err) => {
                        let prior = err.details().unwrap_or("").to_string();
                        let indexed = err.with_details(format!("document_index={index} {prior}"));
                        return Err((indexed, Duration::ZERO));
                    }
                }
            }
            let label = names.join(" + ");
            let mut input = MergeInput::new(documents);
            input.name = Some(label);
            let result = engine.execute_with_cancellation(
                &MergeOperation,
                input,
                MergeOptions::new(),
                token,
            );
            let duration = result.duration();
            result
                .into_outcome()
                .map(|out| {
                    let summary = json!({
                        "input_document_count": out.input_document_count,
                        "input_page_count": out.input_page_count,
                        "output_page_count": out.output_page_count,
                    });
                    (
                        summary,
                        vec![("merged.pdf".to_string(), out.document)],
                        duration,
                    )
                })
                .map_err(|err| (err, duration))
        }
        "pdf.images_to_pdf" => {
            let page_size = match options.get("page_size").and_then(Value::as_str) {
                None | Some("fit") => PageSizePolicy::FitImage,
                Some(text) => match PageSizePolicy::parse(text) {
                    Some(policy) => policy,
                    None => {
                        return Err((
                            EngineError::new(
                                ErrorCode::InvalidOptions,
                                format!("unknown page_size: {text} (expected fit|standard)"),
                            ),
                            Duration::ZERO,
                        ));
                    }
                },
            };
            let background_rgb = match options.get("background_rgb") {
                None => [255, 255, 255],
                Some(value) => decode_background(value)?,
            };
            let mut images = Vec::with_capacity(blobs.len());
            for (name, data) in names.iter().zip(blobs.iter()) {
                match ImageInput::new(name.clone(), data.clone()) {
                    Ok(image) => images.push(image),
                    Err(err) => return Err((err, Duration::ZERO)),
                }
            }
            let result = engine.execute_with_cancellation(
                &ImagesToPdfOperation,
                ImagesToPdfInput::new(images),
                ImagesToPdfOptions::new(page_size, background_rgb),
                token,
            );
            let duration = result.duration();
            result
                .into_outcome()
                .map(|out| {
                    let summary = json!({
                        "page_count": out.page_count,
                        "image_count": out.image_count,
                    });
                    (
                        summary,
                        vec![("images.pdf".to_string(), out.document)],
                        duration,
                    )
                })
                .map_err(|err| (err, duration))
        }
        "pdf.read_metadata" => {
            let (name, data) = input_at(0);
            let input = ReadMetadataInput {
                data,
                name: Some(name),
            };
            let result = engine.execute_with_cancellation(
                &ReadMetadataOperation,
                input,
                ReadMetadataOptions::new(),
                token,
            );
            let duration = result.duration();
            result
                .into_outcome()
                .map(|out| {
                    let summary = json!({
                        "page_count": out.page_count,
                        "metadata": metadata_json(&out.metadata),
                    });
                    (summary, Vec::new(), duration)
                })
                .map_err(|err| (err, duration))
        }
        "pdf.set_metadata" => {
            let patch =
                decode_metadata_patch(options.get("patch")).map_err(|err| (err, Duration::ZERO))?;
            let (name, data) = input_at(0);
            let input = SetMetadataInput {
                data,
                name: Some(name.clone()),
            };
            let result = engine.execute_with_cancellation(
                &SetMetadataOperation,
                input,
                SetMetadataOptions::new(patch),
                token,
            );
            let duration = result.duration();
            result
                .into_outcome()
                .map(|out| {
                    let page_count = out.document.page_count();
                    let summary = json!({ "page_count": page_count });
                    let filename = format!("{}-metadata.pdf", stem_of(&name));
                    (summary, vec![(filename, out.document)], duration)
                })
                .map_err(|err| (err, duration))
        }
        other => Err(fail(EngineError::new(
            ErrorCode::InvalidOptions,
            format!("unknown operation: {other}"),
        ))),
    }
}

// ---------------------------------------------------------------------------
// Small helpers (translation only)
// ---------------------------------------------------------------------------

fn glue_error(message: &str) -> JsValue {
    JsValue::from_str(&format!("folio-wasm glue: {message}"))
}

fn system_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn page_json(page: &PdfPageInspection) -> Value {
    json!({
        "page_number": page.page_number,
        "width_pt": page.width_pt,
        "height_pt": page.height_pt,
        "rotation_deg": page.rotation_deg,
    })
}

fn stem_of(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    base.strip_suffix(".pdf")
        .or_else(|| base.strip_suffix(".PDF"))
        .unwrap_or(base)
        .to_string()
}

fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "document".to_string()
    } else {
        trimmed.to_string()
    }
}

fn read_string_array(array: &Array, what: &str) -> Result<Vec<String>, JsValue> {
    let mut out = Vec::with_capacity(array.length() as usize);
    for value in array.iter() {
        match value.as_string() {
            Some(text) => out.push(text),
            None => return Err(glue_error(&format!("{what} must be an array of strings"))),
        }
    }
    Ok(out)
}

fn read_blob_array(array: &Array) -> Result<Vec<Vec<u8>>, JsValue> {
    let mut out = Vec::with_capacity(array.length() as usize);
    for value in array.iter() {
        let view: Uint8Array = value
            .dyn_into()
            .map_err(|_| glue_error("input_blobs must be an array of Uint8Array"))?;
        out.push(view.to_vec());
    }
    Ok(out)
}

/// Current wall-clock time. Goes through the engine's own platform clock
/// so envelope timestamps agree with engine timestamps.
fn clock_now() -> SystemTime {
    folio_engine::core::clock::wall_now()
}
