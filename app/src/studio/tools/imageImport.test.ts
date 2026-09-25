/**
 * Import normalization tests: pixel-budget planning, sequential
 * processing, cancellation, error isolation, and original retention.
 * The renderer is injected — no DOM/canvas/WASM needed here.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_IMPORT_LONG_EDGE,
  prepareImportFile,
  planNormalization,
  runImportQueue,
  type ImportRenderer,
} from './imageImport';

function file(name = 'photo.jpg', bytes = 1024): File {
  return new File([new ArrayBuffer(bytes)], name, { type: 'image/jpeg' });
}

describe('planNormalization', () => {
  it('keeps small images untouched (no upscale)', () => {
    expect(planNormalization({ width: 1920, height: 1080 })).toBeNull();
    expect(planNormalization({ width: 1280, height: 960 })).toBeNull();
    expect(planNormalization({ width: 2500, height: 1406 })).toBeNull();
  });

  it('downscales oversized images preserving aspect ratio', () => {
    expect(planNormalization({ width: 4000, height: 3000 })).toEqual({
      width: 2500,
      height: 1875,
    });
    const target = planNormalization({ width: 4032, height: 3024 });
    expect(target).toEqual({ width: 2500, height: 1875 });
    const tall = planNormalization({ width: 3000, height: 6000 });
    expect(tall).toEqual({ width: 1250, height: 2500 });
  });

  it('rejects degenerate dimensions', () => {
    expect(planNormalization({ width: 0, height: 10 })).toBeNull();
    expect(planNormalization({ width: Number.NaN, height: 10 })).toBeNull();
  });

  it('respects a custom budget', () => {
    expect(planNormalization({ width: 3000, height: 1500 }, 1000)).toEqual({
      width: 1000,
      height: 500,
    });
  });
});

describe('prepareImportFile', () => {
  it('converts within-budget PNGs to JPEG (engine has no DCT path for PNG)', async () => {
    const decode = vi.fn(async () => ({ width: 1280, height: 960 }));
    const resizeToJpeg = vi.fn(async () => new Uint8Array([9, 9, 9]));
    const png = new File([new ArrayBuffer(2048)], 'screenshot.PNG', { type: 'image/png' });
    const out = await prepareImportFile(png, { decode, resizeToJpeg });
    expect(out.retainedOriginal).toBe(false);
    expect(out.name).toBe('screenshot.jpg');
    expect(out.file.type).toBe('image/jpeg');
    expect(out.width).toBe(1280);
    expect(out.height).toBe(960);
    expect(resizeToJpeg).toHaveBeenCalledTimes(1);
    expect(resizeToJpeg).toHaveBeenCalledWith(
      expect.anything(),
      { width: 1280, height: 960 },
      0.92,
    );
  });

  it('still retains within-budget JPEGs untouched', async () => {
    const decode = vi.fn(async () => ({ width: 1280, height: 960 }));
    const resizeToJpeg = vi.fn();
    const renderer: ImportRenderer = { decode, resizeToJpeg };
    const original = file();
    const out = await prepareImportFile(original, renderer);
    expect(out.retainedOriginal).toBe(true);
    expect(out.file).toBe(original);
    expect(out.name).toBe('photo.jpg');
    expect(resizeToJpeg).not.toHaveBeenCalled();
  });

  it('normalizes oversized images to one JPEG re-encode', async () => {
    const decode = vi.fn(async () => ({ width: 4000, height: 3000 }));
    const resizeToJpeg = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const out = await prepareImportFile(file('big.JPG'), {
      decode,
      resizeToJpeg,
    });
    expect(out.retainedOriginal).toBe(false);
    expect(out.width).toBe(MAX_IMPORT_LONG_EDGE);
    expect(out.height).toBe(1875);
    expect(out.name).toBe('big.jpg');
    expect(out.file.type).toBe('image/jpeg');
    expect(resizeToJpeg).toHaveBeenCalledTimes(1);
    expect(resizeToJpeg).toHaveBeenCalledWith(
      expect.anything(),
      { width: 2500, height: 1875 },
      0.92,
    );
  });

  it('propagates decode failure with the file name', async () => {
    await expect(
      prepareImportFile(file('broken.jpg'), {
        decode: async () => {
          throw new Error('unsupported format');
        },
        resizeToJpeg: async () => new Uint8Array(),
      }),
    ).rejects.toThrow(/unsupported format/);
  });
});

describe('runImportQueue', () => {
  const prepare = (dims: { width: number; height: number }) => async (f: File) => ({
    file: f,
    name: f.name,
    retainedOriginal: true,
    width: dims.width,
    height: dims.height,
  });

  it('processes strictly sequentially with progress in order', async () => {
    const files = [file('a.jpg'), file('b.jpg'), file('c.jpg')];
    const active: number[] = [];
    let inFlight = 0;
    const progress: Array<[number, number, string]> = [];
    const { outcomes, cancelled } = await runImportQueue(
      files,
      async (f) => {
        inFlight += 1;
        active.push(inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return (await prepare({ width: 1, height: 1 })(f)) as never;
      },
      (completed, total, result) => progress.push([completed, total, result.name]),
      () => false,
    );
    expect(cancelled).toBe(false);
    expect(outcomes).toHaveLength(3);
    // Concurrency never exceeded 1.
    expect(Math.max(...active)).toBe(1);
    expect(progress).toEqual([
      [1, 3, 'a.jpg'],
      [2, 3, 'b.jpg'],
      [3, 3, 'c.jpg'],
    ]);
  });

  it('isolates per-file errors and keeps going', async () => {
    const files = [file('a.jpg'), file('bad.jpg'), file('c.jpg')];
    const { outcomes } = await runImportQueue(
      files,
      async (f) => {
        if (f.name === 'bad.jpg') throw new Error('decode failed');
        return prepare({ width: 1, height: 1 })(f);
      },
      () => undefined,
      () => false,
    );
    expect(outcomes.map((o) => o.error)).toEqual([null, 'decode failed', null]);
    expect(outcomes.filter((o) => o.result !== null)).toHaveLength(2);
  });

  it('stops promptly on cancellation without touching prepared results', async () => {
    const files = [file('a.jpg'), file('b.jpg'), file('c.jpg'), file('d.jpg')];
    let cancel = false;
    const started: string[] = [];
    const { outcomes, cancelled } = await runImportQueue(
      files,
      async (f) => {
        started.push(f.name);
        if (f.name === 'b.jpg') cancel = true;
        return prepare({ width: 1, height: 1 })(f);
      },
      () => undefined,
      () => cancel,
    );
    expect(cancelled).toBe(true);
    // a and b prepared; c never started.
    expect(started).toEqual(['a.jpg', 'b.jpg']);
    expect(outcomes).toHaveLength(2);
  });
});
