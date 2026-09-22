/**
 * Rendering subsystem public types.
 *
 * These types are the Folio rendering contract. React components and future
 * lessons (thumbnails, viewer) program against these — never against raw
 * PDF.js objects (`PDFDocumentProxy`, `PDFPageProxy`, …), which stay owned
 * by `PdfJsRenderEngine`.
 *
 * Deliberately separate from the frozen manipulation-engine contract in
 * `types/engine.ts`: rendering is not an `ExecutionEngine` operation, has
 * no `OperationId`, and its timing (`RenderTiming`) is browser-measured,
 * never `engine_duration_ms`.
 */

/** Input for opening a document: local bytes only, never URLs or paths. */
export interface RenderDocumentInput {
  /** PDF bytes. Passed to PDF.js by view; never base64-encoded, never stored in Zustand state. */
  data: Uint8Array | ArrayBuffer;
  /** Human label for diagnostics. */
  name?: string;
}

/** Document metadata, best-effort. Every field is nullable: a missing Info
 * dictionary yields `null`s, never an error. Date strings are kept raw. */
export interface PdfDocumentMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  creationDate: string | null;
  modificationDate: string | null;
}

/** Lightweight handle for a loaded document. Carries no PDF.js objects. */
export interface RenderingDocument {
  /** Stable handle id (`renderdoc-N`), unique per engine instance. */
  id: string;
  /** 1-based page count. */
  pageCount: number;
  /** Human label from the load input. */
  name: string;
  /** Best-effort metadata, `null` when unreadable. */
  metadata: PdfDocumentMetadata | null;
}

/** Per-page render knobs. Extended by future lessons; keep minimal now. */
export interface RenderPageOptions {
  /** Output scale factor (CSS units × scale = device pixels). Default 1. */
  scale?: number;
  /**
   * Absolute rotation override in degrees. When omitted, the page's
   * intrinsic `/Rotate` is respected. Must be a multiple of 90.
   */
  rotation?: number;
}

/** Useful geometry/result of one page render. Pixel output stays on the
 * caller-owned canvas — never serialized to base64 or JSON. */
export interface RenderedPage {
  documentId: string;
  /** 1-based page number, per Folio convention. */
  pageNumber: number;
  /** Effective scale used. */
  scale: number;
  /** Effective rotation used (intrinsic or override), normalized to 0/90/180/270. */
  rotation: number;
  /** Canvas bitmap width in device pixels. */
  width: number;
  /** Canvas bitmap height in device pixels. */
  height: number;
}

/** Browser-measured timing for one rendering call. Uses `performance.now()`;
 * never confused with the Rust engine's `engine_duration_ms`. */
export interface RenderTiming {
  /** Wall-clock ISO timestamp at call start. */
  startedAt: string;
  /** Wall-clock ISO timestamp at call end. */
  completedAt: string;
  /** Monotonic duration in milliseconds. */
  durationMs: number;
}

/** Lifecycle phases reported while a document loads. No fake percentages:
 * PDF.js exposes loaded/total bytes, which are passed through as-is. */
export interface DocumentLoadProgress {
  phase: 'loading';
  loadedBytes: number;
  /** Total bytes when known, else `null`. */
  totalBytes: number | null;
}

/** A cancellable rendering call: the promise settles with the result, and
 * `cancel()` rejects it with a structured `RENDER_CANCELLED` error. */
export interface CancellableRender<T> {
  promise: Promise<T>;
  cancel: () => void;
}

/** Settled outcome of `loadDocument`: handle plus load timing. */
export interface LoadedDocument {
  document: RenderingDocument;
  timing: RenderTiming;
}

/** Settled outcome of `renderPage`: geometry plus render timing. */
export interface RenderPageResult {
  page: RenderedPage;
  timing: RenderTiming;
}

/**
 * Intrinsic page size at scale 1 with an effective rotation applied.
 *
 * Returned by `PdfRenderEngine.getPageDimensions` (Lesson 13 seam). The
 * thumbnail engine uses this to calculate a small render scale that fits
 * inside a target box — never rendering huge and shrinking afterward.
 * Width/height are CSS units (PDF.js viewport units at scale 1, float);
 * `rotation` is the effective 0/90/180/270 value.
 */
export interface PageDimensions {
  documentId: string;
  /** 1-based page number, per Folio convention. */
  pageNumber: number;
  /** Viewport width at scale 1 with the effective rotation applied. */
  width: number;
  /** Viewport height at scale 1 with the effective rotation applied. */
  height: number;
  /** Effective rotation (intrinsic or override), normalized to 0/90/180/270. */
  rotation: number;
}
