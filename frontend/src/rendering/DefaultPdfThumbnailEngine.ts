/**
 * Default thumbnail engine (Lesson 13).
 *
 * Depends on `PdfRenderEngine`, never on PDF.js directly. For each page:
 *
 * ```text
 * source dims (scale 1, effective rotation) via getPageDimensions
 *   → uniform scale = min(targetW/srcW, targetH/srcH)
 *   → renderPage once at that small scale into a fresh canvas
 *   → ThumbnailResult (caller owns the canvas)
 * ```
 *
 * Never renders huge and shrinks. Never reopens the PDF per page.
 * Rotation is respected through the render engine — no second rotation
 * implementation here. Background follows the rendering subsystem's
 * deterministic canvas behavior (no thumbnail-specific background knob).
 *
 * Batch scheduling is a bounded worker pool: at most `concurrency`
 * thumbnail renders are active at once, queued pages never start after
 * cancellation/failure, and `onThumbnail` fires in strict input page
 * order via a next-emit pointer over buffered completions.
 */

import type { PdfRenderEngine } from './PdfRenderEngine';
import type { PdfThumbnailEngine } from './PdfThumbnailEngine';
import type { CancellableRender } from './types';
import { calculateThumbnailGeometry } from './thumbnailGeometry';
import {
  normalizeThumbnailConcurrency,
  normalizeThumbnailSize,
  ThumbnailError,
  toThumbnailError,
  validateThumbnailPage,
} from './thumbnailErrors';
import type {
  ThumbnailBatchOptions,
  ThumbnailGenerateOptions,
  ThumbnailResult,
} from './thumbnailTypes';

function createCanvas(): HTMLCanvasElement {
  return document.createElement('canvas');
}

export class DefaultPdfThumbnailEngine implements PdfThumbnailEngine {
  private readonly renders: PdfRenderEngine;

  constructor(renderEngine: PdfRenderEngine) {
    this.renders = renderEngine;
  }

  generateThumbnail(
    documentId: string,
    pageNumber: number,
    options?: ThumbnailGenerateOptions,
  ): CancellableRender<ThumbnailResult> {
    let cancelled = false;
    let cancelActive: (() => void) | undefined;

    const promise = (async (): Promise<ThumbnailResult> => {
      const startedAt = new Date().toISOString();
      const startMark = performance.now();
      const failIfCancelled = (): void => {
        if (cancelled) {
          throw new ThumbnailError('THUMBNAIL_CANCELLED', 'thumbnail generation was cancelled', {
            documentId,
            pageNumber,
          });
        }
      };
      try {
        const size = normalizeThumbnailSize(options?.size);
        const rotation = options?.rotation;
        failIfCancelled();
        const open = this.renders.getDocument(documentId);
        if (open === undefined) {
          throw new ThumbnailError('THUMBNAIL_CLOSED', `document is not open: ${documentId}`, {
            details: `documentId=${documentId}`,
            documentId,
            pageNumber,
          });
        }
        validateThumbnailPage(pageNumber, open.pageCount, documentId);
        failIfCancelled();
        let dims;
        try {
          dims = await this.renders.getPageDimensions(documentId, pageNumber, rotation);
        } catch (error) {
          throw toThumbnailError(error, { documentId, pageNumber });
        }
        failIfCancelled();
        let geometry;
        try {
          geometry = calculateThumbnailGeometry(dims.width, dims.height, size.width, size.height);
        } catch (error) {
          throw new ThumbnailError('THUMBNAIL_INVALID_INPUT', 'invalid thumbnail geometry', {
            details: error instanceof Error ? error.message : String(error),
            documentId,
            pageNumber,
            cause: error,
          });
        }
        const canvas = createCanvas();
        let rendered;
        try {
          const task = this.renders.renderPage(documentId, pageNumber, canvas, {
            scale: geometry.scale,
            rotation,
          });
          cancelActive = () => task.cancel();
          rendered = await task.promise;
        } catch (error) {
          throw toThumbnailError(error, { documentId, pageNumber }, cancelled);
        } finally {
          cancelActive = undefined;
        }
        failIfCancelled();
        return {
          documentId,
          pageNumber,
          canvas,
          width: rendered.page.width,
          height: rendered.page.height,
          sourcePageWidth: dims.width,
          sourcePageHeight: dims.height,
          scale: geometry.scale,
          rotation: rendered.page.rotation,
          timing: {
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: performance.now() - startMark,
          },
        };
      } catch (error) {
        if (cancelled) {
          throw toThumbnailError(error, { documentId, pageNumber }, true);
        }
        throw toThumbnailError(error, { documentId, pageNumber });
      }
    })();

    return {
      promise,
      cancel: () => {
        cancelled = true;
        cancelActive?.();
      },
    };
  }

  generateThumbnails(
    documentId: string,
    pages: number[],
    options?: ThumbnailBatchOptions,
  ): CancellableRender<ThumbnailResult[]> {
    // Shared mutable batch state: lives in this closure only (never on
    // `this`), so the engine retains nothing after the promise settles.
    let cancelled = false;
    let settled = false;
    const activeCancellers = new Set<() => void>();
    let rejectInner: ((error: unknown) => void) | undefined;

    const settleCancel = (reject: (error: unknown) => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancelled = true;
      activeCancellers.forEach((fn) => {
        try {
          fn();
        } catch {
          // Cancellation races a finished task; the error below decides.
        }
      });
      reject(
        new ThumbnailError('THUMBNAIL_CANCELLED', 'thumbnail generation was cancelled', {
          documentId,
        }),
      );
    };

    const promise = (async (): Promise<ThumbnailResult[]> => {
      // Upfront validation: size + concurrency + non-empty + every page in
      // range. No renders start when validation fails (atomic, deterministic).
      const size = normalizeThumbnailSize(options?.size);
      const concurrency = normalizeThumbnailConcurrency(options?.concurrency);
      const rotation = options?.rotation;
      const onProgress = options?.onProgress;
      const onThumbnail = options?.onThumbnail;
      if (!Array.isArray(pages) || pages.length === 0) {
        throw new ThumbnailError(
          'THUMBNAIL_INVALID_INPUT',
          'thumbnail page list must be a non-empty array',
          { details: `pages=${Array.isArray(pages) ? `length=${pages.length}` : typeof pages}` },
        );
      }
      const open = this.renders.getDocument(documentId);
      if (open === undefined) {
        throw new ThumbnailError('THUMBNAIL_CLOSED', `document is not open: ${documentId}`, {
          details: `documentId=${documentId}`,
          documentId,
        });
      }
      for (const page of pages) {
        validateThumbnailPage(page, open.pageCount, documentId);
      }
      if (cancelled) {
        throw new ThumbnailError('THUMBNAIL_CANCELLED', 'thumbnail generation was cancelled', {
          documentId,
        });
      }

      const total = pages.length;
      const results: (ThumbnailResult | undefined)[] = new Array(total).fill(undefined);
      let completed = 0;
      let nextIndex = 0;
      let active = 0;
      let nextEmit = 0;

      return await new Promise<ThumbnailResult[]>((resolve, reject) => {
        rejectInner = reject;

        const emitInOrder = (): void => {
          if (onThumbnail === undefined) {
            return;
          }
          while (nextEmit < total) {
            const ready = results[nextEmit];
            if (ready === undefined) {
              break;
            }
            try {
              onThumbnail(ready);
            } catch {
              // Consumer callback failures never fail the batch; the batch
              // result still resolves. Documented: callbacks are observers.
            }
            nextEmit += 1;
          }
        };

        const maybeDone = (): void => {
          if (settled || cancelled || completed !== total) {
            return;
          }
          settled = true;
          // Ownership transfers to the caller; engine keeps no references
          // (locals drop here; no instance fields hold bitmaps).
          resolve(results as ThumbnailResult[]);
        };

        const failAtomic = (error: unknown, pageNumber: number): void => {
          if (settled) {
            return;
          }
          settled = true;
          cancelled = true;
          activeCancellers.forEach((fn) => {
            try {
              fn();
            } catch {
              // Ignored.
            }
          });
          reject(toThumbnailError(error, { documentId, pageNumber }));
        };

        const cancelBatch = (): void => settleCancel(reject);

        const renderOne = async (slot: number, pageNumber: number): Promise<void> => {
          const slotStartedAt = new Date().toISOString();
          const slotStartMark = performance.now();
          let cancelRender: (() => void) | undefined;
          try {
            if (cancelled) {
              throw new ThumbnailError(
                'THUMBNAIL_CANCELLED',
                'thumbnail generation was cancelled',
                {
                  documentId,
                  pageNumber,
                },
              );
            }
            const dims = await this.renders.getPageDimensions(documentId, pageNumber, rotation);
            if (cancelled) {
              throw new ThumbnailError(
                'THUMBNAIL_CANCELLED',
                'thumbnail generation was cancelled',
                {
                  documentId,
                  pageNumber,
                },
              );
            }
            let geometry;
            try {
              geometry = calculateThumbnailGeometry(
                dims.width,
                dims.height,
                size.width,
                size.height,
              );
            } catch (error) {
              throw new ThumbnailError('THUMBNAIL_INVALID_INPUT', 'invalid thumbnail geometry', {
                details: error instanceof Error ? error.message : String(error),
                documentId,
                pageNumber,
                cause: error,
              });
            }
            const canvas = createCanvas();
            try {
              const task = this.renders.renderPage(documentId, pageNumber, canvas, {
                scale: geometry.scale,
                rotation,
              });
              cancelRender = () => task.cancel();
              activeCancellers.add(cancelRender);
              const rendered = await task.promise;
              const result: ThumbnailResult = {
                documentId,
                pageNumber,
                canvas,
                width: rendered.page.width,
                height: rendered.page.height,
                sourcePageWidth: dims.width,
                sourcePageHeight: dims.height,
                scale: geometry.scale,
                rotation: rendered.page.rotation,
                timing: {
                  startedAt: slotStartedAt,
                  completedAt: new Date().toISOString(),
                  durationMs: performance.now() - slotStartMark,
                },
              };
              results[slot] = result;
              completed += 1;
              onProgress?.({
                completed,
                total,
                percentage: completed / total,
              });
              emitInOrder();
            } finally {
              if (cancelRender !== undefined) {
                activeCancellers.delete(cancelRender);
              }
            }
          } catch (error) {
            if (
              cancelled ||
              (error instanceof ThumbnailError && error.code === 'THUMBNAIL_CANCELLED')
            ) {
              cancelBatch();
              return;
            }
            // Atomic failure: first page error aborts everything. Queued
            // pages never start; actives are cancelled; batch rejects with
            // the failing page attributed.
            failAtomic(error, pageNumber);
            return;
          } finally {
            active -= 1;
          }
          if (!cancelled && !settled) {
            schedule();
            maybeDone();
          } else if (cancelled && !settled) {
            cancelBatch();
          }
        };

        const schedule = (): void => {
          if (cancelled || settled) {
            return;
          }
          while (active < concurrency && nextIndex < total && !cancelled && !settled) {
            const slot = nextIndex;
            nextIndex += 1;
            active += 1;
            void renderOne(slot, pages[slot] as number);
          }
          if (cancelled && active === 0 && !settled) {
            cancelBatch();
          }
        };

        schedule();
        maybeDone();
      });
    })();

    // If the async validation above rejects, `rejectInner` may never be set;
    // outer cancel still flips the flag so late scheduling observes it.
    // Attaching a no-op catch here would swallow the real rejection, so the
    // promise is returned untouched.
    return {
      promise,
      cancel: () => {
        if (settled) {
          return;
        }
        cancelled = true;
        activeCancellers.forEach((fn) => {
          try {
            fn();
          } catch {
            // Ignored.
          }
        });
        // When renders are active their rejections settle the batch via
        // renderOne; when nothing is in flight (or validation hasn't
        // created work yet) force-settle here so cancel never hangs.
        if (rejectInner !== undefined) {
          settleCancel(rejectInner);
        } else {
          // Validation phase: the async wrapper will observe `cancelled`
          // and reject with THUMBNAIL_CANCELLED on its own.
        }
      },
    };
  }

  generateDocumentThumbnails(
    documentId: string,
    options?: ThumbnailBatchOptions,
  ): CancellableRender<ThumbnailResult[]> {
    const open = this.renders.getDocument(documentId);
    if (open === undefined) {
      const rejected: Promise<ThumbnailResult[]> = Promise.reject(
        new ThumbnailError('THUMBNAIL_CLOSED', `document is not open: ${documentId}`, {
          details: `documentId=${documentId}`,
          documentId,
        }),
      );
      // Avoid unhandled-rejection noise when callers attach handlers later.
      rejected.catch(() => undefined);
      return { promise: rejected, cancel: () => undefined };
    }
    const pages: number[] = [];
    for (let page = 1; page <= open.pageCount; page += 1) {
      pages.push(page);
    }
    return this.generateThumbnails(documentId, pages, options);
  }
}
