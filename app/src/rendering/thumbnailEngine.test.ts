/**
 * Thumbnail engine unit tests over a fake `PdfRenderEngine`.
 *
 * No PDF.js runtime here: the fake implements the same interface
 * (`getDocument`/`getPageDimensions`/`renderPage`/`closeDocument`) with
 * controllable page sizes, delays, and failures. Verifies ordering,
 * bounded concurrency, progress, cancellation, atomic failure, and the
 * small-scale render invariant (never full-size + shrink). Dimension and
 * render needs are served by a single fitted `renderPage` call: the
 * thumbnail engine never issues a separate `getPageDimensions` query
 * (asserted via `dimsCalls` staying empty).
 */
import { describe, expect, it } from 'vitest';
import { DefaultPdfThumbnailEngine } from './DefaultPdfThumbnailEngine';
import type { PdfRenderEngine } from './PdfRenderEngine';
import { RenderError } from './errors';
import { isThumbnailError, ThumbnailError } from './thumbnailErrors';
import type { CancellableRender, PageDimensions, RenderedPage, RenderingDocument } from './types';

interface FakePage {
  width: number;
  height: number;
  rotation: number;
}

interface FakeOptions {
  pageCount: number;
  pages?: Record<number, FakePage>;
  renderDelayMs?: number;
  renderDelayByPage?: Record<number, number>;
  failPages?: number[];
  failDimsPages?: number[];
}

class FakeRenderEngine implements PdfRenderEngine {
  readonly id = 'renderdoc-1';
  readonly pageCount: number;
  private readonly pages = new Map<number, FakePage>();
  private closed = false;
  readonly renderCalls: Array<{
    pageNumber: number;
    scale: number;
    rotation?: number;
    targetBox?: { width: number; height: number };
  }> = [];
  readonly dimsCalls: Array<{ pageNumber: number; rotation?: number }> = [];
  activeRenders = 0;
  maxActiveRenders = 0;
  private readonly delayMs: number;
  private readonly delayByPage: Record<number, number>;
  private readonly failPages: Set<number>;
  private readonly failDimsPages: Set<number>;

  constructor(options: FakeOptions) {
    this.pageCount = options.pageCount;
    this.delayMs = options.renderDelayMs ?? 0;
    this.delayByPage = options.renderDelayByPage ?? {};
    this.failPages = new Set(options.failPages ?? []);
    this.failDimsPages = new Set(options.failDimsPages ?? []);
    for (let page = 1; page <= options.pageCount; page += 1) {
      const override = options.pages?.[page];
      this.pages.set(page, override ?? { width: 595, height: 842, rotation: 0 });
    }
  }

  loadDocument(): CancellableRender<{ document: RenderingDocument; timing: never }> {
    throw new Error('not used in thumbnail tests');
  }

  getDocument(documentId: string): RenderingDocument | undefined {
    if (documentId !== this.id || this.closed) {
      return undefined;
    }
    return { id: this.id, pageCount: this.pageCount, name: 'fake.pdf', metadata: null };
  }

  /**
   * Shared scale-1 geometry (rotation swaps dimensions like PDF.js
   * viewports do). `getPageDimensions` counts external dimension queries;
   * `renderPage` uses it directly, so `dimsCalls` proves the thumbnail
   * engine no longer asks for dimensions before rendering.
   */
  private dimsFor(documentId: string, pageNumber: number, rotation?: number): PageDimensions {
    if (documentId !== this.id || this.closed) {
      throw new RenderError('RENDER_CLOSED', `document is not open: ${documentId}`, {
        documentId,
        pageNumber,
      });
    }
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) {
      throw new RenderError(
        'RENDER_INVALID_PAGE',
        `page ${String(pageNumber)} is outside the document (1–${this.pageCount})`,
        { documentId, pageNumber },
      );
    }
    if (this.failDimsPages.has(pageNumber)) {
      throw new RenderError('RENDER_PAGE_FAILED', 'dims boom', { documentId, pageNumber });
    }
    const page = this.pages.get(pageNumber) as FakePage;
    const intrinsic = ((page.rotation % 360) + 360) % 360;
    let effective = intrinsic;
    if (rotation !== undefined) {
      if (!Number.isInteger(rotation) || ((rotation % 90) + 90) % 90 !== 0) {
        throw new RenderError('RENDER_INVALID_INPUT', 'bad rotation', { documentId, pageNumber });
      }
      effective = ((rotation % 360) + 360) % 360;
    }
    // Rotation swaps dimensions like PDF.js viewports do.
    const swapped = effective === 90 || effective === 270;
    return {
      documentId,
      pageNumber,
      width: swapped ? page.height : page.width,
      height: swapped ? page.width : page.height,
      rotation: effective,
    };
  }

  async getPageDimensions(
    documentId: string,
    pageNumber: number,
    rotation?: number,
  ): Promise<PageDimensions> {
    const dims = this.dimsFor(documentId, pageNumber, rotation);
    this.dimsCalls.push({ pageNumber, rotation });
    return dims;
  }

  renderPage(
    documentId: string,
    pageNumber: number,
    canvas: HTMLCanvasElement,
    options?: {
      scale?: number;
      rotation?: number;
      targetBox?: { width: number; height: number };
    },
  ): CancellableRender<{
    page: RenderedPage;
    timing: { startedAt: string; completedAt: string; durationMs: number };
  }> {
    const rotationOpt = options?.rotation;
    const targetBox = options?.targetBox;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelDelay: (() => void) | undefined;
    const delay = this.delayByPage[pageNumber] ?? this.delayMs;
    const promise = (async () => {
      if (documentId !== this.id || this.closed) {
        throw new RenderError('RENDER_CLOSED', `document is not open: ${documentId}`, {
          documentId,
          pageNumber,
        });
      }
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) {
        throw new RenderError('RENDER_INVALID_PAGE', 'bad page', { documentId, pageNumber });
      }
      if (this.failPages.has(pageNumber)) {
        throw new RenderError('RENDER_PAGE_FAILED', `render boom p${pageNumber}`, {
          documentId,
          pageNumber,
        });
      }
      const dims = this.dimsFor(documentId, pageNumber, rotationOpt);
      // Mirrors the real engine: a target box is fitted from the page's
      // scale-1 geometry inside this same render call.
      const scale =
        options?.scale ??
        (targetBox !== undefined
          ? Math.min(targetBox.width / dims.width, targetBox.height / dims.height)
          : 1);
      this.renderCalls.push({ pageNumber, scale, rotation: rotationOpt, targetBox });
      this.activeRenders += 1;
      this.maxActiveRenders = Math.max(this.maxActiveRenders, this.activeRenders);
      try {
        if (delay > 0) {
          await new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => resolve(), delay);
            cancelDelay = () => {
              if (timer !== undefined) {
                clearTimeout(timer);
              }
              reject(
                new RenderError('RENDER_CANCELLED', 'page render was cancelled', {
                  documentId,
                  pageNumber,
                }),
              );
            };
          });
        }
        if (cancelled || this.closed) {
          throw new RenderError('RENDER_CANCELLED', 'page render was cancelled', {
            documentId,
            pageNumber,
          });
        }
        // sourceWidth/sourceHeight are the scale-1 geometry the real engine
        // returns alongside the render.
        const width = Math.max(1, Math.floor(dims.width * scale));
        const height = Math.max(1, Math.floor(dims.height * scale));
        // Fake raster: tag the canvas so tests can prove a render happened.
        (canvas as unknown as { dataset: Record<string, string> }).dataset.renderedPage =
          String(pageNumber);
        return {
          page: {
            documentId,
            pageNumber,
            scale,
            rotation: dims.rotation,
            width,
            height,
            sourceWidth: dims.width,
            sourceHeight: dims.height,
          },
          timing: {
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: delay,
          },
        };
      } finally {
        this.activeRenders -= 1;
      }
    })();
    return {
      promise,
      cancel: () => {
        cancelled = true;
        cancelDelay?.();
      },
    };
  }

  async closeDocument(documentId: string): Promise<void> {
    if (documentId === this.id) {
      this.closed = true;
    }
  }
}

function makeEngines(options: FakeOptions): {
  fake: FakeRenderEngine;
  thumbs: DefaultPdfThumbnailEngine;
} {
  const fake = new FakeRenderEngine(options);
  return { fake, thumbs: new DefaultPdfThumbnailEngine(fake) };
}

describe('generateThumbnail (single)', () => {
  it('renders a small portrait thumbnail with preserved aspect', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 3 });
    const result = await thumbs.generateThumbnail(fake.id, 1, { size: { width: 200, height: 200 } })
      .promise;
    expect(result.pageNumber).toBe(1);
    expect(result.documentId).toBe(fake.id);
    expect(result.sourcePageWidth).toBe(595);
    expect(result.sourcePageHeight).toBe(842);
    // Small-scale invariant: never renders at full size.
    expect(result.scale).toBeLessThan(1);
    expect(result.scale).toBeCloseTo(200 / 842, 10);
    expect(result.width).toBeLessThanOrEqual(200);
    expect(result.height).toBe(200);
    expect(result.canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(fake.renderCalls).toHaveLength(1);
    expect(fake.renderCalls[0]?.scale).toBeCloseTo(200 / 842, 10);
    expect(result.timing.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('serves dimensions and render from one fitted render call', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 3 });
    const result = await thumbs.generateThumbnail(fake.id, 1, { size: { width: 200, height: 200 } })
      .promise;
    // The returned scale-1 geometry drives the result metadata...
    expect(result.sourcePageWidth).toBe(595);
    expect(result.sourcePageHeight).toBe(842);
    expect(result.scale).toBeCloseTo(200 / 842, 10);
    // ...and no separate dimension query was made: one render, zero dims.
    expect(fake.renderCalls).toHaveLength(1);
    expect(fake.renderCalls[0]?.targetBox).toEqual({ width: 200, height: 200 });
    expect(fake.dimsCalls).toHaveLength(0);
  });

  it('renders landscape pages wide, not tall', async () => {
    const { thumbs, fake } = makeEngines({
      pageCount: 2,
      pages: {
        1: { width: 595, height: 842, rotation: 0 },
        2: { width: 842, height: 595, rotation: 0 },
      },
    });
    const portrait = await thumbs.generateThumbnail(fake.id, 1, {
      size: { width: 200, height: 200 },
    }).promise;
    const landscape = await thumbs.generateThumbnail(fake.id, 2, {
      size: { width: 200, height: 200 },
    }).promise;
    expect(portrait.height).toBe(200);
    expect(portrait.width).toBeLessThan(200);
    expect(landscape.width).toBe(200);
    expect(landscape.height).toBeLessThan(200);
  });

  it('respects intrinsic rotation through the render engine', async () => {
    const { fake, thumbs } = makeEngines({
      pageCount: 1,
      pages: { 1: { width: 595, height: 842, rotation: 90 } },
    });
    const result = await thumbs.generateThumbnail(fake.id, 1, { size: { width: 200, height: 200 } })
      .promise;
    // 90° rotates portrait → landscape source dims.
    expect(result.sourcePageWidth).toBe(842);
    expect(result.sourcePageHeight).toBe(595);
    expect(result.rotation).toBe(90);
    expect(result.width).toBe(200);
  });

  it('rejects invalid pages without touching the renderer', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 3 });
    await expect(thumbs.generateThumbnail(fake.id, 0).promise).rejects.toMatchObject({
      name: 'ThumbnailError',
      code: 'THUMBNAIL_INVALID_PAGE',
    });
    await expect(thumbs.generateThumbnail(fake.id, 99).promise).rejects.toMatchObject({
      code: 'THUMBNAIL_INVALID_PAGE',
    });
    expect(fake.renderCalls).toHaveLength(0);
    expect(fake.dimsCalls).toHaveLength(0);
  });

  it('rejects closed documents', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 2 });
    await fake.closeDocument(fake.id);
    await expect(thumbs.generateThumbnail(fake.id, 1).promise).rejects.toMatchObject({
      code: 'THUMBNAIL_CLOSED',
    });
  });

  it('wraps render failures with page attribution', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 3, failPages: [2] });
    const failure = await thumbs.generateThumbnail(fake.id, 2).promise.catch((error) => error);
    expect(isThumbnailError(failure)).toBe(true);
    expect((failure as ThumbnailError).code).toBe('THUMBNAIL_RENDER_FAILED');
    expect((failure as ThumbnailError).pageNumber).toBe(2);
  });

  it('cancels a single render with THUMBNAIL_CANCELLED', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 2, renderDelayMs: 50 });
    const job = thumbs.generateThumbnail(fake.id, 1);
    job.cancel();
    await expect(job.promise).rejects.toMatchObject({ code: 'THUMBNAIL_CANCELLED' });
  });
});

describe('generateThumbnails (batch)', () => {
  it('preserves arbitrary input order', async () => {
    const { fake, thumbs } = makeEngines({
      pageCount: 10,
      renderDelayByPage: { 5: 30, 1: 5, 3: 15, 10: 1 },
    });
    const pages = [5, 1, 3, 10];
    const results = await thumbs.generateThumbnails(fake.id, pages).promise;
    expect(results.map((result) => result.pageNumber)).toEqual(pages);
  });

  it('delivers onThumbnail in page order even when completions race', async () => {
    const { fake, thumbs } = makeEngines({
      pageCount: 5,
      renderDelayByPage: { 1: 40, 2: 1, 3: 1 },
    });
    const delivered: number[] = [];
    const results = await thumbs.generateThumbnails(fake.id, [1, 2, 3], {
      concurrency: 3,
      onThumbnail: (result) => {
        delivered.push(result.pageNumber);
      },
    }).promise;
    expect(results.map((result) => result.pageNumber)).toEqual([1, 2, 3]);
    expect(delivered).toEqual([1, 2, 3]);
  });

  it('reports progress once per thumbnail', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 4 });
    const seen: Array<{ completed: number; total: number }> = [];
    await thumbs.generateThumbnails(fake.id, [1, 2, 3, 4], {
      onProgress: (progress) => {
        seen.push({ completed: progress.completed, total: progress.total });
      },
    }).promise;
    expect(seen).toEqual([
      { completed: 1, total: 4 },
      { completed: 2, total: 4 },
      { completed: 3, total: 4 },
      { completed: 4, total: 4 },
    ]);
  });

  it('bounds concurrency (never unbounded Promise.all)', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 8, renderDelayMs: 15 });
    await thumbs.generateThumbnails(fake.id, [1, 2, 3, 4, 5, 6, 7, 8], { concurrency: 2 }).promise;
    expect(fake.maxActiveRenders).toBeLessThanOrEqual(2);
    expect(fake.maxActiveRenders).toBeGreaterThan(0);
    expect(fake.renderCalls).toHaveLength(8);
    // Every page's dimensions came from its own render, not a second query.
    expect(fake.dimsCalls).toHaveLength(0);
  });

  it('fails atomically with the bad page attributed', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 5, failPages: [3] });
    const failure = await thumbs
      .generateThumbnails(fake.id, [1, 2, 3, 4])
      .promise.catch((error) => error);
    expect(isThumbnailError(failure)).toBe(true);
    expect((failure as ThumbnailError).code).toBe('THUMBNAIL_RENDER_FAILED');
    expect((failure as ThumbnailError).pageNumber).toBe(3);
  });

  it('validates every page upfront without starting renders', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 3 });
    await expect(thumbs.generateThumbnails(fake.id, [1, 99]).promise).rejects.toMatchObject({
      code: 'THUMBNAIL_INVALID_PAGE',
    });
    expect(fake.renderCalls).toHaveLength(0);
  });

  it('rejects empty lists and bad concurrency', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 3 });
    await expect(thumbs.generateThumbnails(fake.id, []).promise).rejects.toMatchObject({
      code: 'THUMBNAIL_INVALID_INPUT',
    });
    await expect(
      thumbs.generateThumbnails(fake.id, [1], { concurrency: 99 }).promise,
    ).rejects.toMatchObject({ code: 'THUMBNAIL_INVALID_INPUT' });
  });

  it('cancels queued pages and never reports success', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 10, renderDelayMs: 30 });
    let completed = 0;
    const job = thumbs.generateThumbnails(fake.id, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], {
      concurrency: 2,
      onProgress: () => {
        completed += 1;
        if (completed === 2) {
          job.cancel();
        }
      },
    });
    await expect(job.promise).rejects.toMatchObject({ code: 'THUMBNAIL_CANCELLED' });
    expect(fake.renderCalls.length).toBeLessThan(10);
  });
});

describe('generateDocumentThumbnails', () => {
  it('generates 1..N in page order', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 5 });
    const results = await thumbs.generateDocumentThumbnails(fake.id).promise;
    expect(results.map((result) => result.pageNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects closed documents', async () => {
    const { fake, thumbs } = makeEngines({ pageCount: 2 });
    await fake.closeDocument(fake.id);
    await expect(thumbs.generateDocumentThumbnails(fake.id).promise).rejects.toMatchObject({
      code: 'THUMBNAIL_CLOSED',
    });
  });
});
