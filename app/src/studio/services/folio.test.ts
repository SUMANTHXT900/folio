/**
 * Studio service unit tests (pure parts only).
 *
 * `toStudioError` and `studioStripExt` touch no engines, workers, or
 * DOM — safe for jsdom. Engine-backed behavior (open/run/thumbs) is
 * covered by the production browser E2E (`e2e/studio.e2e.mjs`), never
 * mocked here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeThumbCanvases,
  formatDurationMs,
  studioDownload,
  studioStripExt,
  toStudioError,
} from './folio';

describe('toStudioError', () => {
  it('maps known codes to human messages and preserves the code', () => {
    const error = toStudioError(
      { code: 'PAGE_OUT_OF_RANGE', message: 'raw', details: 'page=99' },
      'pdf.extract_pages',
    );
    expect(error.code).toBe('PAGE_OUT_OF_RANGE');
    expect(error.message).toContain('outside the document');
    expect(error.message).not.toContain('raw');
    expect(error.details).toBe('page=99');
    expect(error.operation).toBe('pdf.extract_pages');
    expect(error).toBeInstanceOf(Error);
  });

  it('preserves the raw engine message and details for secondary display', () => {
    const error = toStudioError(
      { code: 'PAGE_OUT_OF_RANGE', message: 'entry 1 references page 999', details: 'page=999' },
      'pdf.extract_pages',
    );
    expect(error.engineMessage).toBe('entry 1 references page 999');
    expect(error.details).toBe('page=999');
  });

  it('passes cancellation through recognizably', () => {
    const error = toStudioError({ code: 'CANCELLED' }, 'pdf.merge');
    expect(error.code).toBe('CANCELLED');
    expect(error.message).toMatch(/cancel/i);
  });

  it('falls back safely for unknown shapes', () => {
    const error = toStudioError({}, 'pdf.rotate');
    expect(error.code).toBe('INTERNAL');
    expect(error.message.length).toBeGreaterThan(0);
  });
});

describe('formatDurationMs', () => {
  it('formats sub-second durations as ms', () => {
    expect(formatDurationMs(0)).toBe('0ms');
    expect(formatDurationMs(380)).toBe('380ms');
  });

  it('formats second-scale durations with two decimals', () => {
    expect(formatDurationMs(1240)).toBe('1.24s');
    expect(formatDurationMs(18400)).toBe('18.40s');
  });
});

describe('studioStripExt', () => {
  it('strips common extensions', () => {
    expect(studioStripExt('report.pdf')).toBe('report');
    expect(studioStripExt('UPPER.PDF')).toBe('UPPER');
    expect(studioStripExt('no-ext')).toBe('no-ext');
  });
});

describe('studioDownload', () => {
  const revoked: string[] = [];

  beforeEach(() => {
    revoked.length = 0;
    URL.createObjectURL = vi.fn(() => 'blob:download-1');
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('downloads bytes through one object URL and revokes it', () => {
    const clicks: string[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(`${this.href}|${this.download}`);
    });
    studioDownload(new Uint8Array([1, 2, 3]), 'images.pdf');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicks).toEqual(['blob:download-1|images.pdf']);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(revoked).toEqual(['blob:download-1']);
    clickSpy.mockRestore();
  });

  it('reuses a caller-provided Blob without copying', () => {
    const blob = new Blob(['abc'], { type: 'application/pdf' });
    const createSpy = vi.mocked(URL.createObjectURL);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    studioDownload(blob, 'images.pdf');
    // One URL from the given Blob — no second Blob is constructed here
    // (Blob identity is preserved through the call).
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toBe(blob);
  });
});

describe('encodeThumbCanvases', () => {
  interface FakeCanvas {
    width: number;
    height: number;
    tag: number;
  }

  interface FakeItem {
    canvas: FakeCanvas;
    pageNumber: number;
  }

  type ServiceItem = { canvas: HTMLCanvasElement; pageNumber: number };

  const toItems = (tags: number[]): FakeItem[] =>
    tags.map((tag) => ({ canvas: { width: 40, height: 40, tag }, pageNumber: tag + 1 }));

  const asServiceItems = (items: FakeItem[]): ServiceItem[] => items as unknown as ServiceItem[];

  const readTag = (canvas: HTMLCanvasElement): number => (canvas as unknown as FakeCanvas).tag;

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('encodes with bounded concurrency while preserving input order', async () => {
    const items = toItems([0, 1, 2, 3, 4]);
    let inFlight = 0;
    let maxInFlight = 0;
    const urls = await encodeThumbCanvases(asServiceItems(items), 2, async (canvas) => {
      const tag = readTag(canvas);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // Reverse delays: later inputs finish first, so input order in the
        // output proves order restoration rather than completion order.
        await delay((4 - tag) * 5);
        return `blob:${tag}`;
      } finally {
        inFlight -= 1;
      }
    });
    expect(urls).toEqual(['blob:0', 'blob:1', 'blob:2', 'blob:3', 'blob:4']);
    expect(maxInFlight).toBe(2);
    for (const item of items) {
      expect(item.canvas.width).toBe(0);
      expect(item.canvas.height).toBe(0);
    }
  });

  it('rethrows the first encode error after releasing every canvas', async () => {
    const items = toItems([0, 1, 2]);
    const failure = new Error('encode blew up');
    await expect(
      encodeThumbCanvases(asServiceItems(items), 2, async (canvas) => {
        const tag = readTag(canvas);
        await delay(tag * 5);
        if (tag === 0) {
          throw failure;
        }
        return `blob:${tag}`;
      }),
    ).rejects.toBe(failure);
    for (const item of items) {
      expect(item.canvas.width).toBe(0);
      expect(item.canvas.height).toBe(0);
    }
  });

  it('handles empty input and oversized concurrency', async () => {
    await expect(encodeThumbCanvases([], 2, async () => 'x')).resolves.toEqual([]);
    const items = toItems([0]);
    await expect(
      encodeThumbCanvases(asServiceItems(items), 99, async () => 'blob:only'),
    ).resolves.toEqual(['blob:only']);
    expect(items[0].canvas.width).toBe(0);
  });
});
