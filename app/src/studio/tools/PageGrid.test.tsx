/**
 * Healed-row resync tests (`usePreviewSrc` in `PageGrid.tsx`).
 *
 * Rows heal a dead blob URL by re-materializing it from the retained File
 * handle; when the canonical URL later changes (rotation re-import, thumb
 * arrival) the row must adopt the new URL and revoke the healed one —
 * never stick on a stale heal.
 */
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PageGrid } from './PageGrid';
import { createPage } from './imagePages';

let counter = 0;
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  counter = 100;
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
  cleanup();
  vi.restoreAllMocks();
});

function pageWith(previewUrl: string, name = 'a.jpg') {
  return {
    ...createPage({
      id: 'p1',
      source: 'upload' as const,
      file: new File(['img'], name, { type: 'image/jpeg' }),
      name,
    }),
    previewUrl,
    thumbUrl: '',
  };
}

describe('PageGrid healed-row resync', () => {
  it('adopts the new canonical URL post-heal and revokes the healed URL', () => {
    const noop = () => undefined;
    const { rerender } = render(
      <PageGrid
        pages={[pageWith('blob:old')]}
        onMove={noop}
        onReorder={noop}
        onRemove={noop}
        onRotate={noop}
      />,
    );
    const img = screen.getByAltText(/Page 1 preview/) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:old');
    // Kill the preview: the row heals from the File handle.
    act(() => {
      fireEvent.error(img);
    });
    const healedSrc = (screen.getByAltText(/Page 1 preview/) as HTMLImageElement).getAttribute(
      'src',
    );
    expect(healedSrc).toMatch(/^blob:mock-/);
    expect(healedSrc).not.toBe('blob:old');
    // Canonical changes (rotation re-import mints a fresh URL): the row
    // must adopt it and revoke the heal.
    rerender(
      <PageGrid
        pages={[pageWith('blob:new')]}
        onMove={noop}
        onReorder={noop}
        onRemove={noop}
        onRotate={noop}
      />,
    );
    expect((screen.getByAltText(/Page 1 preview/) as HTMLImageElement).getAttribute('src')).toBe(
      'blob:new',
    );
    expect(revoked).toContain(healedSrc);
  });

  it('keeps the heal when the canonical URL has not changed', () => {
    const noop = () => undefined;
    const { rerender } = render(
      <PageGrid
        pages={[pageWith('blob:old')]}
        onMove={noop}
        onReorder={noop}
        onRemove={noop}
        onRotate={noop}
      />,
    );
    const img = screen.getByAltText(/Page 1 preview/) as HTMLImageElement;
    act(() => {
      fireEvent.error(img);
    });
    const healedSrc = (screen.getByAltText(/Page 1 preview/) as HTMLImageElement).getAttribute(
      'src',
    );
    rerender(
      <PageGrid
        pages={[pageWith('blob:old')]}
        onMove={noop}
        onReorder={noop}
        onRemove={noop}
        onRotate={noop}
      />,
    );
    // No canonical change → the heal sticks, nothing revoked.
    expect((screen.getByAltText(/Page 1 preview/) as HTMLImageElement).getAttribute('src')).toBe(
      healedSrc,
    );
    expect(revoked).not.toContain(healedSrc);
  });
});
