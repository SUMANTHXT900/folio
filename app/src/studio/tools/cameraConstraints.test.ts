/**
 * Constraint-construction tests: ideals everywhere, exact nowhere
 * except an explicitly chosen device id.
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  LOW_TIER_HEIGHT,
  LOW_TIER_WIDTH,
  PREFERRED_FRAMERATE,
  PREFERRED_HEIGHT,
  PREFERRED_WIDTH,
  buildVideoConstraints,
  prefersLowTierCapture,
} from './cameraConstraints';

function mockDeviceMemory(value: unknown) {
  Object.defineProperty(navigator, 'deviceMemory', { value, configurable: true });
}

afterEach(() => {
  // Restore the unknown-deviceMemory default (current behavior).
  const record = navigator as unknown as Record<string, unknown>;
  if ('deviceMemory' in navigator) delete record['deviceMemory'];
});

describe('buildVideoConstraints', () => {
  it('requests preferred resolution as ideals with facing mode', () => {
    expect(buildVideoConstraints({ facing: 'environment', deviceId: '' })).toEqual({
      facingMode: { ideal: 'environment' },
      width: { ideal: PREFERRED_WIDTH },
      height: { ideal: PREFERRED_HEIGHT },
      frameRate: { ideal: PREFERRED_FRAMERATE },
    });
  });

  it('keeps user facing mode intact', () => {
    const c = buildVideoConstraints({ facing: 'user', deviceId: '' });
    expect(c).toMatchObject({ facingMode: { ideal: 'user' } });
  });

  it('uses exact only for an explicitly chosen device, ideals besides', () => {
    const c = buildVideoConstraints({ facing: 'environment', deviceId: 'd2' });
    expect(c).toMatchObject({
      deviceId: { exact: 'd2' },
      width: { ideal: PREFERRED_WIDTH },
      height: { ideal: PREFERRED_HEIGHT },
    });
    expect(c).not.toHaveProperty('facingMode');
  });

  it('keeps everything preference-only except an explicit device choice', () => {
    for (const c of [
      buildVideoConstraints({ facing: 'environment', deviceId: '' }),
      buildVideoConstraints({ facing: 'user', deviceId: 'abc' }),
    ]) {
      const flat = JSON.stringify(c);
      // No mandatory ranges anywhere: weak cameras fall back, never fail.
      expect(flat).not.toContain('"min"');
      // The only exact allowed is an explicitly chosen deviceId.
      const withoutDeviceExact = flat.replace(/"deviceId":\{"exact":"[^"]*"\}/, '');
      expect(withoutDeviceExact).not.toContain('"exact"');
    }
  });
});

describe('prefersLowTierCapture', () => {
  it('is false when deviceMemory is unknown (current behavior)', () => {
    expect(prefersLowTierCapture()).toBe(false);
  });

  it('is true at or below 4 GB', () => {
    mockDeviceMemory(4);
    expect(prefersLowTierCapture()).toBe(true);
    mockDeviceMemory(2);
    expect(prefersLowTierCapture()).toBe(true);
  });

  it('is false above 4 GB or for non-numeric values', () => {
    mockDeviceMemory(8);
    expect(prefersLowTierCapture()).toBe(false);
    mockDeviceMemory('4');
    expect(prefersLowTierCapture()).toBe(false);
    mockDeviceMemory(Number.NaN);
    expect(prefersLowTierCapture()).toBe(false);
  });
});

describe('buildVideoConstraints low-tier preference', () => {
  it('prefers 720p ideals on low-memory devices, still preference-only', () => {
    mockDeviceMemory(2);
    const c = buildVideoConstraints({ facing: 'environment', deviceId: '' });
    expect(c).toMatchObject({
      facingMode: { ideal: 'environment' },
      width: { ideal: LOW_TIER_WIDTH },
      height: { ideal: LOW_TIER_HEIGHT },
      frameRate: { ideal: PREFERRED_FRAMERATE },
    });
    expect(LOW_TIER_WIDTH).toBe(1280);
    expect(LOW_TIER_HEIGHT).toBe(720);
    const flat = JSON.stringify(c);
    expect(flat).not.toContain('"min"');
    expect(flat).not.toContain('"exact"');
  });

  it('keeps 1080p ideals when deviceMemory is unknown or ample', () => {
    expect(buildVideoConstraints({ facing: 'environment', deviceId: '' })).toMatchObject({
      width: { ideal: PREFERRED_WIDTH },
      height: { ideal: PREFERRED_HEIGHT },
    });
    mockDeviceMemory(16);
    expect(buildVideoConstraints({ facing: 'environment', deviceId: '' })).toMatchObject({
      width: { ideal: PREFERRED_WIDTH },
      height: { ideal: PREFERRED_HEIGHT },
    });
  });

  it('keeps exact deviceId semantics on low-tier devices', () => {
    mockDeviceMemory(2);
    const c = buildVideoConstraints({ facing: 'environment', deviceId: 'd2' });
    expect(c).toMatchObject({ deviceId: { exact: 'd2' } });
    expect(c).not.toHaveProperty('facingMode');
  });
});
