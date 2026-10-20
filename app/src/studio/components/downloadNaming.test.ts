// @vitest-environment node
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

  it('strips bidirectional controls instead of passing them through', () => {
    expect(sanitizeFileName('a\u202Eb')).toBe('ab.pdf');
    expect(sanitizeFileName('a\u2066b')).toBe('ab.pdf');
    expect(sanitizeFileName('a\u2069b')).toBe('ab.pdf');
    expect(sanitizeFileName('a\u200Eb')).toBe('ab.pdf');
    expect(sanitizeFileName('a\u200Fb')).toBe('ab.pdf');
    expect(sanitizeFileName('evil\u202Efdp')).toBe('evilfdp.pdf');
    expect(sanitizeFileName('a\u202Db\u202Cc')).toBe('abc.pdf');
    // A name of only bidi controls falls back instead of returning empty.
    expect(sanitizeFileName('\u202E\u2066\u200E\u200F')).toBe(FALLBACK_PDF_NAME);
  });
  it('prefixes Windows reserved stems instead of emitting them verbatim', () => {
    expect(sanitizeFileName('con')).toBe('_con.pdf');
    expect(sanitizeFileName('con.pdf')).toBe('_con.pdf');
    expect(sanitizeFileName('COM1')).toBe('_COM1.pdf');
    expect(sanitizeFileName('nul.pdf')).toBe('_nul.pdf');
    expect(sanitizeFileName('lpt9')).toBe('_lpt9.pdf');
    expect(sanitizeFileName('aux')).toBe('_aux.pdf');
    // Non-exact stems are untouched.
    expect(sanitizeFileName('console')).toBe('console.pdf');
    expect(sanitizeFileName('con.txt')).toBe('con.txt.pdf');
    expect(sanitizeFileName('com10')).toBe('com10.pdf');
  });

  it('sanitizes the fallback instead of returning it verbatim', () => {
    expect(sanitizeFileName('', '../evil')).toBe('-evil.pdf');
    expect(sanitizeFileName('   ', 'con')).toBe('_con.pdf');
    expect(sanitizeFileName('', 'x'.repeat(200)).length).toBeLessThanOrEqual(120);
    // Empty/hostile fallbacks still terminate on the default.
    expect(sanitizeFileName('', '')).toBe(FALLBACK_PDF_NAME);
    expect(sanitizeFileName('', '   ')).toBe(FALLBACK_PDF_NAME);
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
