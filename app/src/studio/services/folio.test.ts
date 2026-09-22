/**
 * Studio service unit tests (pure parts only).
 *
 * `toStudioError` and `studioStripExt` touch no engines, workers, or
 * DOM — safe for jsdom. Engine-backed behavior (open/run/thumbs) is
 * covered by the production browser E2E (`e2e/studio.e2e.mjs`), never
 * mocked here.
 */
import { describe, expect, it } from 'vitest';
import { formatDurationMs, studioStripExt, toStudioError } from './folio';

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
