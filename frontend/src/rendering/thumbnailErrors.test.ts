/**
 * Thumbnail error-model unit tests: validation + RenderError wrapping.
 *
 * jsdom-safe (thumbnailErrors.ts imports only the rendering error class,
 * never the PDF.js runtime). Real render failures are covered by the mock
 * engine tests and headless-Chrome E2E.
 */
import { describe, expect, it } from 'vitest';
import { RenderError } from './errors';
import {
  DEFAULT_THUMBNAIL_CONCURRENCY,
  isThumbnailError,
  MAX_THUMBNAIL_CONCURRENCY,
  MAX_THUMBNAIL_EDGE,
  normalizeThumbnailConcurrency,
  normalizeThumbnailSize,
  ThumbnailError,
  toThumbnailError,
  validateThumbnailPage,
} from './thumbnailErrors';

describe('normalizeThumbnailSize', () => {
  it('defaults to 200x200', () => {
    expect(normalizeThumbnailSize(undefined)).toEqual({ width: 200, height: 200 });
  });

  it('accepts typical boxes', () => {
    expect(normalizeThumbnailSize({ width: 200, height: 200 })).toEqual({
      width: 200,
      height: 200,
    });
    expect(normalizeThumbnailSize({ width: 141, height: 200 })).toEqual({
      width: 141,
      height: 200,
    });
  });

  it('rejects non-positive, non-finite, and oversized boxes', () => {
    const bad: Array<{ width: number; height: number }> = [
      { width: 0, height: 200 },
      { width: -1, height: 200 },
      { width: 200, height: 0 },
      { width: Number.NaN, height: 200 },
      { width: Number.POSITIVE_INFINITY, height: 200 },
      { width: MAX_THUMBNAIL_EDGE + 1, height: 200 },
      { width: 200, height: MAX_THUMBNAIL_EDGE + 1 },
    ];
    for (const size of bad) {
      try {
        normalizeThumbnailSize(size);
        expect.unreachable(`size ${size.width}x${size.height} must throw`);
      } catch (error) {
        expect(isThumbnailError(error)).toBe(true);
        expect((error as ThumbnailError).code).toBe('THUMBNAIL_INVALID_INPUT');
      }
    }
  });
});

describe('normalizeThumbnailConcurrency', () => {
  it('defaults to the safe baseline', () => {
    expect(normalizeThumbnailConcurrency(undefined)).toBe(DEFAULT_THUMBNAIL_CONCURRENCY);
    expect(DEFAULT_THUMBNAIL_CONCURRENCY).toBe(2);
  });

  it('accepts the bounded range', () => {
    expect(normalizeThumbnailConcurrency(1)).toBe(1);
    expect(normalizeThumbnailConcurrency(3)).toBe(3);
    expect(normalizeThumbnailConcurrency(MAX_THUMBNAIL_CONCURRENCY)).toBe(
      MAX_THUMBNAIL_CONCURRENCY,
    );
  });

  it('rejects zero, negatives, fractions, and overruns', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, MAX_THUMBNAIL_CONCURRENCY + 1]) {
      try {
        normalizeThumbnailConcurrency(bad);
        expect.unreachable(`concurrency ${String(bad)} must throw`);
      } catch (error) {
        expect((error as ThumbnailError).code).toBe('THUMBNAIL_INVALID_INPUT');
      }
    }
  });
});

describe('validateThumbnailPage', () => {
  it('accepts the 1-based range', () => {
    expect(() => validateThumbnailPage(1, 5, 'doc-1')).not.toThrow();
    expect(() => validateThumbnailPage(5, 5, 'doc-1')).not.toThrow();
  });

  it('rejects 0, negatives, fractions, and overruns with page attribution', () => {
    for (const bad of [0, -1, 1.5, 6, 999]) {
      try {
        validateThumbnailPage(bad, 5, 'doc-1');
        expect.unreachable(`page ${String(bad)} must throw`);
      } catch (error) {
        expect(isThumbnailError(error)).toBe(true);
        const thumb = error as ThumbnailError;
        expect(thumb.code).toBe('THUMBNAIL_INVALID_PAGE');
        expect(thumb.details).toContain('page_count=5');
        expect(thumb.documentId).toBe('doc-1');
      }
    }
  });
});

describe('ThumbnailError', () => {
  it('carries code, message, and page context', () => {
    const error = new ThumbnailError('THUMBNAIL_INVALID_PAGE', 'bad page', {
      details: 'page=0 page_count=5',
      documentId: 'renderdoc-1',
      pageNumber: 0,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ThumbnailError');
    expect(error.code).toBe('THUMBNAIL_INVALID_PAGE');
    expect(error.documentId).toBe('renderdoc-1');
    expect(error.pageNumber).toBe(0);
  });

  it('isThumbnailError distinguishes structured failures', () => {
    expect(isThumbnailError(new ThumbnailError('THUMBNAIL_INTERNAL', 'x'))).toBe(true);
    expect(isThumbnailError(new RenderError('RENDER_INTERNAL', 'x'))).toBe(false);
    expect(isThumbnailError(new Error('x'))).toBe(false);
    expect(isThumbnailError(null)).toBe(false);
  });
});

describe('toThumbnailError mapping', () => {
  it('passes ThumbnailError through unchanged', () => {
    const original = new ThumbnailError('THUMBNAIL_CANCELLED', 'cancelled');
    expect(toThumbnailError(original)).toBe(original);
  });

  it('maps RENDER_CANCELLED to THUMBNAIL_CANCELLED', () => {
    const mapped = toThumbnailError(
      new RenderError('RENDER_CANCELLED', 'cancelled', { documentId: 'd', pageNumber: 2 }),
      { documentId: 'd', pageNumber: 2 },
    );
    expect(mapped.code).toBe('THUMBNAIL_CANCELLED');
    expect(mapped.pageNumber).toBe(2);
  });

  it('maps RENDER_INVALID_PAGE to THUMBNAIL_INVALID_PAGE', () => {
    const mapped = toThumbnailError(
      new RenderError('RENDER_INVALID_PAGE', 'bad page', { documentId: 'd', pageNumber: 0 }),
      { documentId: 'd', pageNumber: 0 },
    );
    expect(mapped.code).toBe('THUMBNAIL_INVALID_PAGE');
  });

  it('maps RENDER_CLOSED to THUMBNAIL_CLOSED', () => {
    const mapped = toThumbnailError(new RenderError('RENDER_CLOSED', 'gone', { documentId: 'd' }), {
      documentId: 'd',
    });
    expect(mapped.code).toBe('THUMBNAIL_CLOSED');
  });

  it('maps other RenderErrors and generic failures to THUMBNAIL_RENDER_FAILED', () => {
    const renderFailed = toThumbnailError(
      new RenderError('RENDER_PAGE_FAILED', 'boom', { documentId: 'd', pageNumber: 3 }),
      { documentId: 'd', pageNumber: 3 },
    );
    expect(renderFailed.code).toBe('THUMBNAIL_RENDER_FAILED');
    expect(renderFailed.pageNumber).toBe(3);
    expect(renderFailed.cause).toBeInstanceOf(RenderError);

    const generic = toThumbnailError(new Error('boom'), { documentId: 'd', pageNumber: 4 });
    expect(generic.code).toBe('THUMBNAIL_RENDER_FAILED');
    expect(generic.details).toContain('boom');
  });

  it('maps cancelledHint to THUMBNAIL_CANCELLED', () => {
    const mapped = toThumbnailError(new Error('interrupted'), { documentId: 'd' }, true);
    expect(mapped.code).toBe('THUMBNAIL_CANCELLED');
  });
});
