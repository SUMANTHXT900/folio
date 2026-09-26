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
  /** Renderer double that records decode/resize/close call ordering. */
  function rendererWith(dims = { width: 1280, height: 960 }, bytes = [9, 9, 9]) {
    const decoded = { width: dims.width, height: dims.height, bitmap: { tag: 'bitmap' } };
    const decode = vi.fn(async () => decoded);
    const resizeToJpeg = vi.fn(async () => new Uint8Array(bytes));
    const close = vi.fn();
    const renderer: ImportRenderer = { decode, resizeToJpeg, close };
    return { renderer, decoded, decode, resizeToJpeg, close };
  }

  it('converts within-budget PNGs to JPEG (engine has no DCT path for PNG)', async () => {
    const { renderer, decoded, decode, resizeToJpeg, close } = rendererWith();
    const png = new File([new ArrayBuffer(2048)], 'screenshot.PNG', { type: 'image/png' });
    const out = await prepareImportFile(png, renderer);
    expect(out.retainedOriginal).toBe(false);
    expect(out.name).toBe('screenshot.jpg');
    expect(out.file.type).toBe('image/jpeg');
    expect(out.width).toBe(1280);
    expect(out.height).toBe(960);
    // ONE decode serves both the dimension check and the resize.
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledWith(png);
    expect(resizeToJpeg).toHaveBeenCalledTimes(1);
    expect(resizeToJpeg).toHaveBeenCalledWith(decoded, { width: 1280, height: 960 }, 0.92);
    // The decoded bitmap is released exactly once, by the caller.
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(decoded);
  });

  it('still retains within-budget JPEGs untouched', async () => {
    const { renderer, decoded, decode, resizeToJpeg, close } = rendererWith();
    const original = file();
    const out = await prepareImportFile(original, renderer);
    expect(out.retainedOriginal).toBe(true);
    expect(out.file).toBe(original);
    expect(out.name).toBe('photo.jpg');
    expect(decode).toHaveBeenCalledTimes(1);
    expect(resizeToJpeg).not.toHaveBeenCalled();
    // Retained originals still release the decode.
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(decoded);
  });

  it('normalizes oversized images to one JPEG re-encode from one decode', async () => {
    const { renderer, decoded, decode, resizeToJpeg, close } = rendererWith(
      { width: 4000, height: 3000 },
      [1, 2, 3],
    );
    const out = await prepareImportFile(file('big.JPG'), renderer);
    expect(out.retainedOriginal).toBe(false);
    expect(out.width).toBe(MAX_IMPORT_LONG_EDGE);
    expect(out.height).toBe(1875);
    expect(out.name).toBe('big.jpg');
    expect(out.file.type).toBe('image/jpeg');
    expect(decode).toHaveBeenCalledTimes(1);
    expect(resizeToJpeg).toHaveBeenCalledTimes(1);
    expect(resizeToJpeg).toHaveBeenCalledWith(decoded, { width: 2500, height: 1875 }, 0.92);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(decoded);
  });

  it('propagates decode failure with the file name and never resizes', async () => {
    const resizeToJpeg = vi.fn(async () => new Uint8Array());
    const close = vi.fn();
    await expect(
      prepareImportFile(file('broken.jpg'), {
        decode: async () => {
          throw new Error('unsupported format');
        },
        resizeToJpeg,
        close,
      }),
    ).rejects.toThrow(/unsupported format/);
    expect(resizeToJpeg).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('rejects degenerate dimensions with the documented message and closes the decode', async () => {
    const { renderer, decoded, resizeToJpeg, close } = rendererWith({ width: 0, height: 960 });
    await expect(prepareImportFile(file('empty.jpg'), renderer)).rejects.toThrow(
      'could not read image dimensions for empty.jpg',
    );
    expect(resizeToJpeg).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(decoded);
  });

  it('closes the decode exactly once when re-encoding fails', async () => {
    const { renderer, decoded, resizeToJpeg, close } = rendererWith({ width: 4000, height: 3000 });
    resizeToJpeg.mockRejectedValueOnce(new Error('2D canvas unavailable'));
    await expect(prepareImportFile(file('big.jpg'), renderer)).rejects.toThrow(
      /2D canvas unavailable/,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(decoded);
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
