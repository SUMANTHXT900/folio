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
  // casts below select it. Shape mismatches throw and surface as
  // transport failures (never silent wrong data).
  switch (operation) {
    case 'pdf.inspect': {
      const inspect = summary as EngineInspectSummary;
      return {
        pageCount: inspect.page_count,
        pdfVersion: inspect.pdf_version,
        encrypted: inspect.encrypted,
        metadata: {
          title: inspect.metadata.title,
          author: inspect.metadata.author,
          producer: inspect.metadata.producer,
        },
        pages:
          inspect.pages === null
            ? null
            : inspect.pages.map((page) => ({
                pageNumber: page.page_number,
                widthPt: page.width_pt,
                heightPt: page.height_pt,
                rotationDeg: page.rotation_deg,
              })),
      };
    }
    case 'pdf.extract_pages':
    case 'pdf.reorder':
    case 'pdf.rotate': {
      const counts = summary as EngineCountsSummary;
      return { pageCount: counts.page_count };
    }
    case 'pdf.images_to_pdf': {
      const counts = summary as EngineCountsSummary;
      return {
        pageCount: counts.page_count,
        ...(counts.image_count === undefined ? {} : { imageCount: counts.image_count }),
      };
    }
    case 'pdf.delete_pages': {
      const counts = summary as EngineCountsSummary;
      return {
        pageCount: counts.page_count,
        inputPageCount: counts.input_page_count,
        outputPageCount: counts.output_page_count,
      };
    }
    case 'pdf.split': {
      const split = summary as EngineSplitSummary;
      return {
        inputPageCount: split.input_page_count,
        parts: split.parts.map((part) => ({ name: part.name, pageCount: part.page_count })),
      };
    }
    case 'pdf.merge': {
      const merge = summary as EngineMergeSummary;
      return {
        inputDocumentCount: merge.input_document_count,
        inputPageCount: merge.input_page_count,
        outputPageCount: merge.output_page_count,
      };
    }
    case 'pdf.read_metadata': {
      const meta = summary as EngineMetadataSummary;
      const date = (
        value: EnginePdfDate | null,
      ): {
        year: number;
        month: number;
        day: number;
        hour: number;
        minute: number;
        second: number;
        tzOffsetMinutes: number;
      } | null =>
        value === null
          ? null
          : {
              year: value.year,
              month: value.month,
              day: value.day,
              hour: value.hour,
              minute: value.minute,
              second: value.second,
              tzOffsetMinutes: value.tz_offset_minutes,
            };
      return {
        pageCount: meta.page_count,
        metadata: {
          title: meta.metadata.title,
          author: meta.metadata.author,
          subject: meta.metadata.subject,
          keywords: meta.metadata.keywords,
          creator: meta.metadata.creator,
          producer: meta.metadata.producer,
          creationDate: date(meta.metadata.creation_date),
          modificationDate: date(meta.metadata.modification_date),
        },
      };
    }
    case 'pdf.set_metadata': {
      const counts = summary as EngineCountsSummary;
      return { pageCount: counts.page_count };
    }
  }
}

export function errorData(code: string, message: string, details?: string | null): EngineErrorData {
  return {
    code: code as ErrorCode,
    message,
    ...(details == null ? {} : { details }),
  };
}
