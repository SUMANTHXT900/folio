/**
 * Thumbnail error model (Lesson 13).
 *
 * Separate from the frozen manipulation-engine `ErrorCode` and from the
 * rendering-local `RenderError`: thumbnail failures carry the failing
 * page context plus the underlying render cause, and batch cancellation
 * has its own code so callers never mistake it for success. Raw PDF.js
 * exceptions never escape — they are wrapped as `THUMBNAIL_RENDER_FAILED`.
 */

import { RenderError } from './errors';

export type ThumbnailErrorCode =
  | 'THUMBNAIL_INVALID_INPUT'
  | 'THUMBNAIL_INVALID_PAGE'
  | 'THUMBNAIL_CLOSED'
  | 'THUMBNAIL_RENDER_FAILED'
  | 'THUMBNAIL_CANCELLED'
  | 'THUMBNAIL_INTERNAL';

/** Structured thumbnail failure. Carries the failing page for diagnostics. */
export class ThumbnailError extends Error {
  readonly code: ThumbnailErrorCode;
  readonly details?: string;
  readonly documentId?: string;
  readonly pageNumber?: number;
  readonly cause?: unknown;

  constructor(
    code: ThumbnailErrorCode,
    message: string,
    context?: { details?: string; documentId?: string; pageNumber?: number; cause?: unknown },
  ) {
    super(message);
    this.name = 'ThumbnailError';
    this.code = code;
    this.details = context?.details;
    this.documentId = context?.documentId;
    this.pageNumber = context?.pageNumber;
    this.cause = context?.cause;
  }
}

/** Type guard for structured thumbnail failures. */
export function isThumbnailError(error: unknown): error is ThumbnailError {
  return error instanceof ThumbnailError;
}

export interface ThumbnailErrorContext {
  documentId?: string;
  pageNumber?: number;
}

/** Truncates an underlying cause for `details` without dumping unbounded text. */
function truncatedCause(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const limit = 300;
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Wraps an unknown thumbnail-phase failure into a `ThumbnailError`.
 * Mapping preserves page attribution:
 * - `ThumbnailError` passes through unchanged.
 * - `RenderError` `RENDER_CANCELLED` → `THUMBNAIL_CANCELLED`.
 * - `RenderError` `RENDER_INVALID_PAGE` → `THUMBNAIL_INVALID_PAGE`.
 * - `RenderError` `RENDER_CLOSED` → `THUMBNAIL_CLOSED`.
 * - Other `RenderError`s → `THUMBNAIL_RENDER_FAILED` (cause preserved).
 * - Anything else → `THUMBNAIL_RENDER_FAILED` (or `THUMBNAIL_CANCELLED`
 *   when `cancelledHint` is set by the batch scheduler).
 */
export function toThumbnailError(
  error: unknown,
  context?: ThumbnailErrorContext,
  cancelledHint?: boolean,
): ThumbnailError {
  if (error instanceof ThumbnailError) {
    return error;
  }
  if (cancelledHint === true) {
    return new ThumbnailError('THUMBNAIL_CANCELLED', 'thumbnail generation was cancelled', {
      documentId: context?.documentId,
      pageNumber: context?.pageNumber,
    });
  }
  if (error instanceof RenderError) {
    if (error.code === 'RENDER_CANCELLED') {
      return new ThumbnailError('THUMBNAIL_CANCELLED', 'thumbnail generation was cancelled', {
        details: error.details,
        documentId: context?.documentId ?? error.documentId,
        pageNumber: context?.pageNumber ?? error.pageNumber,
        cause: error,
      });
    }
    if (error.code === 'RENDER_INVALID_PAGE') {
      return new ThumbnailError('THUMBNAIL_INVALID_PAGE', error.message, {
        details: error.details,
        documentId: context?.documentId ?? error.documentId,
        pageNumber: context?.pageNumber ?? error.pageNumber,
        cause: error,
      });
    }
    if (error.code === 'RENDER_CLOSED') {
      return new ThumbnailError('THUMBNAIL_CLOSED', error.message, {
        details: error.details,
        documentId: context?.documentId ?? error.documentId,
        pageNumber: context?.pageNumber ?? error.pageNumber,
        cause: error,
      });
    }
    return new ThumbnailError('THUMBNAIL_RENDER_FAILED', 'failed to generate thumbnail', {
      details: error.details ?? truncatedCause(error),
      documentId: context?.documentId ?? error.documentId,
      pageNumber: context?.pageNumber ?? error.pageNumber,
      cause: error,
    });
  }
  return new ThumbnailError('THUMBNAIL_RENDER_FAILED', 'failed to generate thumbnail', {
    details: truncatedCause(error),
    documentId: context?.documentId,
    pageNumber: context?.pageNumber,
    cause: error,
  });
}

/** Default target box when no size is given. */
export const DEFAULT_THUMBNAIL_SIZE = { width: 200, height: 200 } as const;

/** Default bounded concurrency: safe baseline for PDF.js/worker/canvas pressure. */
export const DEFAULT_THUMBNAIL_CONCURRENCY = 2;

/** Hard cap on concurrency: protects browser memory even when misconfigured. */
export const MAX_THUMBNAIL_CONCURRENCY = 8;

/** Hard cap per target-box edge: bounds canvas memory per thumbnail. */
export const MAX_THUMBNAIL_EDGE = 1024;

/**
 * Validates a target box. Returns the effective size (default 200×200).
 * Throws `THUMBNAIL_INVALID_INPUT` for non-finite, non-positive, or
 * oversized edges. No aspect-ratio logic here — see `thumbnailGeometry`.
 */
export function normalizeThumbnailSize(size: { width: number; height: number } | undefined): {
  width: number;
  height: number;
} {
  if (size === undefined) {
    return { width: DEFAULT_THUMBNAIL_SIZE.width, height: DEFAULT_THUMBNAIL_SIZE.height };
  }
  const { width, height } = size;
  const bad =
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_THUMBNAIL_EDGE ||
    height > MAX_THUMBNAIL_EDGE;
  if (bad) {
    throw new ThumbnailError(
      'THUMBNAIL_INVALID_INPUT',
      `thumbnail size must be finite positive dimensions within (0, ${MAX_THUMBNAIL_EDGE}], got ${String(width)}x${String(height)}`,
      { details: `size=${String(width)}x${String(height)}` },
    );
  }
  return { width, height };
}

/**
 * Validates a concurrency value. Returns the effective concurrency
 * (default 2). Throws `THUMBNAIL_INVALID_INPUT` for non-integers or
 * values outside `1..MAX_THUMBNAIL_CONCURRENCY`.
 */
export function normalizeThumbnailConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined) {
    return DEFAULT_THUMBNAIL_CONCURRENCY;
  }
  if (
    typeof concurrency !== 'number' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_THUMBNAIL_CONCURRENCY
  ) {
    throw new ThumbnailError(
      'THUMBNAIL_INVALID_INPUT',
      `thumbnail concurrency must be an integer in 1..${MAX_THUMBNAIL_CONCURRENCY}, got ${String(concurrency)}`,
      { details: `concurrency=${String(concurrency)}` },
    );
  }
  return concurrency;
}

/**
 * Validates a 1-based page number against a document's page count.
 * Throws `THUMBNAIL_INVALID_PAGE` — invalid pages never reach PDF.js.
 */
export function validateThumbnailPage(
  pageNumber: number,
  pageCount: number,
  documentId?: string,
): void {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
    throw new ThumbnailError(
      'THUMBNAIL_INVALID_PAGE',
      `page ${String(pageNumber)} is outside the document (1–${pageCount})`,
      {
        details: `page=${String(pageNumber)} page_count=${pageCount}`,
        documentId,
        pageNumber: Number.isInteger(pageNumber) ? pageNumber : undefined,
      },
    );
  }
}
