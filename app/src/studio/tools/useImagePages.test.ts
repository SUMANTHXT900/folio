/**
 * Page-collection hook tests: id stability, ordering, URL lifecycle, and
 * the scan-session contract (uploads + captures interleave in one order;
 * session-scoped retake removes only the session's own last capture).
 *
 * Object URLs are stubbed (jsdom has none); revocation is asserted on
 * the stub. Bytes never enter state — only handles.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useImagePages, type ImportSummary } from './useImagePages';

let counter = 0;
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  counter = 0;
  created.length = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn(() => {
    counter += 1;
    const url = `blob:mock-${counter}`;
    created.push(url);
    return url;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function upload(name: string): File {
  return new File(['img'], name, { type: 'image/jpeg' });
}

describe('useImagePages', () => {
  it('adds entries with stable ids and preview URLs', () => {
    const { result } = renderHook(() => useImagePages());
    let ids: string[] = [];
    act(() => {
      ids = result.current.addEntries([
        { file: upload('a.jpg'), name: 'a.jpg', source: 'upload' },
        { file: upload('b.jpg'), name: 'b.jpg', source: 'camera' },
      ]);
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(result.current.pages.map((p) => p.id)).toEqual(ids);
    expect(result.current.pages.map((p) => p.previewUrl)).toEqual(['blob:mock-1', 'blob:mock-2']);
    expect(result.current.pages[1].source).toBe('camera');
  });

  it('keeps upload/camera interleaving in collection order (Scan More contract)', () => {
    const { result } = renderHook(() => useImagePages());
    act(() => {
      result.current.addFiles([upload('a.jpg'), upload('b.jpg')], 'upload');
    });
    let session: string[] = [];
    act(() => {
      session = result.current.addEntries([
        { file: upload('c.jpg'), name: 'scan-001.jpg', source: 'camera' },
        { file: upload('d.jpg'), name: 'scan-002.jpg', source: 'camera' },
      ]);
    });
    act(() => {
      result.current.addFiles([upload('e.jpg')], 'upload');
    });
    expect(result.current.pages.map((p) => p.name)).toEqual([
      'a.jpg',
      'b.jpg',
      'scan-001.jpg',
      'scan-002.jpg',
      'e.jpg',
    ]);
    // Session-scoped retake: drop only the session's last capture (d),
    // pre-session pages and c survive.
    act(() => {
      const target = session[session.length - 1];
      if (target !== undefined) result.current.remove(target);
    });
    expect(result.current.pages.map((p) => p.name)).toEqual([
      'a.jpg',
      'b.jpg',
      'scan-001.jpg',
      'e.jpg',
    ]);
    expect(revoked).toEqual(['blob:mock-4']);
  });

  it('revokes every URL on clear and none survive unmount', () => {
    const { result, unmount } = renderHook(() => useImagePages());
    act(() => {
      result.current.addFiles([upload('a.jpg'), upload('b.jpg')], 'upload');
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.pages).toHaveLength(0);
    expect(revoked).toEqual(['blob:mock-1', 'blob:mock-2']);
    act(() => {
      result.current.addFiles([upload('c.jpg')], 'upload');
    });
    unmount();
    expect(revoked).toContain('blob:mock-3');
  });

  it('counts skipped non-images without adding them', () => {
    const { result } = renderHook(() => useImagePages());
    let res = { added: 0, skipped: 0 };
    act(() => {
      res = result.current.addFiles(
        [upload('a.jpg'), new File(['x'], 'b.gif', { type: 'image/gif' })],
        'upload',
      );
    });
    expect(res).toEqual({ added: 1, skipped: 1 });
    expect(result.current.pages).toHaveLength(1);
  });

  describe('importFiles (memory-safe bulk import)', () => {
    // jsdom has no createImageBitmap; stub the browser decoder so the
    // REAL queue + normalization path runs against synthetic dimensions.
    const stubDecode = (dims: { width: number; height: number }) => {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        value: vi.fn(async () => ({
          width: dims.width,
          height: dims.height,
          close: vi.fn(),
        })),
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'OffscreenCanvas', {
        value: class {
          constructor(
            public width: number,
            public height: number,
          ) {}
          getContext() {
            return { drawImage: vi.fn() };
          }
          async convertToBlob() {
            return new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' });
          }
        },
        configurable: true,
        writable: true,
      });
    };

    afterEach(() => {
      // @ts-expect-error test-only cleanup of stubbed globals
      delete globalThis.createImageBitmap;
      // @ts-expect-error test-only cleanup of stubbed globals
      delete globalThis.OffscreenCanvas;
    });

    it('commits normalized pages one at a time with progress', async () => {
      stubDecode({ width: 4000, height: 3000 });
      const { result } = renderHook(() => useImagePages());
      const progress: Array<[number, number]> = [];
      let summary: ImportSummary = {
        added: 0,
        skipped: 0,
        failed: 0,
        cancelled: false,
        firstError: null,
      };
      await act(async () => {
        summary = await result.current.importFiles(
          [upload('a.jpg'), upload('b.jpg'), upload('c.jpg')],
          'camera',
          { onProgress: (completed, total) => progress.push([completed, total]) },
        );
      });
      expect(summary.added).toBe(3);
      expect(summary.failed).toBe(0);
      expect(result.current.pages).toHaveLength(3);
      expect(progress).toEqual([
        [1, 3],
        [2, 3],
        [3, 3],
      ]);
      // Each page got exactly one preview URL; all are live.
      expect(created).toEqual(['blob:mock-1', 'blob:mock-2', 'blob:mock-3']);
      expect(revoked).toEqual([]);
    });

    it('keeps already-committed pages on cancellation', async () => {
      stubDecode({ width: 100, height: 100 });
      const { result } = renderHook(() => useImagePages());
      const controller = new AbortController();
      let summary: ImportSummary = {
        added: 0,
        skipped: 0,
        failed: 0,
        cancelled: false,
        firstError: null,
      };
      await act(async () => {
        const job = result.current.importFiles(
          [upload('a.jpg'), upload('b.jpg'), upload('c.jpg')],
          'camera',
          {
            signal: controller.signal,
            onProgress: (completed) => {
              if (completed === 1) controller.abort();
            },
          },
        );
        summary = await job;
      });
      expect(summary.cancelled).toBe(true);
      expect(summary.added).toBe(1);
      expect(result.current.pages).toHaveLength(1);
      // The committed page's preview URL survives; none were revoked.
      expect(revoked).toEqual([]);
    });

    it('isolates per-file failures and reports the first error', async () => {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        value: vi.fn(async (f: File) => {
          if (f.name.startsWith('bad')) throw new Error('unsupported format');
          return { width: 100, height: 100, close: vi.fn() };
        }),
        configurable: true,
        writable: true,
      });
      const { result } = renderHook(() => useImagePages());
      let summary: ImportSummary = {
        added: 0,
        skipped: 0,
        failed: 0,
        cancelled: false,
        firstError: null,
      };
      await act(async () => {
        summary = await result.current.importFiles(
          [upload('a.jpg'), upload('bad.jpg'), upload('c.jpg')],
          'camera',
        );
      });
      expect(summary.added).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.firstError).toContain('unsupported format');
      expect(result.current.pages.map((p) => p.name)).toEqual(['a.jpg', 'c.jpg']);
    });
  });
});
