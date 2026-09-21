/**
 * Thumbnail engine interface (Lesson 13).
 *
 * The seam between React/future viewer code and PDF.js rendering:
 * components program against this, never against PDF.js objects. The
 * implementation depends on `PdfRenderEngine` — never on PDF.js directly —
 * so there is exactly one browser PDF rendering path:
 *
 * ```text
 * Thumbnail Engine → PdfRenderEngine → PDF.js → small render → thumbnail
 * ```
 *
 * Batch failure policy (documented choice): atomic. The first page
 * failure aborts the batch — active renders are cancelled, queued pages
 * are never scheduled, and the batch rejects with a `ThumbnailError`
 * identifying the failing page. No silent partial success is ever
 * reported. Per-page partial results are a future cache/viewer concern.
 */

import type { CancellableRender } from './types';
import type {
  ThumbnailBatchOptions,
  ThumbnailGenerateOptions,
  ThumbnailResult,
} from './thumbnailTypes';

export interface PdfThumbnailEngine {
  /**
   * Generates one thumbnail for a 1-based page of an already-loaded
   * rendering document. Calculates a small scale that fits inside the
   * target box, renders once at that scale, and resolves with geometry
   * plus a caller-owned canvas. Rejects with a structured
   * `ThumbnailError` (invalid page/size, closed document, render
   * failure, or cancellation). Never reopens the PDF.
   */
  generateThumbnail(
    documentId: string,
    pageNumber: number,
    options?: ThumbnailGenerateOptions,
  ): CancellableRender<ThumbnailResult>;

  /**
   * Generates thumbnails for an arbitrary ordered page list, preserving
   * input order in the output (`[5,1,3]` → `[thumb5,thumb1,thumb3]` —
   * never sorted). Bounded concurrency (default 2): at most
   * `concurrency` thumbnail renders are active at once. Progress fires
   * once per completed thumbnail; `onThumbnail` delivers results in
   * strict input page order. Atomic failure: the first page error aborts
   * the batch. The PDF stays open; callers close it when done.
   */
  generateThumbnails(
    documentId: string,
    pages: number[],
    options?: ThumbnailBatchOptions,
  ): CancellableRender<ThumbnailResult[]>;

  /**
   * Generates thumbnails for every page (`1..pageCount`) in page order.
   * Same bounded-concurrency, progress, ordering, and atomic-failure
   * semantics as `generateThumbnails`. For very large documents callers
   * should prefer sparse page sets or cancel early and consume
   * `onThumbnail` incrementally — the engine itself retains nothing
   * after settling, but the returned array is caller-owned.
   */
  generateDocumentThumbnails(
    documentId: string,
    options?: ThumbnailBatchOptions,
  ): CancellableRender<ThumbnailResult[]>;
}
