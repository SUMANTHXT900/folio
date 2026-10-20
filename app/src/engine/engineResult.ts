/**
 * Shared result translation for engine transports.
 *
 * The Web-Worker runtime speaks result envelopes whose summary shapes are
 * defined here (first introduced for the Lesson 9 localhost bridge, kept
 * because the worker transport speaks identical envelopes — refactor,
 * don't duplicate). Summary/error/event translation lives here exactly
 * once; transports only handle framing (`postMessage`) and binary
 * movement.
 */

import type {
  EngineErrorData,
  EngineEvent,
  ErrorCode,
  OperationId,
  ResultSummary,
} from '../types/engine';

/**
 * Result-envelope shapes. These mirror the JSON produced by the Rust
 * engine glue (`wasm/src/lib.rs`): snake_case wire fields, page counts,
 * and metadata.
 */
export interface EngineInspectSummary {
  page_count: number;
  pdf_version: string;
  encrypted: boolean;
  metadata: {
    title: string | null;
    author: string | null;
    subject: string | null;
    keywords: string | null;
    creator: string | null;
    producer: string | null;
    creation_date: string | null;
    modification_date: string | null;
  };
  pages: Array<{
    page_number: number;
    width_pt: number;
    height_pt: number;
    rotation_deg: number;
  }> | null;
}

export interface EngineCountsSummary {
  page_count: number;
  input_page_count?: number;
  output_page_count?: number;
  image_count?: number;
}

export interface EngineSplitSummary {
  input_page_count: number;
  parts: Array<{ name: string | null; page_count: number }>;
}

export interface EngineMergeSummary {
  input_document_count: number;
  input_page_count: number;
  output_page_count: number;
}

export interface EnginePdfDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  tz_offset_minutes: number;
}

export interface EngineMetadataSummary {
  page_count: number;
  metadata: {
    title: string | null;
    author: string | null;
    subject: string | null;
    keywords: string | null;
    creator: string | null;
    producer: string | null;
    creation_date: EnginePdfDate | null;
    modification_date: EnginePdfDate | null;
  };
}

export type SharedSummary =
  | EngineInspectSummary
  | EngineCountsSummary
  | EngineSplitSummary
  | EngineMergeSummary
  | EngineMetadataSummary;

/** One engine event on the wire (worker message). */
export interface EngineEventWire {
  timestamp_ms: number;
  kind: 'progress' | 'log' | 'lifecycle';
  level?: 'debug' | 'info' | 'warn' | 'error';
  phase?: string | null;
  completed?: number;
  total?: number;
  /** 0.0–1.0 fraction. */
  percentage?: number | null;
  message?: string | null;
}

export function translateWireEvent(
  event: EngineEventWire,
  // The caller's stable job handle (the adapter's client id, e.g. `wasm-N`) —
  // never the engine's `job-N`, which may repeat across worker restarts.
  clientJobId: string | null,
): Omit<EngineEvent, 'jobId' | 'seq' | 'timestampMs' | 'simulated'> & {
  jobId?: string;
  timestampMs?: number;
} {
  const level =
    event.level === undefined || event.level === 'debug'
      ? event.kind === 'progress' || event.kind === 'lifecycle'
        ? undefined
        : 'info'
      : event.level;
  return {
    ...(clientJobId === null ? {} : { jobId: clientJobId }),
    timestampMs: event.timestamp_ms,
    kind: event.kind,
    ...(level === undefined ? {} : { level }),
    ...(event.phase == null ? {} : { phase: event.phase }),
    ...(event.completed === undefined ? {} : { completed: event.completed }),
    ...(event.total === undefined ? {} : { total: event.total }),
    ...(event.percentage == null ? {} : { percentage: event.percentage }),
    ...(event.message == null ? {} : { message: event.message }),
  };
}

export function translateSummary(operation: OperationId, summary: SharedSummary): ResultSummary {
  // Each transport returns exactly one summary shape per operation; the
  // guards below select it. Shape mismatches throw and surface as
  // transport failures (never silent wrong data).
  switch (operation) {
    case 'pdf.inspect': {
      const inspect = summary as EngineInspectSummary;
      const pageCount = requireNumber(inspect?.page_count, 'page_count');
      const pdfVersion = requireString(inspect?.pdf_version, 'pdf_version');
      const encrypted = requireBoolean(inspect?.encrypted, 'encrypted');
      const metadata = requireRecord(inspect?.metadata, 'metadata');
      const pages = requireNullablePages(inspect?.pages, 'pages');
      return {
        pageCount,
        pdfVersion,
        encrypted,
        metadata: {
          title: requireNullableString(metadata.title, 'metadata.title'),
          author: requireNullableString(metadata.author, 'metadata.author'),
          producer: requireNullableString(metadata.producer, 'metadata.producer'),
        },
        pages:
          pages === null
            ? null
            : pages.map((page) => ({
                pageNumber: requireNumber(page?.page_number, 'pages[].page_number'),
                widthPt: requireNumber(page?.width_pt, 'pages[].width_pt'),
                heightPt: requireNumber(page?.height_pt, 'pages[].height_pt'),
                rotationDeg: requireNumber(page?.rotation_deg, 'pages[].rotation_deg'),
              })),
      };
    }
    case 'pdf.extract_pages':
    case 'pdf.reorder':
    case 'pdf.rotate': {
      const counts = summary as EngineCountsSummary;
      return { pageCount: requireNumber(counts?.page_count, 'page_count') };
    }
    case 'pdf.images_to_pdf': {
      const counts = summary as EngineCountsSummary;
      const pageCount = requireNumber(counts?.page_count, 'page_count');
      const imageCount =
        counts?.image_count === undefined
          ? undefined
          : requireNumber(counts.image_count, 'image_count');
      return {
        pageCount,
        ...(imageCount === undefined ? {} : { imageCount }),
      };
    }
    case 'pdf.delete_pages': {
      const counts = summary as EngineCountsSummary;
      return {
        pageCount: requireNumber(counts?.page_count, 'page_count'),
        inputPageCount: requireNumber(counts?.input_page_count, 'input_page_count'),
        outputPageCount: requireNumber(counts?.output_page_count, 'output_page_count'),
      };
    }
    case 'pdf.split': {
      const split = summary as EngineSplitSummary;
      const inputPageCount = requireNumber(split?.input_page_count, 'input_page_count');
      if (!Array.isArray(split?.parts)) {
        throw new Error('malformed summary: parts must be an array');
      }
      return {
        inputPageCount,
        parts: split.parts.map((part) => ({
          name: requireNullableString(part?.name, 'parts[].name'),
          pageCount: requireNumber(part?.page_count, 'parts[].page_count'),
        })),
      };
    }
    case 'pdf.merge': {
      const merge = summary as EngineMergeSummary;
      return {
        inputDocumentCount: requireNumber(merge?.input_document_count, 'input_document_count'),
        inputPageCount: requireNumber(merge?.input_page_count, 'input_page_count'),
        outputPageCount: requireNumber(merge?.output_page_count, 'output_page_count'),
      };
    }
    case 'pdf.read_metadata': {
      const meta = summary as EngineMetadataSummary;
      const pageCount = requireNumber(meta?.page_count, 'page_count');
      const metadata = requireRecord(meta?.metadata, 'metadata');
      const date = (
        value: EnginePdfDate | null,
        field: string,
      ): {
        year: number;
        month: number;
        day: number;
        hour: number;
        minute: number;
        second: number;
        tzOffsetMinutes: number;
      } | null => {
        if (value === null) {
          return null;
        }
        const record = requireRecord(value, field);
        return {
          year: requireNumber(record.year, `${field}.year`),
          month: requireNumber(record.month, `${field}.month`),
          day: requireNumber(record.day, `${field}.day`),
          hour: requireNumber(record.hour, `${field}.hour`),
          minute: requireNumber(record.minute, `${field}.minute`),
          second: requireNumber(record.second, `${field}.second`),
          tzOffsetMinutes: requireNumber(record.tz_offset_minutes, `${field}.tz_offset_minutes`),
        };
      };
      return {
        pageCount,
        metadata: {
          title: requireNullableString(metadata.title, 'metadata.title'),
          author: requireNullableString(metadata.author, 'metadata.author'),
          subject: requireNullableString(metadata.subject, 'metadata.subject'),
          keywords: requireNullableString(metadata.keywords, 'metadata.keywords'),
          creator: requireNullableString(metadata.creator, 'metadata.creator'),
          producer: requireNullableString(metadata.producer, 'metadata.producer'),
          creationDate: date(
            metadata.creation_date as EnginePdfDate | null,
            'metadata.creation_date',
          ),
          modificationDate: date(
            metadata.modification_date as EnginePdfDate | null,
            'metadata.modification_date',
          ),
        },
      };
    }
    case 'pdf.set_metadata': {
      const counts = summary as EngineCountsSummary;
      return { pageCount: requireNumber(counts?.page_count, 'page_count') };
    }
  }
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`malformed summary: ${field} must be a number`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`malformed summary: ${field} must be a string`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`malformed summary: ${field} must be a boolean`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`malformed summary: ${field} must be a string or null`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`malformed summary: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNullablePages(
  value: unknown,
  field: string,
): Array<Record<string, unknown>> | null {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error(`malformed summary: ${field} must be an array or null`);
  }
  return value as Array<Record<string, unknown>>;
}

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_DOCUMENT',
  'INVALID_PAGE_RANGE',
  'PAGE_OUT_OF_RANGE',
  'DUPLICATE_PAGE',
  'PROCESSING_FAILED',
  'CANCELLED',
  'UNSUPPORTED_FORMAT',
  'IO_ERROR',
  'INVALID_INPUT',
  'INVALID_OPTIONS',
  'INTERNAL',
]);

export function errorData(code: string, message: string, details?: string | null): EngineErrorData {
  if (!KNOWN_ERROR_CODES.has(code)) {
    const unknown = `unknown error code: ${code}`;
    return {
      code: 'INTERNAL',
      message,
      details: details == null ? unknown : `${details} (${unknown})`,
    };
  }
  return {
    code: code as ErrorCode,
    message,
    ...(details == null ? {} : { details }),
  };
}
