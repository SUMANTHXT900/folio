/**
 * PDF.js implementation of `PdfRenderEngine`.
 *
 * Owns all PDF.js objects: `PDFDocumentProxy` instances live in a private
 * per-engine map keyed by `renderdoc-N` handles, and `PDFPageProxy` objects
 * never leave a `renderPage` call (released via `page.cleanup()`).
 *
 * Separation notes:
 * - This engine never touches the Rust/WASM manipulation engine, its
 *   worker, or its protocol. Rendering and manipulation are independent
 *   workloads on independent workers (PDF.js's own worker vs
 *   `engine.worker.ts`).
 * - Failures surface as the rendering-local `RenderError`, never as frozen
 *   Engine `ErrorCode` values.
 * - Timing uses `performance.now()`; results never carry `engine_duration_ms`.
 */

import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import { pdfjs } from './pdfjs';
import type { PdfRenderEngine } from './PdfRenderEngine';
import {
  normalizeRotation,
  normalizeScale,
  RenderError,
  toLoadError,
  toRenderError,
  validatePageNumber,
} from './errors';
import type {
  CancellableRender,
  DocumentLoadProgress,
  LoadedDocument,
  PageDimensions,
  PdfDocumentMetadata,
  RenderDocumentInput,
  RenderedPage,
  RenderPageOptions,
  RenderPageResult,
  RenderingDocument,
  RenderTiming,
} from './types';

interface OpenDocument {
  handle: RenderingDocument;
  proxy: PDFDocumentProxy;
  /**
   * The loading task owns document destruction in this PDF.js version
   * (`PDFDocumentProxy.destroy` does not exist; verified at runtime).
   */
  loadingTask: PDFDocumentLoadingTask;
  closed: boolean;
  /** Cancellers for in-flight renders; drained on close. */
  pendingRenders: Set<() => void>;
}

function measureTiming(startedAt: string, startMark: number): RenderTiming {
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: performance.now() - startMark,
  };
}

/** Reads one optional string field from PDF.js metadata info. */
function metaString(info: Record<string, unknown>, key: string): string | null {
  const value = info[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Best-effort metadata read. Never throws: failures yield `null`. */
async function readMetadata(proxy: PDFDocumentProxy): Promise<PdfDocumentMetadata | null> {
  try {
    const { info } = await proxy.getMetadata();
    if (typeof info !== 'object' || info === null) {
      return null;
    }
    const fields = info as Record<string, unknown>;
    return {
      title: metaString(fields, 'Title'),
      author: metaString(fields, 'Author'),
      subject: metaString(fields, 'Subject'),
      keywords: metaString(fields, 'Keywords'),
      creator: metaString(fields, 'Creator'),
      producer: metaString(fields, 'Producer'),
      creationDate: metaString(fields, 'CreationDate'),
      modificationDate: metaString(fields, 'ModDate'),
    };
  } catch {
    return null;
  }
}

function snapshot(record: OpenDocument): RenderingDocument {
  return { ...record.handle };
}

export class PdfJsRenderEngine implements PdfRenderEngine {
  private documents = new Map<string, OpenDocument>();
  private nextId = 1;

  loadDocument(
    input: RenderDocumentInput,
    onProgress?: (progress: DocumentLoadProgress) => void,
  ): CancellableRender<LoadedDocument> {
    const lib = pdfjs();
    let cancelled = false;
    let loadingTask: ReturnType<typeof lib.getDocument> | undefined;

    const promise = (async (): Promise<LoadedDocument> => {
      const startedAt = new Date().toISOString();
      const startMark = performance.now();
      const data = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
      if (!(input.data instanceof Uint8Array || input.data instanceof ArrayBuffer)) {
        throw new RenderError(
          'RENDER_INVALID_INPUT',
          'document data must be a Uint8Array or ArrayBuffer',
          {
            details: `type=${Object.prototype.toString.call(input.data)}`,
          },
        );
      }
      if (data.byteLength === 0) {
        throw new RenderError('RENDER_INVALID_INPUT', 'document data must not be empty', {
          details: 'byteLength=0',
        });
      }
      try {
        // Defensive copy: PDF.js detaches (neuters) the buffer handed to
        // `getDocument`, which would corrupt the caller's bytes (e.g. the
        // binary store's copy). This is one transient full-size copy per
        // load — unavoidable with this PDF.js version, documented in
        // ARCHITECTURE.md. No base64, no JSON.
        const owned = data.slice();
        loadingTask = lib.getDocument({ data: owned, verbosity: lib.VerbosityLevel.ERRORS });
        if (onProgress !== undefined) {
          loadingTask.onProgress = (params: { loaded: number; total: number }) => {
            onProgress({
              phase: 'loading',
              loadedBytes: params.loaded,
              totalBytes: Number.isFinite(params.total) && params.total > 0 ? params.total : null,
            });
          };
        }
        const proxy = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy().catch(() => undefined);
          throw new RenderError('RENDER_CANCELLED', 'document load was cancelled');
        }
        const metadata = await readMetadata(proxy);
        const id = `renderdoc-${this.nextId}`;
        this.nextId += 1;
        const handle: RenderingDocument = {
          id,
          pageCount: proxy.numPages,
          name: input.name ?? 'document.pdf',
          metadata,
        };
        this.documents.set(id, {
          handle,
          proxy,
          loadingTask,
          closed: false,
          pendingRenders: new Set(),
        });
        return {
          document: snapshot(this.documents.get(id) as OpenDocument),
          timing: measureTiming(startedAt, startMark),
        };
      } catch (error) {
        if (cancelled) {
          throw new RenderError('RENDER_CANCELLED', 'document load was cancelled');
        }
        throw toLoadError(error);
      }
    })();

    return {
      promise,
      cancel: () => {
        cancelled = true;
        // Destroying the loading task rejects its promise; the flag above
        // guarantees the rejection maps to RENDER_CANCELLED, not a failure.
        loadingTask?.destroy().catch(() => undefined);
      },
    };
  }

  getDocument(documentId: string): RenderingDocument | undefined {
    const record = this.documents.get(documentId);
    if (record === undefined || record.closed) {
      return undefined;
    }
    return snapshot(record);
  }

  renderPage(
    documentId: string,
    pageNumber: number,
    canvas: HTMLCanvasElement,
    options?: RenderPageOptions,
  ): CancellableRender<RenderPageResult> {
    let cancelled = false;
    let cancelRenderTask: (() => void) | undefined;

    const promise = (async (): Promise<RenderPageResult> => {
      const startedAt = new Date().toISOString();
      const startMark = performance.now();
      const context = { documentId, pageNumber };
      const record = this.documents.get(documentId);
      if (record === undefined || record.closed) {
        throw new RenderError('RENDER_CLOSED', `document is not open: ${documentId}`, {
          details: `documentId=${documentId}`,
          documentId,
          pageNumber,
        });
      }
      validatePageNumber(pageNumber, record.handle.pageCount);
      const scale = normalizeScale(options?.scale);
      const overrideRotation = normalizeRotation(options?.rotation);
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new RenderError(
          'RENDER_INVALID_INPUT',
          'render target must be an HTMLCanvasElement',
          context,
        );
      }
      const context2d = canvas.getContext('2d');
      if (context2d === null) {
        throw new RenderError(
          'RENDER_INVALID_INPUT',
          'canvas 2d context is unavailable (canvas may already use another context mode)',
          context,
        );
      }
      const canceller = () => {
        cancelled = true;
        cancelRenderTask?.();
      };
      record.pendingRenders.add(canceller);
      try {
        // PDF.js pages are 1-based, matching Folio's convention — no index translation.
        const pdfPage = await record.proxy.getPage(pageNumber);
        try {
          if (cancelled || record.closed) {
            throw new RenderError('RENDER_CANCELLED', 'page render was cancelled', context);
          }
          const intrinsic = ((pdfPage.rotate % 360) + 360) % 360;
          const rotation = overrideRotation ?? intrinsic;
          const viewport = pdfPage.getViewport({ scale, rotation });
          // Integer bitmap size (deterministic floor); reported geometry is
          // what future thumbnails/viewer code must trust.
          const width = Math.floor(viewport.width);
          const height = Math.floor(viewport.height);
          if (width <= 0 || height <= 0) {
            throw new RenderError('RENDER_PAGE_FAILED', 'viewport produced empty dimensions', {
              details: `viewport=${viewport.width}x${viewport.height} scale=${scale}`,
              ...context,
            });
          }
          canvas.width = width;
          canvas.height = height;
          // v6 render API takes the canvas element (recommended) rather
          // than a bare 2d context.
          const task = pdfPage.render({ canvas, viewport });
          cancelRenderTask = () => {
            try {
              task.cancel();
            } catch {
              // Cancellation races a finished task; the flag below decides the outcome.
            }
          };
          await task.promise;
          if (cancelled || record.closed) {
            throw new RenderError('RENDER_CANCELLED', 'page render was cancelled', context);
          }
          const page: RenderedPage = { documentId, pageNumber, scale, rotation, width, height };
          return { page, timing: measureTiming(startedAt, startMark) };
        } finally {
          // Release per-page operator lists; the document stays open for re-render.
          pdfPage.cleanup();
        }
      } catch (error) {
        if (cancelled || record.closed) {
          throw new RenderError('RENDER_CANCELLED', 'page render was cancelled', context);
        }
        throw toRenderError(error, context);
      } finally {
        record.pendingRenders.delete(canceller);
      }
    })();

    return {
      promise,
      // Cancels ONLY this render: invoking the shared pending set here
      // would wrongly cancel sibling renders of the same document.
      // Bulk cancellation lives in closeDocument.
      cancel: () => {
        cancelled = true;
        cancelRenderTask?.();
      },
    };
  }

  async closeDocument(documentId: string): Promise<void> {
    const record = this.documents.get(documentId);
    if (record === undefined || record.closed) {
      return;
    }
    record.closed = true;
    this.documents.delete(documentId);
    // In-flight renders reject with RENDER_CANCELLED via the closed flag.
    record.pendingRenders.forEach((fn) => fn());
    record.pendingRenders.clear();
    await record.loadingTask.destroy().catch(() => undefined);
  }

  async getPageDimensions(
    documentId: string,
    pageNumber: number,
    rotation?: number,
  ): Promise<PageDimensions> {
    const context = { documentId, pageNumber };
    const record = this.documents.get(documentId);
    if (record === undefined || record.closed) {
      throw new RenderError('RENDER_CLOSED', `document is not open: ${documentId}`, {
        details: `documentId=${documentId}`,
        documentId,
        pageNumber,
      });
    }
    validatePageNumber(pageNumber, record.handle.pageCount);
    const overrideRotation = normalizeRotation(rotation);
    try {
      // PDF.js pages are 1-based, matching Folio's convention — no index translation.
      const pdfPage = await record.proxy.getPage(pageNumber);
      try {
        if (record.closed) {
          throw new RenderError('RENDER_CANCELLED', 'page dimensions read was cancelled', context);
        }
        const intrinsic = ((pdfPage.rotate % 360) + 360) % 360;
        const effectiveRotation = overrideRotation ?? intrinsic;
        const viewport = pdfPage.getViewport({ scale: 1, rotation: effectiveRotation });
        const width = viewport.width;
        const height = viewport.height;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new RenderError('RENDER_PAGE_FAILED', 'viewport produced empty dimensions', {
            details: `viewport=${String(viewport.width)}x${String(viewport.height)}`,
            ...context,
          });
        }
        return { documentId, pageNumber, width, height, rotation: effectiveRotation };
      } finally {
        // Release per-page operator lists; the document stays open for re-render.
        pdfPage.cleanup();
      }
    } catch (error) {
      if (record.closed) {
        throw new RenderError('RENDER_CANCELLED', 'page dimensions read was cancelled', context);
      }
      throw toRenderError(error, context);
    }
  }
}
