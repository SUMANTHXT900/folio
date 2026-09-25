import { describe, expect, it } from 'vitest';
import { containRect } from './scanViewport';

describe('containRect', () => {
  it('fits a portrait video in a landscape box (pillarbox math)', () => {
    const r = containRect({ w: 800, h: 400 }, 9 / 16);
    expect(r.h).toBeCloseTo(400, 6);
    expect(r.w).toBeCloseTo(225, 6);
    expect(r.x).toBeCloseTo((800 - 225) / 2, 6);
    expect(r.y).toBe(0);
  });

  it('fits a landscape video in a portrait box (letterbox math)', () => {
    const r = containRect({ w: 360, h: 600 }, 4 / 3);
    expect(r.w).toBeCloseTo(360, 6);
    expect(r.h).toBeCloseTo(270, 6);
    expect(r.x).toBe(0);
    expect(r.y).toBeCloseTo((600 - 270) / 2, 6);
  });

  it('fills exactly when ratios match (no bars possible)', () => {
    const r = containRect({ w: 300, h: 400 }, 3 / 4);
    expect(r).toEqual({ x: 0, y: 0, w: 300, h: 400 });
  });

  it('never returns NaN or negative sizes on degenerate input', () => {
    for (const bad of [
      containRect({ w: 0, h: 100 }, 1),
      containRect({ w: 100, h: 0 }, 1),
      containRect({ w: -5, h: 100 }, 1),
      containRect({ w: 100, h: 100 }, 0),
      containRect({ w: NaN, h: 100 }, 1),
      containRect({ w: 100, h: 100 }, Infinity),
    ]) {
      expect(Number.isFinite(bad.x)).toBe(true);
      expect(Number.isFinite(bad.y)).toBe(true);
      expect(bad.w).toBeGreaterThanOrEqual(0);
      expect(bad.h).toBeGreaterThanOrEqual(0);
    }
  });
});
