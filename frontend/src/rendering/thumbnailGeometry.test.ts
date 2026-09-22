/**
 * Thumbnail geometry unit tests: pure aspect-ratio math.
 *
 * No PDF.js, no DOM — verifies the Lesson 13 invariant (fit inside the
 * target box, preserve aspect ratio, never stretch/crop) for portrait,
 * landscape, square, and custom sizes.
 */
import { describe, expect, it } from 'vitest';
import { calculateThumbnailGeometry } from './thumbnailGeometry';

describe('calculateThumbnailGeometry', () => {
  it('fits a portrait page inside a square box', () => {
    // A4-ish portrait 595x842 into 200x200 → tall thumbnail.
    const geometry = calculateThumbnailGeometry(595, 842, 200, 200);
    expect(geometry.scale).toBeCloseTo(200 / 842, 10);
    expect(geometry.width).toBe(Math.floor(595 * geometry.scale));
    expect(geometry.height).toBe(200);
    expect(geometry.width).toBeLessThanOrEqual(200);
    expect(geometry.height).toBeLessThanOrEqual(200);
  });

  it('fits a landscape page inside a square box', () => {
    const geometry = calculateThumbnailGeometry(842, 595, 200, 200);
    expect(geometry.scale).toBeCloseTo(200 / 842, 10);
    expect(geometry.width).toBe(200);
    expect(geometry.height).toBe(Math.floor(595 * geometry.scale));
  });

  it('fills a square page exactly', () => {
    const geometry = calculateThumbnailGeometry(500, 500, 200, 200);
    expect(geometry.scale).toBeCloseTo(0.4, 10);
    expect(geometry.width).toBe(200);
    expect(geometry.height).toBe(200);
  });

  it('respects non-square target boxes', () => {
    const geometry = calculateThumbnailGeometry(200, 100, 100, 50);
    expect(geometry.scale).toBeCloseTo(0.5, 10);
    expect(geometry.width).toBe(100);
    expect(geometry.height).toBe(50);
  });

  it('preserves aspect ratio within rounding', () => {
    const srcW = 612;
    const srcH = 792;
    const geometry = calculateThumbnailGeometry(srcW, srcH, 200, 200);
    const srcRatio = srcW / srcH;
    const thumbRatio = geometry.width / geometry.height;
    expect(Math.abs(srcRatio - thumbRatio)).toBeLessThan(0.02);
  });

  it('never exceeds the target box', () => {
    const cases: Array<[number, number, number, number]> = [
      [595, 842, 200, 200],
      [842, 595, 200, 200],
      [100, 2000, 200, 200],
      [2000, 100, 200, 200],
      [612, 792, 141, 200],
      [100, 100, 1, 1],
    ];
    for (const [srcW, srcH, targetW, targetH] of cases) {
      const geometry = calculateThumbnailGeometry(srcW, srcH, targetW, targetH);
      expect(geometry.width).toBeLessThanOrEqual(targetW);
      expect(geometry.height).toBeLessThanOrEqual(targetH);
      expect(geometry.width).toBeGreaterThanOrEqual(1);
      expect(geometry.height).toBeGreaterThanOrEqual(1);
      expect(geometry.scale).toBeGreaterThan(0);
    }
  });

  it('rejects non-finite and non-positive inputs', () => {
    const bad: Array<[number, number, number, number]> = [
      [0, 100, 200, 200],
      [100, 0, 200, 200],
      [-5, 100, 200, 200],
      [100, 100, 0, 200],
      [Number.NaN, 100, 200, 200],
      [100, Number.POSITIVE_INFINITY, 200, 200],
    ];
    for (const [srcW, srcH, targetW, targetH] of bad) {
      expect(() => calculateThumbnailGeometry(srcW, srcH, targetW, targetH)).toThrow(RangeError);
    }
  });
});
