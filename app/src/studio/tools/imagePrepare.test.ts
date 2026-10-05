/**
 * Build-time preparation tests. The canvas renderer is stubbed — these
 * tests cover selection (passthrough vs rotate), MIME mapping, and
 * ordering of the contract, not pixel math (covered natively by
 * `engine/tests/pdf_images_to_pdf.rs`).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  browserImageRenderer,
  outputMime,
  preparePageBytes,
  type ImageRenderer,
} from './imagePrepare';
import { createPage } from './imagePages';

function stubRenderer(bytes = new Uint8Array([9, 9, 9])): ImageRenderer & {
  calls: Array<{ degrees: number; mime: string }>;
} {
  const calls: Array<{ degrees: number; mime: string }> = [];
  return {
    calls,
    rotateToBytes: vi.fn(async (_file: File | Blob, degrees: number, mime: string) => {
      calls.push({ degrees, mime });
      return bytes;
    }),
  };
}

describe('outputMime', () => {
  it('always emits JPEG: rotated PNGs must not stay PNG (raw-RGB embed blowup, 5-2)', () => {
    expect(outputMime(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))).toBe('image/jpeg');
    expect(outputMime(new File(['x'], 'b.png', { type: 'image/png' }))).toBe('image/jpeg');
    expect(outputMime(new File(['x'], 'c', { type: '' }))).toBe('image/jpeg');
  });
});

describe('preparePageBytes', () => {
  it('passes unrotated pages through byte-identical without the renderer', async () => {
    const page = createPage({
      id: 'a',
      source: 'upload',
      file: new File(['hello'], 'a.jpg', { type: 'image/jpeg' }),
      name: 'a.jpg',
    });
    const renderer = stubRenderer();
    const out = await preparePageBytes(page, renderer);
    expect(out.name).toBe('a.jpg');
    expect(Array.from(out.bytes)).toEqual([104, 101, 108, 108, 111]);
    expect(renderer.rotateToBytes).not.toHaveBeenCalled();
  });

  it('routes rotated PNG pages through the renderer as JPEG (5-2)', async () => {
    const base = {
      id: 'b',
      source: 'upload' as const,
      file: new File(['x'], 'b.png', { type: 'image/png' }),
      name: 'b.png',
    };
    const renderer = stubRenderer(new Uint8Array([1, 2]));
    const page = { ...createPage(base), rotationDeg: 90 as const };
    const out = await preparePageBytes(page, renderer);
    expect(out.name).toBe('b.png');
    expect(Array.from(out.bytes)).toEqual([1, 2]);
    expect(renderer.calls).toEqual([{ degrees: 90, mime: 'image/jpeg' }]);
  });

  it('routes every quarter-turn of a PNG source as JPEG', async () => {
    for (const degrees of [90, 180, 270] as const) {
      const page = {
        ...createPage({
          id: `p-${degrees}`,
          source: 'upload' as const,
          file: new File(['x'], 'shot.png', { type: 'image/png' }),
          name: 'shot.png',
        }),
        rotationDeg: degrees,
      };
      const renderer = stubRenderer();
      await preparePageBytes(page, renderer);
      expect(renderer.calls).toEqual([{ degrees, mime: 'image/jpeg' }]);
    }
  });

  it('uses JPEG MIME for rotated JPEG sources', async () => {
    const page = {
      ...createPage({
        id: 'c',
        source: 'camera' as const,
        file: new File(['x'], 'scan-001.jpg', { type: 'image/jpeg' }),
        name: 'scan-001.jpg',
      }),
      rotationDeg: 270 as const,
    };
    const renderer = stubRenderer();
    await preparePageBytes(page, renderer);
    expect(renderer.calls).toEqual([{ degrees: 270, mime: 'image/jpeg' }]);
  });
});

describe('browserImageRenderer JPEG-out (5-2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error test-only cleanup of stubbed globals
    delete globalThis.createImageBitmap;
  });

  /** Canvas double recording 2D call order (jsdom has no 2D context). */
  function stubCanvas() {
    const calls: string[] = [];
    const ctx = {
      fillStyle: '',
      fillRect: vi.fn((..._args: unknown[]) => {
        calls.push('fillRect');
      }),
      translate: vi.fn((..._args: unknown[]) => {
        calls.push('translate');
      }),
      rotate: vi.fn((..._args: unknown[]) => {
        calls.push('rotate');
      }),
      drawImage: vi.fn((..._args: unknown[]) => {
        calls.push('drawImage');
      }),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      toBlob: vi.fn((resolve: (blob: Blob | null) => void, mime: string, quality: number) => {
        calls.push(`toBlob:${mime}:${quality}`);
        resolve(new Blob([new Uint8Array([1, 2, 3])], { type: mime }));
      }),
    };
    return { canvas, ctx, calls };
  }

  it('white-fills before drawing and encodes JPEG at q0.95', async () => {
    const { canvas, ctx, calls } = stubCanvas();
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement);
    const close = vi.fn();
    (globalThis as unknown as Record<string, unknown>)['createImageBitmap'] = async () => ({
      width: 40,
      height: 30,
      close,
    });
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const bytes = await browserImageRenderer.rotateToBytes(file, 90, 'image/jpeg');
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    // 90° swaps dims (40×30 → 30×40): the white fill covers the full
    // rotated canvas BEFORE the rotated draw, so transparent PNG pixels
    // composite to white (never baked black).
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 30, 40);
    expect(canvas.width).toBe(0); // Released after encode.
    expect(ctx.fillStyle).toBe('#ffffff');
    const fillAt = calls.indexOf('fillRect');
    const drawAt = calls.indexOf('drawImage');
    expect(fillAt).toBeGreaterThanOrEqual(0);
    expect(drawAt).toBeGreaterThan(fillAt);
    expect(calls).toContain('toBlob:image/jpeg:0.95');
    // Source bitmap + worker snapshot each released exactly once (the
    // worker transfer neuters the sender's copy, so its close is a no-op;
    // without a worker the main-thread fallback encodes from the snapshot).
    expect(close).toHaveBeenCalledTimes(2);
  });
});
