/**
 * Memory-diagnostics unit tests (Lesson 14).
 *
 * The real `performance.memory` is Chromium-only and absent under jsdom,
 * so these tests assert the degrade-to-unsupported path plus the pure
 * formatting helper. Real heap readings are covered by headless-Chrome
 * E2E (`e2e/large-files.e2e.mjs`), never asserted here.
 */
import { describe, expect, it } from 'vitest';
import { formatMB, readMemorySnapshot } from './memory';

describe('formatMB', () => {
  it('formats finite values with one decimal', () => {
    expect(formatMB(1817.65)).toBe('1817.7 MB');
    expect(formatMB(0)).toBe('0.0 MB');
  });

  it('degrades nullish and non-finite inputs to n/a', () => {
    expect(formatMB(null)).toBe('n/a');
    expect(formatMB(undefined)).toBe('n/a');
    expect(formatMB(Number.NaN)).toBe('n/a');
    expect(formatMB(Number.POSITIVE_INFINITY)).toBe('n/a');
  });
});

describe('readMemorySnapshot', () => {
  it('reports unsupported when performance.memory is absent', () => {
    // jsdom ships no performance.memory: the helper must degrade, never throw.
    const snapshot = readMemorySnapshot();
    expect(snapshot.supported).toBe(false);
    expect(snapshot.usedJSHeapMB).toBeNull();
    expect(snapshot.totalJSHeapMB).toBeNull();
    expect(snapshot.heapLimitMB).toBeNull();
  });
});
