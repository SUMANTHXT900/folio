// @vitest-environment node
/**
 * imageCount plumbing regression tests (production audit §6).
 *
 * The Rust/WASM `pdf.images_to_pdf` summary carries both `page_count`
 * and `image_count`; the adapter must preserve both so the Studio UI
 * can display `N images → N-page PDF`.
 */
import { describe, expect, it } from 'vitest';
import { errorData, translateSummary } from './engineResult';

describe('translateSummary images_to_pdf', () => {
  it('preserves imageCount alongside pageCount', () => {
    const summary = translateSummary('pdf.images_to_pdf', {
      page_count: 3,
      image_count: 3,
    });
    expect(summary).toEqual({ pageCount: 3, imageCount: 3 });
  });

  it('tolerates summaries without image_count (older envelopes)', () => {
    const summary = translateSummary('pdf.images_to_pdf', { page_count: 2 });
    expect(summary).toEqual({ pageCount: 2 });
  });

  it('keeps merge counts intact', () => {
    const summary = translateSummary('pdf.merge', {
      input_document_count: 3,
      input_page_count: 142,
      output_page_count: 142,
    });
    expect(summary).toEqual({
      inputDocumentCount: 3,
      inputPageCount: 142,
      outputPageCount: 142,
    });
  });

  it('keeps delete in/out counts intact', () => {
    const summary = translateSummary('pdf.delete_pages', {
      page_count: 8,
      input_page_count: 10,
      output_page_count: 8,
    });
    expect(summary).toEqual({ pageCount: 8, inputPageCount: 10, outputPageCount: 8 });
  });
});

describe('translateSummary guards (AUD-2)', () => {
  it('throws on a mismatched wire shape instead of returning undefined pageCount', () => {
    expect(() =>
      translateSummary(
        'pdf.extract_pages',
        // Missing page_count — previously cast blindly to { pageCount: undefined }.
        {} as unknown as { page_count: number },
      ),
    ).toThrow();
  });

  it('throws on malformed merge/split summaries', () => {
    expect(() =>
      translateSummary('pdf.merge', { input_page_count: 5, output_page_count: 5 } as never),
    ).toThrow();
    expect(() =>
      translateSummary('pdf.split', { input_page_count: 5, parts: [{ name: null }] } as never),
    ).toThrow();
  });

  it('throws on malformed inspect summary', () => {
    expect(() => translateSummary('pdf.inspect', { page_count: 1 } as never)).toThrow();
  });
});

describe('errorData code validation (AUD-2)', () => {
  it('maps an unknown wire code to INTERNAL and keeps the raw message', () => {
    const err = errorData('BOGUS_CODE', 'boom');
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toBe('boom');
    expect(err.details ?? '').toContain('BOGUS_CODE');
  });

  it('passes known codes through unchanged', () => {
    expect(errorData('IO_ERROR', 'disk gone')).toEqual({
      code: 'IO_ERROR',
      message: 'disk gone',
    });
  });
});
