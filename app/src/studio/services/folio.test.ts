/**
 * Studio service unit tests (pure parts only).
 *
 * `toStudioError` and `studioStripExt` touch no engines, workers, or
 * DOM — safe for jsdom. Engine-backed behavior (open/run/thumbs) is
 * covered by the production browser E2E (`e2e/studio.e2e.mjs`), never
 * mocked here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeFileName } from '../components/downloadNaming';
import {
  encodeThumbCanvases,
  formatDurationMs,
  isPdfBytes,
  studioDownload,
  studioShare,
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

  it('sanitizes raw names instead of trusting callers', () => {
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
    const raw = 'a/b\\c:d*e?f"g<h>i|j';
    studioDownload(new Uint8Array([1, 2, 3]), raw);
    expect(clicks).toEqual([sanitizeFileName(raw)]);
    expect(clicks[0]).not.toMatch(/[\\/:*?"<>|]/);
    expect(clicks[0]).toMatch(/\.pdf$/);
  });

  it('caps overlong names to the filesystem limit', () => {
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
    studioDownload(new Uint8Array([1, 2, 3]), 'x'.repeat(200));
    expect(clicks[0]).toBe(sanitizeFileName('x'.repeat(200)));
    expect(clicks[0].length).toBeLessThanOrEqual(120);
    expect(clicks[0]).toMatch(/\.pdf$/);
  });

  it('trims dot-heavy names to a clean basename', () => {
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
    studioDownload(new Uint8Array([1, 2, 3]), '  ...lead...trail...   ');
    expect(clicks[0]).toBe(sanitizeFileName('  ...lead...trail...   '));
    expect(clicks[0]).not.toMatch(/^\./);
    expect(clicks[0]).toMatch(/\.pdf$/);
  });
});

describe('studioShare', () => {
  const nav = navigator as unknown as Record<string, unknown>;
  const originalShare = nav['share'];
  const originalCanShare = nav['canShare'];

  afterEach(() => {
    if (originalShare === undefined) {
      delete nav['share'];
    } else {
      nav['share'] = originalShare;
    }
    if (originalCanShare === undefined) {
      delete nav['canShare'];
    } else {
      nav['canShare'] = originalCanShare;
    }
    vi.restoreAllMocks();
  });

  it('shares with a sanitized filename and title', async () => {
    const seenFiles: File[] = [];
    let seenTitle: string | undefined;
    nav['canShare'] = vi.fn((data: { files?: File[] }) => {
      seenFiles.push(...(data.files ?? []));
      return true;
    });
    nav['share'] = vi.fn((data: { files?: File[]; title?: string }) => {
      seenTitle = data.title;
      return Promise.resolve();
    });
    const raw = 'a/b\\c:d*e?f"g<h>i|j';
    await expect(studioShare(new Uint8Array([1, 2, 3]), raw)).resolves.toBe('shared');
    expect(seenFiles).toHaveLength(1);
    expect(seenFiles[0].name).toBe(sanitizeFileName(raw));
    expect(seenTitle).toBe(sanitizeFileName(raw));
  });

  it('returns unavailable when the Web Share API is missing', async () => {
    delete nav['share'];
    delete nav['canShare'];
    await expect(studioShare(new Uint8Array([1, 2, 3]), 'doc.pdf')).resolves.toBe('unavailable');
  });
});

describe('isPdfBytes', () => {
  const header = (extra: number[] = []): Uint8Array =>
    new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...extra]);

  it('accepts a plain header', () => {
    expect(isPdfBytes(header([0x31, 0x2e, 0x34]))).toBe(true);
  });

  it('accepts a BOM-prefixed header', () => {
    expect(isPdfBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...header()]))).toBe(true);
  });

  it('accepts whitespace/newline-prefixed headers', () => {
    expect(isPdfBytes(new Uint8Array([0x20, 0x0a, ...header()]))).toBe(true);
  });

  it('accepts tiny-but-well-formed headers (only >=5 bytes required)', () => {
    expect(isPdfBytes(header())).toBe(true);
    expect(header().length).toBe(5);
  });

  it('rejects empty, truncated, and non-PDF input', () => {
    expect(isPdfBytes(new Uint8Array([]))).toBe(false);
    expect(isPdfBytes(new Uint8Array([0x25, 0x50, 0x44]))).toBe(false);
    expect(isPdfBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(false);
    expect(isPdfBytes(new Uint8Array([0x20, 0x20, 0x20, 0x20, 0x20, 0x20]))).toBe(false);
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
