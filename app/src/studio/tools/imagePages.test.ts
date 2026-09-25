/**
 * Page-collection unit tests (pure logic — no DOM, no workers).
 *
 * Ordering correctness of the generated PDF is covered at the engine
 * level (`engine/tests/pdf_images_to_pdf.rs`,
 * `multiple_images_produce_multiple_pages_in_order`) and at the service
 * level by asserting the build loop stages pages in collection order;
 * the browser E2E exercises the full upload → reorder → build path.
 */
import { describe, expect, it } from 'vitest';
import {
  createPage,
  isImageFile,
  movePage,
  movePageTo,
  removePage,
  reorderPages,
  rotatePage,
  type ImagePage,
} from './imagePages';

function page(id: string, name = `${id}.jpg`): ImagePage {
  return createPage({
    id,
    source: 'upload',
    file: new File(['x'], name, { type: 'image/jpeg' }),
    name,
  });
}

function ids(pages: ImagePage[]): string[] {
  return pages.map((p) => p.id);
}

describe('createPage', () => {
  it('starts unrotated with handle metadata only', () => {
    const file = new File(['0123456789'], 'photo.jpg', { type: 'image/jpeg' });
    const p = createPage({ id: 'p1', source: 'camera', file, name: 'scan-001.jpg' });
    expect(p.id).toBe('p1');
    expect(p.source).toBe('camera');
    expect(p.file).toBe(file);
    expect(p.size).toBe(10);
    expect(p.rotationDeg).toBe(0);
    expect(p.previewUrl).toBe('');
  });
});

describe('movePage', () => {
  it('moves a page one step earlier or later', () => {
    const pages = ['a', 'b', 'c', 'd'].map((id) => page(id));
    expect(ids(movePage(pages, 'c', -1))).toEqual(['a', 'c', 'b', 'd']);
    expect(ids(movePage(pages, 'b', 1))).toEqual(['a', 'c', 'b', 'd']);
  });

  it('reorders A B C D to C A D B via successive moves', () => {
    let pages = ['a', 'b', 'c', 'd'].map((id) => page(id));
    pages = movePage(pages, 'c', -1);
    pages = movePage(pages, 'c', -1);
    pages = movePage(pages, 'd', -1);
    expect(ids(pages)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('clamps at the bounds and ignores unknown ids', () => {
    const pages = ['a', 'b'].map((id) => page(id));
    expect(ids(movePage(pages, 'a', -1))).toEqual(['a', 'b']);
    expect(ids(movePage(pages, 'b', 1))).toEqual(['a', 'b']);
    expect(movePage(pages, 'zzz', 1)).toBe(pages);
  });

  it('never mutates the input array', () => {
    const pages = ['a', 'b', 'c'].map((id) => page(id));
    const snapshot = ids(pages);
    movePage(pages, 'b', 1);
    expect(ids(pages)).toEqual(snapshot);
  });
});

describe('movePageTo', () => {
  it('moves a page to an absolute index with clamping', () => {
    const pages = ['a', 'b', 'c', 'd'].map((id) => page(id));
    expect(ids(movePageTo(pages, 'd', 0))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(movePageTo(pages, 'a', 99))).toEqual(['b', 'c', 'd', 'a']);
    expect(ids(movePageTo(pages, 'b', -5))).toEqual(['b', 'a', 'c', 'd']);
    expect(movePageTo(pages, 'zzz', 0)).toBe(pages);
    expect(movePageTo(pages, 'a', 0)).toBe(pages);
  });
});

describe('removePage', () => {
  it('removes exactly one page and keeps the rest in order', () => {
    const pages = ['a', 'b', 'c'].map((id) => page(id));
    expect(ids(removePage(pages, 'b'))).toEqual(['a', 'c']);
  });

  it('ignores unknown ids', () => {
    const pages = ['a'].map((id) => page(id));
    expect(removePage(pages, 'zzz')).toBe(pages);
  });
});

describe('rotatePage', () => {
  it('cycles 0 → 90 → 180 → 270 → 0', () => {
    let pages = [page('a')];
    for (const expected of [90, 180, 270, 0] as const) {
      pages = rotatePage(pages, 'a');
      expect(pages[0].rotationDeg).toBe(expected);
    }
  });

  it('leaves other pages untouched', () => {
    const pages = ['a', 'b'].map((id) => page(id));
    const next = rotatePage(pages, 'a');
    expect(next[0].rotationDeg).toBe(90);
    expect(next[1].rotationDeg).toBe(0);
  });
});

describe('combined sources', () => {
  it('holds uploads and captures in one ordered collection', () => {
    const upload = (id: string) => page(id);
    const capture = (id: string): ImagePage =>
      createPage({
        id,
        source: 'camera',
        file: new File(['y'], `${id}.jpg`, { type: 'image/jpeg' }),
        name: `${id}.jpg`,
      });
    // Upload A B, capture C D, add F, reorder to C A D B (F removed).
    let pages = [upload('a'), upload('b'), capture('c'), capture('d'), upload('f')];
    pages = removePage(pages, 'f');
    pages = movePage(pages, 'c', -1);
    pages = movePage(pages, 'c', -1);
    pages = movePage(pages, 'd', -1);
    expect(ids(pages)).toEqual(['c', 'a', 'd', 'b']);
    expect(pages.map((p) => p.source)).toEqual(['camera', 'upload', 'camera', 'upload']);
  });
});

describe('isImageFile', () => {
  it('accepts JPEG/PNG by MIME or extension', () => {
    expect(isImageFile({ type: 'image/jpeg', name: 'a.jpg' })).toBe(true);
    expect(isImageFile({ type: 'image/png', name: 'b.png' })).toBe(true);
    expect(isImageFile({ type: '', name: 'c.jpeg' })).toBe(true);
    expect(isImageFile({ type: 'image/gif', name: 'd.gif' })).toBe(false);
    expect(isImageFile({ type: 'application/pdf', name: 'e.pdf' })).toBe(false);
  });
});

describe('reorderPages', () => {
  const pages = () => [page('a'), page('b'), page('c'), page('d')];

  it('applies a full id order (Reorder.Group result)', () => {
    expect(ids(reorderPages(pages(), ['c', 'a', 'd', 'b']))).toEqual(['c', 'a', 'd', 'b']);
  });

  it('ignores unknown ids and appends missing pages in place', () => {
    expect(ids(reorderPages(pages(), ['c', 'zzz', 'a']))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('never mutates the input', () => {
    const before = pages();
    reorderPages(before, ['d', 'c', 'b', 'a']);
    expect(ids(before)).toEqual(['a', 'b', 'c', 'd']);
  });
});
