/**
 * `PdfJsRenderEngine` orchestration tests over a mocked `./pdfjs`.
 *
 * The real PDF.js runtime stays out of unit tests (headless-Chrome E2E owns
 * that — see `rendering.test.ts`). These tests pin the engine's own logic:
 * one `getPage` per fitted render, the scale-1 geometry returned with a
 * render, and the per-document dimension cache with its invalidation on
 * `closeDocument`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfJsRenderEngine } from './PdfJsRenderEngine';

const state = vi.hoisted(() => ({
  pageCount: 3,
  specs: new Map<number, { width: number; height: number; rotate: number }>(),
  getPageCalls: [] as number[],
  destroyed: 0,
}));

vi.mock('./pdfjs', () => ({
  pdfjs: () => ({
    VerbosityLevel: { ERRORS: 0 },
    getDocument: () => {
      const proxy = {
        numPages: state.pageCount,
        getMetadata: async () => ({ info: {} }),
        getPage: async (pageNumber: number) => {
          state.getPageCalls.push(pageNumber);
          const spec = state.specs.get(pageNumber) ?? { width: 612, height: 792, rotate: 0 };
          return {
            rotate: spec.rotate,
            getViewport: ({ scale, rotation }: { scale: number; rotation?: number }) => {
              const effective = (((rotation ?? spec.rotate) % 360) + 360) % 360;
              const swapped = effective === 90 || effective === 270;
              return {
                width: (swapped ? spec.height : spec.width) * scale,
                height: (swapped ? spec.width : spec.height) * scale,
              };
            },
            render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
            cleanup: () => undefined,
          };
        },
      };
      return {
        promise: Promise.resolve(proxy),
        destroy: () => {
          state.destroyed += 1;
          return Promise.resolve();
        },
      };
    },
  }),
}));

// jsdom has no canvas backend; the engine only needs a non-null context.
HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as HTMLCanvasElement['getContext'];

async function loadDocument(engine: PdfJsRenderEngine): Promise<string> {
  const loaded = await engine.loadDocument({ data: new Uint8Array([1, 2, 3]) }).promise;
  return loaded.document.id;
}

function makeCanvas(): HTMLCanvasElement {
  return document.createElement('canvas');
}

beforeEach(() => {
  state.pageCount = 3;
  state.specs.clear();
  state.getPageCalls.length = 0;
  state.destroyed = 0;
});

describe('renderPage geometry', () => {
  it('fits to a target box and returns scale-1 geometry in ONE getPage', async () => {
    const engine = new PdfJsRenderEngine();
    const id = await loadDocument(engine);
    const canvas = makeCanvas();
    const result = await engine.renderPage(id, 1, canvas, {
      targetBox: { width: 200, height: 200 },
    }).promise;
    expect(state.getPageCalls).toEqual([1]);
    expect(result.page.sourceWidth).toBe(612);
    expect(result.page.sourceHeight).toBe(792);
    const scale = 200 / 792;
    expect(result.page.scale).toBeCloseTo(scale, 12);
    expect(result.page.width).toBe(Math.floor(612 * scale));
    expect(result.page.height).toBe(200);
    expect(result.page.rotation).toBe(0);
    expect(canvas.width).toBe(result.page.width);
    expect(canvas.height).toBe(result.page.height);
  });

  it('still honors an explicit scale (viewer path) and reports source geometry', async () => {
    const engine = new PdfJsRenderEngine();
    const id = await loadDocument(engine);
    const canvas = makeCanvas();
    const result = await engine.renderPage(id, 1, canvas, { scale: 2 }).promise;
    expect(state.getPageCalls).toEqual([1]);
    expect(result.page.scale).toBe(2);
    expect(result.page.sourceWidth).toBe(612);
    expect(result.page.sourceHeight).toBe(792);
    expect(result.page.width).toBe(1224);
    expect(result.page.height).toBe(1584);
  });

  it('applies intrinsic rotation to render geometry and the cached dimensions', async () => {
    state.specs.set(1, { width: 612, height: 792, rotate: 90 });
    const engine = new PdfJsRenderEngine();
    const id = await loadDocument(engine);
    const result = await engine.renderPage(id, 1, makeCanvas(), {
      targetBox: { width: 200, height: 200 },
    }).promise;
    expect(result.page.rotation).toBe(90);
    expect(result.page.sourceWidth).toBe(792);
    expect(result.page.sourceHeight).toBe(612);
    expect(result.page.width).toBe(200);
    // The render seeded the cache: dimensions need no second getPage.
    const dims = await engine.getPageDimensions(id, 1);
    expect(state.getPageCalls).toEqual([1]);
    expect(dims).toEqual({ documentId: id, pageNumber: 1, width: 792, height: 612, rotation: 90 });
  });

  it('rejects scale + targetBox together before touching PDF.js', async () => {
    const engine = new PdfJsRenderEngine();
    const id = await loadDocument(engine);
    await expect(
      engine.renderPage(id, 1, makeCanvas(), { scale: 1, targetBox: { width: 10, height: 10 } })
        .promise,
    ).rejects.toMatchObject({ code: 'RENDER_INVALID_INPUT' });
    expect(state.getPageCalls).toHaveLength(0);
  });

  it('cancellation still rejects with RENDER_CANCELLED', async () => {
    const engine = new PdfJsRenderEngine();
    const id = await loadDocument(engine);
    const job = engine.renderPage(id, 1, makeCanvas());
    job.cancel();
    await expect(job.promise).rejects.toMatchObject({ code: 'RENDER_CANCELLED' });
  });
});

describe('getPageDimensions cache', () => {
  it('serves repeated queries for the same page/rotation without re-getPage', async () => {
    const engine = new PdfJsRenderEngine();
    const id = await loadDocument(engine);
    const first = await engine.getPageDimensions(id, 1);
    const second = await engine.getPageDimensions(id, 1);
    expect(first).toEqual(second);
    expect(state.getPageCalls).toEqual([1]);
    // A different requested rotation is a different cache key.
    const rotated = await engine.getPageDimensions(id, 1, 90);
    expect(state.getPageCalls).toEqual([1, 1]);
    expect(rotated.width).toBe(792);
    expect(rotated.height).toBe(612);
    expect(rotated.rotation).toBe(90);
    await engine.getPageDimensions(id, 1, 90);
    expect(state.getPageCalls).toEqual([1, 1]);
  });

  it('is dropped with the document record on closeDocument', async () => {
    const engine = new PdfJsRenderEngine();
    const id = await loadDocument(engine);
    await engine.getPageDimensions(id, 1);
    await engine.closeDocument(id);
    expect(state.destroyed).toBe(1);
    await expect(engine.getPageDimensions(id, 1)).rejects.toMatchObject({
      code: 'RENDER_CLOSED',
    });
    // A reopened document starts with an empty cache: getPage runs again.
    const reopened = await loadDocument(engine);
    await engine.getPageDimensions(reopened, 1);
    expect(state.getPageCalls).toEqual([1, 1]);
  });
});
