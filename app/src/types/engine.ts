/**
 * Engine API types — the TypeScript mirror of the Rust engine contract.
 *
 * Mirrors, field by field where applicable:
 * - `core::operation::Operation` (`Input + Options -> Output`, stable names)
 * - `core::result::{OperationResult, CompletionStatus}`
 * - `core::error::{EngineError, ErrorCode}` (wire strings from `code_str()`)
 * - `execution::progress::ProgressEvent` (`phase/completed/total/message`)
 * - `execution::job::JobId` (`job-{n}`) and `JobState`
 * - `observability` timestamps (wall clock) + monotonic durations
 *
 * The engine remains authoritative: timing, status, progress, and errors
 * always originate from the adapter, never from UI computation.
 */

export type OperationId =
  | 'pdf.inspect'
  | 'pdf.extract_pages'
  | 'pdf.split'
  | 'pdf.reorder'
  | 'pdf.delete_pages'
  | 'pdf.rotate'
  | 'pdf.merge'
  | 'pdf.images_to_pdf'
  | 'pdf.read_metadata'
  | 'pdf.set_metadata';

/** Terminal + live execution states. Mirrors Rust `JobState`. */
export type ExecutionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Wire strings from Rust `ErrorCode::code_str()`. */
export type ErrorCode =
  | 'INVALID_DOCUMENT'
  | 'INVALID_PAGE_RANGE'
  | 'PAGE_OUT_OF_RANGE'
  | 'DUPLICATE_PAGE'
  | 'PROCESSING_FAILED'
  | 'CANCELLED'
  | 'UNSUPPORTED_FORMAT'
  | 'IO_ERROR'
  | 'INVALID_INPUT'
  | 'INVALID_OPTIONS'
  | 'INTERNAL';

/**
 * One input document: bytes cross the boundary, never paths.
 *
 * `transfer` (optional, default false): the caller relinquishes these
 * bytes — the adapter moves the underlying buffer to the worker WITHOUT
 * copying, neutering the caller's view. Only set for staged inputs with
 * no other owner (never for rendering-backed documents shared with
 * PDF.js). The wire shape is unchanged (name + bytes either way).
 */
export interface EngineDocumentInput {
  name: string;
  bytes: Uint8Array;
  transfer?: boolean;
}

export interface InspectOptions {
  level: 'basic' | 'detailed';
}

export interface PageSelectionOptions {
  pages: number[];
}

export interface ReorderOptions {
  order: number[];
}

export interface RotateOptions {
  pages: number[];
  angleDeg: number;
}

export interface SplitPart {
  pages: number[];
  name?: string;
}

export interface SplitOptions {
  parts: SplitPart[];
}

export interface ImagesToPdfOptions {
  pageSize: 'fit' | 'standard';
  backgroundRgb: [number, number, number];
}

/**
 * One metadata field patch on the wire: `{"op":"set","value":…}` writes,
 * `{"op":"clear"}` removes the key, an absent field leaves it unchanged.
 * String values are UTF-8 text; date values are 7-field objects mirroring
 * Rust `PdfDate` (snake_case, like every other wire shape).
 */
export interface MetadataFieldPatch {
  op: 'set' | 'clear';
  value?: string | PdfDateWire;
}

/** Wire form of Rust `PdfDate` (snake_case). */
export interface PdfDateWire {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  tz_offset_minutes: number;
}

/** Wire form of Rust `MetadataPatch`: absent fields are unchanged. */
export interface MetadataPatchWire {
  title?: MetadataFieldPatch;
  author?: MetadataFieldPatch;
  subject?: MetadataFieldPatch;
  keywords?: MetadataFieldPatch;
  creator?: MetadataFieldPatch;
  producer?: MetadataFieldPatch;
  creation_date?: MetadataFieldPatch;
  modification_date?: MetadataFieldPatch;
}

export interface MetadataPatchOptions {
  patch: MetadataPatchWire;
}

/** Per-operation options, discriminated by the request's operation. */
export type OperationOptions =
  | InspectOptions
  | PageSelectionOptions
  | ReorderOptions
  | RotateOptions
  | SplitOptions
  | ImagesToPdfOptions
  | MetadataPatchOptions;

export interface EngineRequestBase {
  inputs: EngineDocumentInput[];
}

/** Engine requests, discriminated by operation for type-safe options. */
export type EngineRequest =
  | (EngineRequestBase & { operation: 'pdf.inspect'; options: InspectOptions })
  | (EngineRequestBase & { operation: 'pdf.extract_pages'; options: PageSelectionOptions })
  | (EngineRequestBase & { operation: 'pdf.split'; options: SplitOptions })
  | (EngineRequestBase & { operation: 'pdf.reorder'; options: ReorderOptions })
  | (EngineRequestBase & { operation: 'pdf.delete_pages'; options: PageSelectionOptions })
  | (EngineRequestBase & { operation: 'pdf.rotate'; options: RotateOptions })
  | (EngineRequestBase & { operation: 'pdf.merge'; options: Record<string, never> })
  | (EngineRequestBase & { operation: 'pdf.images_to_pdf'; options: ImagesToPdfOptions })
  | (EngineRequestBase & { operation: 'pdf.read_metadata'; options: Record<string, never> })
  | (EngineRequestBase & { operation: 'pdf.set_metadata'; options: MetadataPatchOptions });

/** Structured engine error. Mirrors Rust `EngineError`. */
export interface EngineErrorData {
  code: ErrorCode;
  message: string;
  details?: string;
}

/**
 * One engine event. Mirrors Rust `ProgressEvent`
 * (`phase/completed/total/message`) plus lifecycle markers.
 * `simulated` is true only for the unit-test mock adapter; the dev
 * adapter reports real engine events with `simulated: false`. `client`
 * tags UI-originated marker events (never engine data).
 */
export interface EngineEvent {
  jobId: string;
  seq: number;
  timestampMs: number;
  kind: 'lifecycle' | 'progress' | 'log';
  level?: 'info' | 'warn' | 'error';
  phase?: string;
  completed?: number;
  total?: number;
  percentage?: number;
  message?: string;
  simulated: boolean;
  client?: boolean;
}

/**
 * Reference to an output document. Metadata only — bytes live in the
 * binary store, never in UI state.
 */
export interface OutputDocumentRef {
  outputId: string;
  name: string;
  byteLength: number;
  pageCount: number | null;
}

export interface InspectPageData {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  rotationDeg: number;
}

export interface InspectSummary {
  pageCount: number;
  pdfVersion: string;
  encrypted: boolean;
  metadata: {
    title: string | null;
    author: string | null;
    producer: string | null;
  };
  pages: InspectPageData[] | null;
}

export interface CountsSummary {
  pageCount: number;
  inputPageCount?: number;
  outputPageCount?: number;
  imageCount?: number;
}

export interface SplitSummary {
  inputPageCount: number;
  parts: Array<{ name: string | null; pageCount: number }>;
}

export interface MergeSummary {
  inputDocumentCount: number;
  inputPageCount: number;
  outputPageCount: number;
}

/** One typed PDF date (mirrors Rust `PdfDate`, camelCase in app state). */
export interface PdfDateData {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  tzOffsetMinutes: number;
}

/** Authoritative editable metadata (mirrors Rust `DocumentMetadata`). */
export interface DocumentMetadataData {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  creationDate: PdfDateData | null;
  modificationDate: PdfDateData | null;
}

export interface MetadataSummary {
  pageCount: number;
  metadata: DocumentMetadataData;
}

export type ResultSummary =
  InspectSummary | CountsSummary | SplitSummary | MergeSummary | MetadataSummary;

/** Final record of one execution. Mirrors Rust `OperationResult`. */
export interface EngineExecution {
  /**
   * Stable unique handle for this execution (adapter-assigned: `job-N`
   * for the mock, `wasm-N` for the worker adapter). Used as the UI
   * identity (keys, history).
   */
  jobId: string;
  /**
   * The REAL engine job id (`job-N` from `ExecutionEngine`), when the
   * engine ran. Unlike `jobId` it may repeat across worker restarts
   * (each WASM instance restarts the process-unique counter), so it is
   * display-only — never a key. `null` when the engine never started.
   */
  engineJobId?: string | null;
  operation: OperationId;
  status: Exclude<ExecutionStatus, 'idle' | 'running'>;
  startedAt: string;
  completedAt: string;
  /** Authoritative engine duration (monotonic), milliseconds. */
  engineDurationMs: number;
  progress: number;
  result?: {
    summary: ResultSummary;
    outputs: OutputDocumentRef[];
  };
  error?: EngineErrorData;
  events: EngineEvent[];
  simulated: boolean;
}
