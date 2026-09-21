/**
 * Rendering error model.
 *
 * A separate typed model from the frozen manipulation-engine `ErrorCode`
 * (`types/engine.ts`): the Lesson 12A freeze forbids extending that enum,
 * and rendering failures (PDF.js exceptions, canvas misuse, cancelled
 * renders) belong to a different subsystem with different semantics.
 * Rendering errors never cross the Rust/WASM boundary, so no wire format
 * is involved.
 */

export type RenderErrorCode =
  | 'RENDER_INVALID_INPUT'
  | 'RENDER_DOCUMENT_FAILED'
  | 'RENDER_INVALID_PAGE'
  | 'RENDER_PAGE_FAILED'
  | 'RENDER_CANCELLED'
  | 'RENDER_CLOSED'
  | 'RENDER_INTERNAL';

/** Structured rendering failure. Carries the failing context for diagnostics. */
export class RenderError extends Error {
  readonly code: RenderErrorCode;
  readonly details?: string;
  readonly documentId?: string;
  readonly pageNumber?: number;

  constructor(
    code: RenderErrorCode,
    message: string,
    context?: { details?: string; documentId?: string; pageNumber?: number },
  ) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.details = context?.details;
    this.documentId = context?.documentId;
    this.pageNumber = context?.pageNumber;
  }
}

/** Type guard for structured rendering failures. */
export function isRenderError(error: unknown): error is RenderError {
  return error instanceof RenderError;
}

/**
 * Detects PDF.js render-task cancellation without importing PDF.js (keeps
 * this module — and its unit tests — free of the PDF.js runtime).
 * PDF.js rejects cancelled renders with `RenderingCancelledException`.
 */
export function isPdfJsCancel(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'RenderingCancelledException'
  );
}

/** Truncates an underlying cause for `details` without dumping unbounded text. */
function truncatedCause(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const limit = 300;
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export interface RenderErrorContext {
  documentId?: string;
  pageNumber?: number;
}

/**
 * Maps an unknown failure from a document-load phase into a `RenderError`.
 * Cancellation (via `LoadingTask.destroy()`) surfaces as `RenderingCancelledException`
 * and maps to `RENDER_CANCELLED`; anything else is `RENDER_DOCUMENT_FAILED`.
 * Pass-through: `RenderError` inputs are returned unchanged.
 */
export function toLoadError(error: unknown, context?: RenderErrorContext): RenderError {
  if (error instanceof RenderError) {
    return error;
  }
  if (isPdfJsCancel(error)) {
    return new RenderError('RENDER_CANCELLED', 'document load was cancelled', {
      documentId: context?.documentId,
    });
  }
  return new RenderError('RENDER_DOCUMENT_FAILED', 'failed to open PDF document', {
    details: truncatedCause(error),
    documentId: context?.documentId,
  });
}

/**
 * Maps an unknown failure from a page-render phase into a `RenderError`.
 * `RenderingCancelledException` maps to `RENDER_CANCELLED` (never reported
 * as an internal failure); anything else is `RENDER_PAGE_FAILED`.
 * Pass-through: `RenderError` inputs are returned unchanged.
 */
export function toRenderError(error: unknown, context?: RenderErrorContext): RenderError {
  if (error instanceof RenderError) {
    return error;
  }
  if (isPdfJsCancel(error)) {
    return new RenderError('RENDER_CANCELLED', 'page render was cancelled', {
      documentId: context?.documentId,
      pageNumber: context?.pageNumber,
    });
  }
  return new RenderError('RENDER_PAGE_FAILED', 'failed to render PDF page', {
    details: truncatedCause(error),
    documentId: context?.documentId,
    pageNumber: context?.pageNumber,
  });
}

/** Maximum render scale: bounds canvas memory per render (scale² growth). */
export const MAX_RENDER_SCALE = 8;

/**
 * Normalizes a requested scale. Returns the effective scale (default 1).
 * Throws `RENDER_INVALID_INPUT` for non-finite, non-positive, or
 * excessively large scales.
 */
export function normalizeScale(scale: number | undefined): number {
  if (scale === undefined) {
    return 1;
  }
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    return raiseInvalidScale(scale);
  }
  if (scale > MAX_RENDER_SCALE) {
    return raiseInvalidScale(scale);
  }
  return scale;
}

function raiseInvalidScale(scale: unknown): never {
  throw new RenderError(
    'RENDER_INVALID_INPUT',
    `render scale must be a finite number in (0, ${MAX_RENDER_SCALE}], got ${String(scale)}`,
    { details: `scale=${String(scale)}` },
  );
}

/**
 * Validates a 1-based page number against a document's page count.
 * Throws `RENDER_INVALID_PAGE` — invalid pages never reach PDF.js.
 */
export function validatePageNumber(pageNumber: number, pageCount: number): void {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
    throw new RenderError(
      'RENDER_INVALID_PAGE',
      `page ${String(pageNumber)} is outside the document (1–${pageCount})`,
      { details: `page=${String(pageNumber)} page_count=${pageCount}` },
    );
  }
}

/**
 * Normalizes an absolute rotation override to 0/90/180/270.
 * Throws `RENDER_INVALID_INPUT` for non-quarter-turn values.
 */
export function normalizeRotation(rotation: number | undefined): number | undefined {
  if (rotation === undefined) {
    return undefined;
  }
  if (!Number.isInteger(rotation) || ((rotation % 90) + 90) % 90 !== 0) {
    throw new RenderError(
      'RENDER_INVALID_INPUT',
      `render rotation must be a multiple of 90 degrees, got ${String(rotation)}`,
      { details: `rotation=${String(rotation)}` },
    );
  }
  return ((rotation % 360) + 360) % 360;
}
