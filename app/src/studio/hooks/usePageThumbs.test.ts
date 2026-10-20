/**
 * `usePageThumbs` tests: dirty-index publishing (incremental counts, no
 * full-array scans per wave) and eviction invalidation (a service-side
 * evict blanks the hook array so revoked URLs are never served).
 *
 * The engine window is mocked; the REAL subscription/generation path is
 * exercised through `__thumbCacheForTests`.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/folio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/folio')>();
  return { ...actual, studioThumbWindow: vi.fn(), studioPreview: vi.fn() };
});

import { __thumbCacheForTests, studioThumbWindow } from '../services/folio';
import { usePageThumbs } from './usePageThumbs';

const mockedWindow = vi.mocked(studioThumbWindow);

function windowImpl(
  docId: string,
  pages: number[],
): { done: Promise<Map<number, string>>; cancel: () => void } {
  return {
    done: Promise.resolve(new Map(pages.map((p) => [p, `blob:${docId}-${p}`] as [number, string]))),
    cancel: vi.fn(),
  };
}

beforeEach(() => {
  URL.revokeObjectURL = vi.fn();
  __thumbCacheForTests.clearForTests();
  mockedWindow.mockReset();
  mockedWindow.mockImplementation(windowImpl);
});

afterEach(() => {
  __thumbCacheForTests.clearForTests();
  vi.restoreAllMocks();
});

describe('usePageThumbs publishing', () => {
  it('publishes the first wave fast with an incremental count', async () => {
    const { result, unmount } = renderHook(() => usePageThumbs());
    let first: string[] = [];
    await act(async () => {
      first = await result.current.load('doc-1', 50, 24);
    });
    expect(first.filter(Boolean)).toHaveLength(24);
    expect(first[0]).toBe('blob:doc-1-1');
    expect(result.current.progress).toEqual({ done: 24, total: 50 });
    // Engine saw exactly the first wave (bounded window, not the doc).
    expect(mockedWindow.mock.calls[0]?.[1]).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    // Stop the detached background fill so later tests start clean.
    act(() => {
      result.current.cancel();
    });
    unmount();
  });

  it('streams background waves to a dense array and clears progress at the end', async () => {
    const { result, unmount } = renderHook(() => usePageThumbs());
    await act(async () => {
      await result.current.load('doc-1', 50, 24);
    });
    await waitFor(() => expect(result.current.progress).toBeNull(), { timeout: 5000 });
    const thumbs = result.current.thumbs;
    expect(thumbs).toHaveLength(50);
    expect(thumbs.filter(Boolean)).toHaveLength(50);
    expect(thumbs[49]).toBe('blob:doc-1-50');
    // Three bounded windows: 24 + 24 + 2 — never one whole-document call.
    expect(mockedWindow).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('fillAll resumes only the holes with incremental counts', async () => {
    const { result, unmount } = renderHook(() => usePageThumbs());
    await act(async () => {
      await result.current.load('doc-1', 10, 10);
    });
    // Full first wave: no background fill, no holes left.
    await waitFor(() => expect(result.current.progress).toBeNull(), { timeout: 5000 });
    expect(result.current.thumbs.filter(Boolean)).toHaveLength(10);
    mockedWindow.mockClear();
    await act(async () => {
      await result.current.fillAll();
    });
    // No holes, no engine calls.
    expect(mockedWindow).not.toHaveBeenCalled();
    unmount();
  });
});

describe('usePageThumbs render box (F-23)', () => {
  it('forwards an explicit box to every window of the document', async () => {
    const { result, unmount } = renderHook(() => usePageThumbs());
    await act(async () => {
      await result.current.load('doc-box', 50, 24, 384);
    });
    // First wave carries the grid box; the detached background wave does too.
    expect(mockedWindow.mock.calls[0]?.[2]).toEqual({ box: 384 });
    await waitFor(() => expect(result.current.progress).toBeNull(), { timeout: 5000 });
    for (const call of mockedWindow.mock.calls) {
      expect(call[2]).toEqual({ box: 384 });
    }
    unmount();
  });

  it('omits the box argument entirely at list tier (default path unchanged)', async () => {
    const { result, unmount } = renderHook(() => usePageThumbs());
    await act(async () => {
      await result.current.load('doc-list', 10, 10);
    });
    await waitFor(() => expect(result.current.progress).toBeNull(), { timeout: 5000 });
    for (const call of mockedWindow.mock.calls) {
      expect(call.length).toBe(2);
    }
    unmount();
  });
});

describe('usePageThumbs eviction invalidation', () => {
  it('blanks the array when the service evicts the current document', async () => {
    const { result, unmount } = renderHook(() => usePageThumbs());
    await act(async () => {
      await result.current.load('doc-1', 10, 10);
    });
    await waitFor(() => expect(result.current.progress).toBeNull(), { timeout: 5000 });
    expect(result.current.thumbs.filter(Boolean)).toHaveLength(10);

    // Seed the REAL service cache so the evict carries revoked URLs.
    const live = __thumbCacheForTests.touch('doc-1');
    __thumbCacheForTests.set(live, 'doc-1', 1, 'blob:real-1');
    act(() => {
      __thumbCacheForTests.revokeDoc('doc-1');
    });

    // Hook array invalidated: no revoked URL is ever served again.
    expect(result.current.thumbs).toEqual(new Array(10).fill(''));
    expect(result.current.progress).toEqual({ done: 0, total: 10 });
    unmount();
  });

  it('ignores evictions for other documents', async () => {
    const { result, unmount } = renderHook(() => usePageThumbs());
    await act(async () => {
      await result.current.load('doc-1', 6, 6);
    });
    await waitFor(() => expect(result.current.progress).toBeNull(), { timeout: 5000 });
    const before = [...result.current.thumbs];
    const live = __thumbCacheForTests.touch('doc-2');
    __thumbCacheForTests.set(live, 'doc-2', 1, 'blob:other-1');
    act(() => {
      __thumbCacheForTests.revokeDoc('doc-2');
    });
    expect(result.current.thumbs).toEqual(before);
    unmount();
  });
});

describe('usePageThumbs background-fill liveness', () => {
  it('drops a background window evicted mid-await (revoked URLs never repopulate)', async () => {
    const { result, unmount } = renderHook(() => usePageThumbs());
    // Seed the service cache so the evict below bumps the thumb generation.
    const live = __thumbCacheForTests.touch('doc-1');
    __thumbCacheForTests.set(live, 'doc-1', 1, 'blob:seed-1');

    let resolveBg!: (value: Map<number, string>) => void;
    const bgGate = new Promise<Map<number, string>>((resolve) => {
      resolveBg = resolve;
    });
    mockedWindow.mockImplementationOnce(windowImpl); // first wave: immediate
    mockedWindow.mockImplementation(() => ({ done: bgGate, cancel: vi.fn() }));

    await act(async () => {
      await result.current.load('doc-1', 50, 24);
    });
    // The background window is now in flight (past the pacing sleep).
    await waitFor(() => expect(mockedWindow).toHaveBeenCalledTimes(2));
    // Evict mid-await: blanks the hook array and bumps the generation.
    act(() => {
      __thumbCacheForTests.revokeDoc('doc-1');
    });
    expect(result.current.thumbs.every((url) => url === '')).toBe(true);
    // The superseded window resolves late with revoked URLs.
    const late = new Map(
      Array.from({ length: 24 }, (_, i) => [i + 25, `blob:doc-1-${i + 25}`]) as Array<
        [number, string]
      >,
    );
    await act(async () => {
      resolveBg(late);
      await new Promise((r) => setTimeout(r, 100));
    });
    // Dropped: nothing repopulated.
    expect(result.current.thumbs.filter(Boolean)).toHaveLength(0);
    act(() => {
      result.current.cancel();
    });
    unmount();
  });
});

describe('usePageThumbs fill exclusivity', () => {
  it('fillAll supersedes background fill (cancelled lane, no double windows)', async () => {
    const { result, unmount } = renderHook(() => usePageThumbs());
    let resolveBg!: (value: Map<number, string>) => void;
    const bgGate = new Promise<Map<number, string>>((resolve) => {
      resolveBg = resolve;
    });
    const bgCancel = vi.fn();
    mockedWindow.mockImplementationOnce(windowImpl); // first wave: immediate
    mockedWindow.mockImplementation(() => ({ done: bgGate, cancel: bgCancel }));

    await act(async () => {
      await result.current.load('doc-1', 50, 24);
    });
    await waitFor(() => expect(mockedWindow).toHaveBeenCalledTimes(2));

    // fillAll takes over with immediately-resolving windows.
    mockedWindow.mockImplementation(windowImpl);
    await act(async () => {
      await result.current.fillAll();
    });
    // Four engine calls: first wave + gated background + two fillAll waves.
    expect(mockedWindow).toHaveBeenCalledTimes(4);
    // The superseded background lane was cancelled in flight.
    expect(bgCancel).toHaveBeenCalled();
    // Its late result must not clobber the filled array.
    const late = new Map(
      Array.from({ length: 24 }, (_, i) => [i + 25, `blob:SENTINEL-${i + 25}`]) as Array<
        [number, string]
      >,
    );
    await act(async () => {
      resolveBg(late);
      await new Promise((r) => setTimeout(r, 100));
    });
    const thumbs = result.current.thumbs;
    expect(thumbs).toHaveLength(50);
    expect(thumbs.filter(Boolean)).toHaveLength(50);
    expect(thumbs.some((url) => url.includes('SENTINEL'))).toBe(false);
    expect(thumbs[49]).toBe('blob:doc-1-50');
    unmount();
  });
});

describe('usePageThumbs box validation', () => {
  it('rejects invalid boxes as a no-op (later loads unpoisoned)', async () => {
    const { result, unmount } = renderHook(() => usePageThumbs());
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, 'x']) {
      await act(async () => {
        await expect(
          result.current.load('doc-1', 10, 10, bad as unknown as number),
        ).rejects.toThrow(/Invalid thumbnail box/);
      });
    }
    expect(mockedWindow).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    // A later valid load fills every page: nothing was marked failed.
    await act(async () => {
      await result.current.load('doc-1', 10, 10, 384);
    });
    await waitFor(() => expect(result.current.progress).toBeNull(), { timeout: 5000 });
    expect(result.current.thumbs.filter(Boolean)).toHaveLength(10);
    expect(mockedWindow.mock.calls[0]?.[2]).toEqual({ box: 384 });
    unmount();
  });
});

describe('usePageThumbs loading reset', () => {
  it('resets loading when the first wave fails', async () => {
    mockedWindow.mockImplementationOnce(() => ({
      done: Promise.reject(new Error('engine boom')),
      cancel: vi.fn(),
    }));
    const { result, unmount } = renderHook(() => usePageThumbs());
    await act(async () => {
      await expect(result.current.load('doc-1', 10, 10)).rejects.toThrow(
        'Could not render page previews.',
      );
    });
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it('resets loading when the first wave is cancelled', async () => {
    let rejectFirst!: (error: Error) => void;
    const gate = new Promise<Map<number, string>>((_, reject) => {
      rejectFirst = reject;
    });
    gate.catch(() => undefined);
    mockedWindow.mockImplementationOnce(() => ({
      done: gate,
      cancel: () => rejectFirst(new Error('cancelled')),
    }));
    const { result, unmount } = renderHook(() => usePageThumbs());
    let pending!: Promise<string[]>;
    act(() => {
      pending = result.current.load('doc-1', 10, 10);
    });
    expect(result.current.loading).toBe(true);
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await expect(pending).resolves.toEqual([]);
    });
    expect(result.current.loading).toBe(false);
    unmount();
  });
});
