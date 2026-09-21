/**
 * Thumbnail subsystem public types (Lesson 13).
 *
 * A thumbnail is NOT a full-resolution page render: the engine calculates
 * a deliberately small scale that fits inside a target box, then renders
 * once at that scale through `PdfRenderEngine`. No full-size render plus
 * downscale ever happens.
 *
 * Ownership: every `ThumbnailResult.canvas` is created by the engine but
 * owned by the caller. The engine retains no references after the batch
 * promise settles (no global cache, no retained canvas list). Callers
 * release canvases by dropping references / removing them from the DOM;
 * standard GC reclaims the bitmaps. No `ImageBitmap` path yet — canvas
 * only, documented here so a future path can define close semantics.
 */

import type { RenderTiming } from './types';

/** Target box a thumbnail must fit inside (CSS pixels). Never stretched/cropped. */
export interface ThumbnailSize {
  width: number;
  height: number;
}

/** Knobs for a single thumbnail. */
export interface ThumbnailGenerateOptions {
  /** Target box. Default `{ width: 200, height: 200 }`. */
  size?: ThumbnailSize;
  /**
   * Absolute rotation override in degrees (multiple of 90). When omitted
   * the page's intrinsic `/Rotate` is respected via `PdfRenderEngine`.
   * The thumbnail layer never reinterprets rotation itself.
   */
  rotation?: number;
}

/** Progress for batch/document jobs: one update per completed thumbnail. */
export interface ThumbnailProgress {
  completed: number;
  total: number;
  percentage: number;
}

/** Knobs for batch and whole-document jobs. */
export interface ThumbnailBatchOptions extends ThumbnailGenerateOptions {
  /**
   * Maximum simultaneous thumbnail renders. Default
   * `DEFAULT_THUMBNAIL_CONCURRENCY` (2). Must be an integer in
   * `1..MAX_THUMBNAIL_CONCURRENCY`. Never unbounded `Promise.all`.
   */
  concurrency?: number;
  /** Called once per completed thumbnail with `completed/total`. */
  onProgress?: (progress: ThumbnailProgress) => void;
  /**
   * Called as thumbnails complete, delivered in strict input page order
   * (not completion order): a later-finishing page waits for earlier
   * pages before delivery. Lets consumers paint/release incrementally
   * while preserving ordering semantics.
   */
  onThumbnail?: (result: ThumbnailResult) => void;
}

/** Useful geometry/result of one thumbnail. Bitmap stays on the caller-owned canvas. */
export interface ThumbnailResult {
  documentId: string;
  /** 1-based page number, per Folio convention. */
  pageNumber: number;
  /**
   * Caller-owned thumbnail bitmap. Created by the engine, never retained
   * by it after the batch settles. No hidden cache.
   */
  canvas: HTMLCanvasElement;
  /** Actual bitmap width in device pixels (`Math.floor` viewport math). */
  width: number;
  /** Actual bitmap height in device pixels. */
  height: number;
  /** Source page width at scale 1 with the effective rotation applied. */
  sourcePageWidth: number;
  /** Source page height at scale 1 with the effective rotation applied. */
  sourcePageHeight: number;
  /** Uniform render scale used (`min(targetW/srcW, targetH/srcH)`). */
  scale: number;
  /** Effective rotation used (intrinsic or override), normalized to 0/90/180/270. */
  rotation: number;
  /** Browser-measured timing for the whole thumbnail (dims + render). */
  timing: RenderTiming;
}
