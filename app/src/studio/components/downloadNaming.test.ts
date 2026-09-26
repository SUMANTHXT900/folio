import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PDF_NAME,
  sanitizeFileName,
  smartOutputName,
  smartSplitPartName,
  stripAnyExt,
  stripPdfExt,
} from './downloadNaming';

describe('stripPdfExt', () => {
  it('strips .pdf case-insensitively, leaves other extensions', () => {
    expect(stripPdfExt('report.pdf')).toBe('report');
    expect(stripPdfExt('report.PDF')).toBe('report');
    expect(stripPdfExt('scan-001.jpg')).toBe('scan-001.jpg');
    expect(stripPdfExt('noext')).toBe('noext');
  });
});

describe('stripAnyExt', () => {
  it('strips the last extension for page names', () => {
    expect(stripAnyExt('scan-001.jpg')).toBe('scan-001');
    expect(stripAnyExt('red-wide.png')).toBe('red-wide');
    expect(stripAnyExt('report.pdf')).toBe('report');
    expect(stripAnyExt('noext')).toBe('noext');
  });
});

describe('sanitizeFileName', () => {
  it('appends .pdf when missing and keeps an existing suffix singular', () => {
    expect(sanitizeFileName('my-doc')).toBe('my-doc.pdf');
    expect(sanitizeFileName('my-doc.pdf')).toBe('my-doc.pdf');
    expect(sanitizeFileName('my-doc.PDF')).toBe('my-doc.pdf');
  });

  it('replaces filesystem-illegal characters and trims dot/space edges', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j.pdf');
    expect(sanitizeFileName('  ...lead.pdf')).toBe('lead.pdf');
    expect(sanitizeFileName('trail...   ')).toBe('trail.pdf');
  });

  it('falls back for empty input and caps total length', () => {
    expect(sanitizeFileName('   ')).toBe(FALLBACK_PDF_NAME);
    expect(sanitizeFileName('', 'merged.pdf')).toBe('merged.pdf');
    expect(sanitizeFileName('x'.repeat(200)).length).toBeLessThanOrEqual(120);
    expect(sanitizeFileName('x'.repeat(200))).toMatch(/\.pdf$/);
  });
});

describe('smartOutputName', () => {
  it('merge combines input basenames, plus-N beyond two', () => {
    expect(smartOutputName('merge', ['a.pdf', 'b.pdf'])).toBe('a-b-merged.pdf');
    expect(smartOutputName('merge', ['report.pdf', 'b.pdf', 'c.pdf'])).toBe(
      'report-plus2-merged.pdf',
    );
  });

  it('single-input ops suffix the input basename', () => {
    expect(smartOutputName('rearrange', ['report.pdf'])).toBe('report-rearranged.pdf');
    expect(smartOutputName('rotate', ['report.pdf'])).toBe('report-rotated.pdf');
    expect(smartOutputName('metadata', ['report.pdf'])).toBe('report-metadata.pdf');
  });

  it('images uses page names: single page keeps its base, batches get plus-N', () => {
    expect(smartOutputName('images', ['cover.png'])).toBe('cover.pdf');
    expect(smartOutputName('images', ['scan-001.jpg', 'scan-002.jpg', 'pic.png'])).toBe(
      'scan-001-plus2-pages.pdf',
    );
  });

  it('sanitizes hostile input names instead of passing them through', () => {
    expect(smartOutputName('rotate', ['../weird:name?.pdf'])).toBe('-weird-name--rotated.pdf');
  });
});

describe('smartSplitPartName', () => {
  it('keeps the -p<a>-<b> convention', () => {
    expect(smartSplitPartName('report.pdf', 3, 7)).toBe('report-p3-7.pdf');
    expect(smartSplitPartName('report.pdf', 1, 1)).toBe('report-p1-1.pdf');
  });
});
