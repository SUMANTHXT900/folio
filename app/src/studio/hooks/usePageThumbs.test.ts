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
