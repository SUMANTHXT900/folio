/**
 * Rendering-layer unit tests: pure validation/error-mapping logic.
 *
 * These run in jsdom without the PDF.js runtime (errors.ts imports
 * nothing browser- or pdf.js-specific). Real PDF.js behavior — document
 * loading, canvas rendering, workers — is covered by headless-Chrome E2E
 * (Lesson 12 acceptance), not here.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_RENDER_SCALE,
  RenderError,
  isPdfJsCancel,
  isRenderError,
  normalizeRotation,
  normalizeScale,
  toLoadError,
  toRenderError,
  validatePageNumber,
} from './errors';

describe('normalizeScale', () => {
  it('defaults to 1', () => {
    expect(normalizeScale(undefined)).toBe(1);
  });

  it('accepts typical scales', () => {
    expect(normalizeScale(1)).toBe(1);
    expect(normalizeScale(1.5)).toBe(1.5);
    expect(normalizeScale(2)).toBe(2);
  });

  it('rejects non-positive, non-finite, and excessive scales', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_RENDER_SCALE + 1]) {
      try {
        normalizeScale(bad);
        expect.unreachable(`scale ${String(bad)} must throw`);
      } catch (error) {
        expect(isRenderError(error)).toBe(true);
        expect((error as RenderError).code).toBe('RENDER_INVALID_INPUT');
      }
    }
  });
});

describe('normalizeRotation', () => {
  it('passes through undefined (intrinsic rotation)', () => {
    expect(normalizeRotation(undefined)).toBeUndefined();
  });

  it('normalizes quarter turns into 0–359', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(270)).toBe(270);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
  });

  it('rejects non-quarter-turn values', () => {
    for (const bad of [45, 30, 1.5, Number.NaN]) {
      try {
        normalizeRotation(bad);
        expect.unreachable(`rotation ${String(bad)} must throw`);
      } catch (error) {
        expect((error as RenderError).code).toBe('RENDER_INVALID_INPUT');
      }
    }
  });
});

describe('validatePageNumber', () => {
  it('accepts the 1-based range', () => {
    expect(() => validatePageNumber(1, 5)).not.toThrow();
    expect(() => validatePageNumber(5, 5)).not.toThrow();
  });

  it('rejects 0, negatives, fractions, and overruns without touching PDF.js', () => {
    for (const bad of [0, -1, 1.5, 6, 999]) {
      try {
        validatePageNumber(bad, 5);
        expect.unreachable(`page ${String(bad)} must throw`);
      } catch (error) {
        expect(isRenderError(error)).toBe(true);
        expect((error as RenderError).code).toBe('RENDER_INVALID_PAGE');
        expect((error as RenderError).details).toContain('page_count=5');
      }
    }
  });
});

describe('RenderError', () => {
  it('carries code, message, and context', () => {
    const error = new RenderError('RENDER_INVALID_PAGE', 'bad page', {
      details: 'page=0 page_count=5',
      documentId: 'renderdoc-1',
      pageNumber: 0,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RenderError');
    expect(error.code).toBe('RENDER_INVALID_PAGE');
    expect(error.documentId).toBe('renderdoc-1');
    expect(error.pageNumber).toBe(0);
  });

  it('isRenderError distinguishes structured failures', () => {
    expect(isRenderError(new RenderError('RENDER_INTERNAL', 'x'))).toBe(true);
    expect(isRenderError(new Error('x'))).toBe(false);
    expect(isRenderError(null)).toBe(false);
    expect(isRenderError('RENDER_CANCELLED')).toBe(false);
  });
});

describe('PDF.js cancellation detection', () => {
  it('recognizes RenderingCancelledException by name only', () => {
    expect(isPdfJsCancel({ name: 'RenderingCancelledException' })).toBe(true);
    expect(isPdfJsCancel({ name: 'AbortException' })).toBe(false);
    expect(isPdfJsCancel(new Error('boom'))).toBe(false);
    expect(isPdfJsCancel(null)).toBe(false);
  });

  it('maps cancellation to RENDER_CANCELLED, never a failure', () => {
    const cancelled = { name: 'RenderingCancelledException', message: 'cancelled' };
    expect(toRenderError(cancelled, { documentId: 'd', pageNumber: 2 }).code).toBe(
      'RENDER_CANCELLED',
    );
    expect(toLoadError(cancelled, { documentId: 'd' }).code).toBe('RENDER_CANCELLED');
  });

  it('maps other failures to structured page/document errors', () => {
    const renderError = toRenderError(new Error('boom'), { documentId: 'd', pageNumber: 3 });
    expect(renderError.code).toBe('RENDER_PAGE_FAILED');
    expect(renderError.details).toContain('boom');
    expect(renderError.pageNumber).toBe(3);

    const loadError = toLoadError('not a pdf at all', { documentId: 'd' });
    expect(loadError.code).toBe('RENDER_DOCUMENT_FAILED');
    expect(loadError.details).toContain('not a pdf');
  });

  it('passes RenderError through unchanged', () => {
    const original = new RenderError('RENDER_CLOSED', 'gone');
    expect(toRenderError(original)).toBe(original);
    expect(toLoadError(original)).toBe(original);
  });
});
