// @vitest-environment node
/**
 * Protocol validation tests: corner shape/finiteness/geometry checks and the
 * detector-kind guard. A collapsed or non-finite quad must never reach the
 * worker (the client rejects it before any buffer transfer).
 */
import { describe, expect, it } from 'vitest';
import {
  SCANIC_CORNER_KEYS,
  isScanicDetectorKind,
  isValidScanicCorners,
  validateScanicCorners,
  type ScanicCorners,
} from './scanicProtocol';

function corners(overrides: Partial<ScanicCorners> = {}): ScanicCorners {
  return {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 100, y: 0 },
    bottomRight: { x: 100, y: 80 },
    bottomLeft: { x: 0, y: 80 },
    ...overrides,
  };
}

describe('validateScanicCorners', () => {
  it('accepts a finite, well-separated quad and exposes every corner key', () => {
    expect(validateScanicCorners(corners())).toBeNull();
    expect(isValidScanicCorners(corners())).toBe(true);
    expect(SCANIC_CORNER_KEYS).toEqual(['topLeft', 'topRight', 'bottomRight', 'bottomLeft']);
  });

  it('rejects non-objects and missing corners', () => {
    expect(validateScanicCorners(null)).not.toBeNull();
    expect(validateScanicCorners(42)).not.toBeNull();
    expect(validateScanicCorners({ topLeft: { x: 0, y: 0 } })).not.toBeNull();
    expect(
      validateScanicCorners({
        ...corners(),
        bottomLeft: undefined,
      }),
    ).not.toBeNull();
  });

  it('rejects non-finite coordinates', () => {
    expect(validateScanicCorners(corners({ topLeft: { x: Number.NaN, y: 0 } }))).not.toBeNull();
    expect(
      validateScanicCorners(corners({ topRight: { x: Number.POSITIVE_INFINITY, y: 0 } })),
    ).not.toBeNull();
    expect(
      validateScanicCorners(corners({ bottomRight: { x: 100, y: Number.NEGATIVE_INFINITY } })),
    ).not.toBeNull();
    expect(
      validateScanicCorners(corners({ bottomLeft: { x: '0' as unknown as number, y: 80 } })),
    ).not.toBeNull();
  });

  it('rejects collapsed quads (duplicate corners)', () => {
    const collapsed = corners({ topRight: { x: 0, y: 0 } });
    expect(isValidScanicCorners(collapsed)).toBe(false);
    expect(validateScanicCorners(collapsed)).toMatch(/collapses/);
  });

  it('rejects zero-area quads (all corners on one line)', () => {
    const line = corners({
      topRight: { x: 50, y: 0 },
      bottomRight: { x: 100, y: 0 },
      bottomLeft: { x: 50, y: 0 },
    });
    expect(isValidScanicCorners(line)).toBe(false);
    expect(validateScanicCorners(line)).toMatch(/no area|collapses/);
  });

  it('accepts a rotated (non-axis-aligned) document quad', () => {
    const rotated = corners({
      topLeft: { x: 50, y: 0 },
      topRight: { x: 100, y: 50 },
      bottomRight: { x: 50, y: 100 },
      bottomLeft: { x: 0, y: 50 },
    });
    expect(validateScanicCorners(rotated)).toBeNull();
  });
});

describe('isScanicDetectorKind', () => {
  it('accepts exactly classical and ml', () => {
    expect(isScanicDetectorKind('classical')).toBe(true);
    expect(isScanicDetectorKind('ml')).toBe(true);
    expect(isScanicDetectorKind('cnn')).toBe(false);
    expect(isScanicDetectorKind(undefined)).toBe(false);
    expect(isScanicDetectorKind(null)).toBe(false);
  });
});
