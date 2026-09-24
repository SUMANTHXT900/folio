/**
 * Constraint-construction tests: ideals everywhere, exact nowhere
 * except an explicitly chosen device id.
 */
import { describe, expect, it } from 'vitest';
import {
  PREFERRED_FRAMERATE,
  PREFERRED_HEIGHT,
  PREFERRED_WIDTH,
  buildVideoConstraints,
} from './cameraConstraints';

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
