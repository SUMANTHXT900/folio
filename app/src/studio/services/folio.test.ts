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
  __previewCacheForTests,
  __thumbCacheForTests,
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

  it('passes a caller Blob through without copying (mirrors studioDownload)', async () => {
    const seenFiles: File[] = [];
    nav['canShare'] = vi.fn(() => true);
    nav['share'] = vi.fn((data: { files?: File[] }) => {
      seenFiles.push(...(data.files ?? []));
      return Promise.resolve();
    });
    const RealBlob = globalThis.Blob;
    let blobConstructions = 0;
    globalThis.Blob = class extends RealBlob {
      constructor(...args: ConstructorParameters<typeof RealBlob>) {
        super(...args);
        blobConstructions += 1;
      }
    };
    const blob = new globalThis.Blob(['abc'], { type: 'application/pdf' });
    blobConstructions = 0;
    try {
      await expect(studioShare(blob, 'doc.pdf')).resolves.toBe('shared');
    } finally {
      globalThis.Blob = RealBlob;
    }
    // No intermediate Blob: the caller's Blob went straight into the File.
    expect(blobConstructions).toBe(0);
    expect(seenFiles).toHaveLength(1);
    expect(Array.from(new Uint8Array(await seenFiles[0].arrayBuffer()))).toEqual([97, 98, 99]);
    expect(seenFiles[0].name).toBe('doc.pdf');
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

describe('encodeThumbCanvases cancellation', () => {
  interface FakeCanvas {
    width: number;
    height: number;
  }

  const toItems = (count: number): Array<{ canvas: FakeCanvas; pageNumber: number }> =>
    Array.from({ length: count }, (_, i) => ({
      canvas: { width: 40, height: 40 },
      pageNumber: i + 1,
    }));

  const asServiceItems = (
    items: Array<{ canvas: FakeCanvas; pageNumber: number }>,
  ): Array<{ canvas: HTMLCanvasElement; pageNumber: number }> =>
    items as unknown as Array<{ canvas: HTMLCanvasElement; pageNumber: number }>;

  const revoked: string[] = [];

  beforeEach(() => {
    revoked.length = 0;
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts before any encode when already cancelled, releasing canvases', async () => {
    const items = toItems(3);
    const encodeOne = vi.fn(async () => 'blob:x');
    await expect(
      encodeThumbCanvases(asServiceItems(items), 2, encodeOne, () => true),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(encodeOne).not.toHaveBeenCalled();
    for (const item of items) {
      expect(item.canvas.width).toBe(0);
      expect(item.canvas.height).toBe(0);
    }
    expect(revoked).toEqual([]);
  });

  it('revokes minted URLs and releases unclaimed canvases on a mid-run abort', async () => {
    const items = toItems(5);
    let calls = 0;
    const encodeOne = async (): Promise<string> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return `blob:${calls}`;
    };
    await expect(
      encodeThumbCanvases(asServiceItems(items), 1, encodeOne, () => calls >= 2),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    // Exactly the two minted URLs are revoked — nothing orphaned, and no
    // cache write could have happened (the throw precedes it).
    expect(revoked).toEqual(['blob:1', 'blob:2']);
    for (const item of items) {
      expect(item.canvas.width).toBe(0);
      expect(item.canvas.height).toBe(0);
    }
  });
});

describe('studioThumb dead path', () => {
  it('has no single-thumb helper — windows use bounded encodeThumbCanvases', async () => {
    const mod = (await import('./folio')) as Record<string, unknown>;
    expect(mod['studioThumb']).toBeUndefined();
    expect(typeof mod['studioThumbWindow']).toBe('function');
    expect(typeof mod['encodeThumbCanvases']).toBe('function');
  });
});

describe('preview cache ownership', () => {
  const revoked: string[] = [];

  beforeEach(() => {
    revoked.length = 0;
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
    __previewCacheForTests.clearForTests();
  });

  afterEach(() => {
    __previewCacheForTests.clearForTests();
    vi.restoreAllMocks();
  });

  it('evicts LRU beyond the cap and never re-serves the revoked URL', () => {
    const cache = __previewCacheForTests;
    for (let page = 1; page <= cache.max + 2; page += 1) {
      cache.touch(cache.key('renderdoc-9', page), `blob:p${page}`);
    }
    expect(cache.size()).toBe(cache.max);
    // The two oldest entries were evicted and revoked...
    expect(revoked).toEqual(['blob:p1', 'blob:p2']);
    // ...and a hit on an evicted key misses (forces a re-render) instead
    // of reserving the revoked URL.
    expect(cache.hit(cache.key('renderdoc-9', 1))).toBeUndefined();
    expect(cache.live('renderdoc-9', 1, 'blob:p1')).toBe(false);
    // Live entries still hit with validity intact.
    expect(cache.hit(cache.key('renderdoc-9', cache.max + 2))).toBe(`blob:p${cache.max + 2}`);
    expect(cache.live('renderdoc-9', cache.max + 2, `blob:p${cache.max + 2}`)).toBe(true);
  });
});

describe('thumbnail cache bounds and eviction signaling', () => {
  const revoked: string[] = [];

  beforeEach(() => {
    revoked.length = 0;
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
    __thumbCacheForTests.clearForTests();
  });

  afterEach(() => {
    __thumbCacheForTests.clearForTests();
    vi.restoreAllMocks();
  });

  it('evicts the oldest document beyond the doc cap and notifies once', () => {
    const cache = __thumbCacheForTests;
    const seen: string[] = [];
    const unsubscribe = cache.subscribe((docId) => {
      seen.push(docId);
    });
    for (let d = 0; d < cache.maxDocs + 1; d += 1) {
      const pages = cache.touch(`doc-${d}`);
      cache.set(pages, `doc-${d}`, 1, `blob:doc-${d}-p1`);
    }
    expect(cache.has('doc-0')).toBe(false);
    expect(cache.has(`doc-${cache.maxDocs}`)).toBe(true);
    expect(seen).toEqual(['doc-0']);
    expect(cache.generation('doc-0')).toBe(1);
    expect(revoked).toEqual(['blob:doc-0-p1']);
    unsubscribe();
  });

  it('caps pages per document, revokes evicted pages, and reports liveness', () => {
    const cache = __thumbCacheForTests;
    const seen: string[] = [];
    const unsubscribe = cache.subscribe((docId) => {
      seen.push(docId);
    });
    const pages = cache.touch('big-doc');
    for (let p = 1; p <= cache.maxPagesPerDoc + 5; p += 1) {
      cache.set(pages, 'big-doc', p, `blob:big-${p}`);
    }
    expect(cache.size('big-doc')).toBe(cache.maxPagesPerDoc);
    // Evicted pages are revoked and no longer live...
    expect(cache.live('big-doc', 1, 'blob:big-1')).toBe(false);
    expect(revoked).toContain('blob:big-1');
    // ...while the newest page is live, and every eviction notified.
    expect(
      cache.live('big-doc', cache.maxPagesPerDoc + 5, `blob:big-${cache.maxPagesPerDoc + 5}`),
    ).toBe(true);
    expect(seen).toEqual(['big-doc', 'big-doc', 'big-doc', 'big-doc', 'big-doc']);
    expect(cache.generation('big-doc')).toBe(5);
    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    const cache = __thumbCacheForTests;
    const pages = cache.touch('ghost-doc');
    cache.set(pages, 'ghost-doc', 1, 'blob:ghost-1');
    const seen: string[] = [];
    const unsubscribe = cache.subscribe((docId) => {
      seen.push(docId);
    });
    unsubscribe();
    cache.revokeDoc('ghost-doc');
    expect(seen).toEqual([]);
    expect(cache.has('ghost-doc')).toBe(false);
  });
});
