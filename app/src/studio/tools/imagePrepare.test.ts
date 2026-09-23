/**
 * Build-time preparation tests. The canvas renderer is stubbed — these
 * tests cover selection (passthrough vs rotate), MIME mapping, and
 * ordering of the contract, not pixel math (covered natively by
 * `engine/tests/pdf_images_to_pdf.rs`).
 */
import { describe, expect, it, vi } from 'vitest';
import { outputMime, preparePageBytes, type ImageRenderer } from './imagePrepare';
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
  it('keeps JPEG as JPEG and maps everything else to PNG', () => {
    expect(outputMime(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))).toBe('image/jpeg');
    expect(outputMime(new File(['x'], 'b.png', { type: 'image/png' }))).toBe('image/png');
    expect(outputMime(new File(['x'], 'c', { type: '' }))).toBe('image/png');
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

  it('routes rotated pages through the renderer with degrees + MIME', async () => {
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
    expect(renderer.calls).toEqual([{ degrees: 90, mime: 'image/png' }]);
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
