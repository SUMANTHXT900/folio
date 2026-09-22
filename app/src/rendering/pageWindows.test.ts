/**
 * Windowed page-processing unit tests (Lesson 14).
 *
 * Pure math over page numbers: exact windows, remainders, single-page
 * documents, and rejection of non-integer/out-of-range inputs. No DOM,
 * no PDF.js, no rendering.
 */
import { describe, expect, it } from 'vitest';
import { MAX_WINDOW_SIZE, pageWindows } from './pageWindows';

describe('pageWindows', () => {
  it('splits evenly with no remainder', () => {
    expect(pageWindows(40, 20)).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
    ]);
  });

  it('puts the remainder in the last window', () => {
    expect(pageWindows(39, 20)).toEqual([
      Array.from({ length: 20 }, (_, i) => i + 1),
      Array.from({ length: 19 }, (_, i) => i + 21),
    ]);
  });

  it('handles single-page documents and oversized windows', () => {
    expect(pageWindows(1, 20)).toEqual([[1]]);
    expect(pageWindows(5, 500)).toEqual([[1, 2, 3, 4, 5]]);
  });

  it('covers every page exactly once for a large document', () => {
    const windows = pageWindows(2585, 500);
    expect(windows).toHaveLength(6);
    expect(windows[5]).toHaveLength(85);
    const flat = windows.flat();
    expect(flat).toHaveLength(2585);
    expect(flat[0]).toBe(1);
    expect(flat[2584]).toBe(2585);
    expect(new Set(flat).size).toBe(2585);
  });

  it('returns no windows for zero pages', () => {
    expect(pageWindows(0, 20)).toEqual([]);
  });

  it('rejects non-integer and out-of-range inputs', () => {
    expect(() => pageWindows(-1, 20)).toThrow(RangeError);
    expect(() => pageWindows(1.5, 20)).toThrow(RangeError);
    expect(() => pageWindows(10, 0)).toThrow(RangeError);
    expect(() => pageWindows(10, 1.5)).toThrow(RangeError);
    expect(() => pageWindows(10, MAX_WINDOW_SIZE + 1)).toThrow(RangeError);
  });
});
