/**
 * Rendering engine interface: the seam between React and PDF.js.
 *
 * Components program against this interface; `PdfJsRenderEngine` is the
 * only implementation. PDF.js proxy objects never escape: callers receive
 * plain `RenderingDocument` handles and render into caller-owned canvases.
 */

import type {
  CancellableRender,
  LoadedDocument,
  PageDimensions,
  RenderDocumentInput,
  DocumentLoadProgress,
  RenderPageOptions,
  RenderPageResult,
  RenderingDocument,
} from './types';

export interface PdfRenderEngine {
  /**
   * Opens a document from local bytes. Resolves with the handle plus load
   * timing. Rejects with a structured `RenderError` on malformed input.
   * `onProgress` receives pass-through byte progress while loading.
   */
  loadDocument(
    input: RenderDocumentInput,
    onProgress?: (progress: DocumentLoadProgress) => void,
  ): CancellableRender<LoadedDocument>;

  /** Returns a snapshot of a loaded document's handle, or `undefined` when unknown/closed. */
  getDocument(documentId: string): RenderingDocument | undefined;

  /**
   * Renders one 1-based page into a caller-owned canvas. Resolves with
   * geometry plus render timing. Rejects with a structured `RenderError`
   * (invalid page, closed document, render failure, or cancellation).
   * The same document may be rendered repeatedly without reopening.
   */
  renderPage(
    documentId: string,
    pageNumber: number,
    canvas: HTMLCanvasElement,
    options?: RenderPageOptions,
  ): CancellableRender<RenderPageResult>;

  /**
   * Returns the intrinsic page size at scale 1 with the effective rotation
   * applied, without rasterizing. Fast path: `renderPage` returns the same
   * geometry (`sourceWidth`/`sourceHeight`), so thumbnails never need a
   * separate dimensions call; this entry point remains for callers that
   * need geometry only, and its results are cached per document/page/rotation
   * (seeded by renders) until the document closes. Rejects with a structured
   * `RenderError` (invalid page, closed document, or page failure).
   * `rotation` is an absolute override like `renderPage`; when omitted the
   * intrinsic `/Rotate` is respected. Never returns PDF.js objects.
   */
  getPageDimensions(
    documentId: string,
    pageNumber: number,
    rotation?: number,
  ): Promise<PageDimensions>;

  /**
   * Closes a document and destroys its PDF.js resources. Idempotent:
   * unknown or already-closed ids are ignored. Cancels in-flight renders
   * of that document first (they reject with `RENDER_CANCELLED`).
   */
  closeDocument(documentId: string): Promise<void>;
}
