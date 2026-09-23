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
import { useImagePages } from './useImagePages';

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
});
