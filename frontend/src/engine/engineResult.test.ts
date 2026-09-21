/**
 * imageCount plumbing regression tests (production audit §6).
 *
 * The Rust/WASM `pdf.images_to_pdf` summary carries both `page_count`
 * and `image_count`; the adapter must preserve both so the Studio UI
 * can display `N images → N-page PDF`.
 */
import { describe, expect, it } from 'vitest';
import { translateSummary } from './engineResult';

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
