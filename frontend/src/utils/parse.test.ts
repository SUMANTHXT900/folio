import { describe, expect, it } from 'vitest';
import { parseAngle, parseMetadataDate, parsePageList, parseSplitParts } from './parse';

describe('parsePageList', () => {
  it('parses plain lists', () => {
    expect(parsePageList('1,3,5')).toEqual({ ok: true, pages: [1, 3, 5] });
  });

  it('preserves order verbatim', () => {
    expect(parsePageList('5,2,4')).toEqual({ ok: true, pages: [5, 2, 4] });
  });

  it('passes duplicates through for the engine to judge', () => {
    expect(parsePageList('2,2,5')).toEqual({ ok: true, pages: [2, 2, 5] });
  });

  it('treats empty input as an empty selection', () => {
    expect(parsePageList('')).toEqual({ ok: true, pages: [] });
    expect(parsePageList('   ')).toEqual({ ok: true, pages: [] });
  });

  it('passes boundary values through for the engine to judge', () => {
    expect(parsePageList('0')).toEqual({ ok: true, pages: [0] });
    expect(parsePageList('999999')).toEqual({ ok: true, pages: [999999] });
  });

  it('tolerates spaces and trailing commas', () => {
    expect(parsePageList(' 1 , 3 ,')).toEqual({ ok: true, pages: [1, 3] });
  });

  it('rejects non-integers and range syntax', () => {
    expect(parsePageList('abc').ok).toBe(false);
    expect(parsePageList('1,foo,3').ok).toBe(false);
    expect(parsePageList('1-3').ok).toBe(false);
    expect(parsePageList('1.5').ok).toBe(false);
  });
});

describe('parseAngle', () => {
  it('parses signed integers', () => {
    expect(parseAngle('90')).toEqual({ ok: true, angle: 90 });
    expect(parseAngle('-90')).toEqual({ ok: true, angle: -90 });
    expect(parseAngle(' 0 ')).toEqual({ ok: true, angle: 0 });
  });

  it('rejects non-integers', () => {
    expect(parseAngle('').ok).toBe(false);
    expect(parseAngle('ninety').ok).toBe(false);
    expect(parseAngle('45.5').ok).toBe(false);
  });
});

describe('parseSplitParts', () => {
  it('parses parts with optional names', () => {
    expect(parseSplitParts('1,2,3\n4,5:rest')).toEqual({
      ok: true,
      parts: [{ pages: [1, 2, 3] }, { pages: [4, 5], name: 'rest' }],
    });
  });

  it('skips blank lines', () => {
    const parsed = parseSplitParts('\n1,2\n\n3\n');
    expect(parsed).toEqual({
      ok: true,
      parts: [{ pages: [1, 2] }, { pages: [3] }],
    });
  });

  it('reports the failing line', () => {
    const parsed = parseSplitParts('1,2\nnope\n3');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain('line 2');
    }
  });
});

describe('parseMetadataDate', () => {
  it('parses a full date with a numeric offset', () => {
    const parsed = parseMetadataDate('2026-01-23 09:30:00 +0530');
    expect(parsed).toEqual({
      ok: true,
      date: { year: 2026, month: 1, day: 23, hour: 9, minute: 30, second: 0, tzOffsetMinutes: 330 },
    });
  });

  it('accepts Z for UTC and negative offsets', () => {
    expect(parseMetadataDate('2020-01-01 00:00:00 Z')).toMatchObject({
      ok: true,
      date: { tzOffsetMinutes: 0 },
    });
    expect(parseMetadataDate('2026-04-12 18:54:53 -0400')).toMatchObject({
      ok: true,
      date: { tzOffsetMinutes: -240 },
    });
  });

  it('rejects wrong shapes and out-of-range fields', () => {
    for (const bad of [
      '2026-01-23',
      '09:30:00',
      '2026-13-01 00:00:00 +0000',
      '2026-01-23 09:30:00',
      'not a date',
    ]) {
      const parsed = parseMetadataDate(bad);
      expect(parsed.ok).toBe(false);
    }
  });
});
