/**
 * Capability-abstraction tests. Every control the scanner renders is
 * gated by this module — including the negative cases (a laptop webcam
 * reporting nothing must yield a control-free UI).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  NO_CAPABILITIES,
  readTrackCapabilities,
  requestContinuousModes,
} from './cameraCapabilities';

function track(caps?: unknown, throws = false) {
  return {
    getCapabilities: () => {
      if (throws) throw new Error('nope');
      return caps;
    },
    applyConstraints: vi.fn(async () => undefined),
  };
}

describe('readTrackCapabilities', () => {
  it('degrades cleanly without a track or getCapabilities', () => {
    expect(readTrackCapabilities(null)).toEqual(NO_CAPABILITIES);
    expect(readTrackCapabilities(undefined)).toEqual(NO_CAPABILITIES);
    expect(readTrackCapabilities({} as never)).toEqual(NO_CAPABILITIES);
    expect(readTrackCapabilities(track(undefined, true))).toEqual(NO_CAPABILITIES);
  });

  it('treats empty capabilities as all-unsupported', () => {
    expect(readTrackCapabilities(track({}))).toEqual(NO_CAPABILITIES);
  });

  it('parses a full mobile-style capability set (no zoom — removed)', () => {
    const caps = readTrackCapabilities(
      track({
        zoom: { min: 1, max: 8, step: 0.1 },
        torch: true,
        focusMode: ['continuous', 'single-shot', 'manual'],
        focusDistance: { min: 0, max: 10, step: 0.1 },
        exposureMode: ['continuous', 'manual'],
      }),
    );
    // Zoom is deliberately not part of the model: the track range is not
    // a focal-length multiplier (see BUGS F-11) — the control was removed.
    expect(caps).not.toHaveProperty('zoom');
    expect(caps.torch).toBe(true);
    expect(caps.focusModes).toEqual(['continuous', 'single-shot', 'manual']);
    expect(caps.supportsContinuousFocus).toBe(true);
    expect(caps.supportsTapToFocus).toBe(true);
  });

  it('requires torch === true (not truthy)', () => {
    expect(readTrackCapabilities(track({ torch: 1 })).torch).toBe(false);
    expect(readTrackCapabilities(track({ torch: true })).torch).toBe(true);
  });

  it('ignores non-array focusMode and manual-only focus', () => {
    expect(readTrackCapabilities(track({ focusMode: 'continuous' })).focusModes).toEqual([]);
    const manualOnly = readTrackCapabilities(
      track({ focusMode: ['manual'], focusDistance: { min: 0, max: 5, step: 0.1 } }),
    );
    expect(manualOnly.supportsContinuousFocus).toBe(false);
    // Manual + distance is not tap-to-focus: no honest point→distance map.
    expect(manualOnly.supportsTapToFocus).toBe(false);
  });
});

describe('requestContinuousModes', () => {
  it('requests continuous focus + exposure when reported', async () => {
    const t = track({
      focusMode: ['continuous', 'manual'],
      exposureMode: ['continuous'],
    });
    await requestContinuousModes(t as never);
    expect(t.applyConstraints).toHaveBeenCalledWith({
      advanced: [{ focusMode: 'continuous', exposureMode: 'continuous' }],
    });
  });

  it('stays silent when nothing is reported or the apply rejects', async () => {
    const empty = track({});
    await requestContinuousModes(empty as never);
    expect(empty.applyConstraints).not.toHaveBeenCalled();
    const failing = track({ focusMode: ['continuous'] });
    failing.applyConstraints = vi.fn(async () => {
      throw new DOMException('rejected', 'NotAllowedError');
    });
    await expect(requestContinuousModes(failing as never)).resolves.toBeUndefined();
    await requestContinuousModes(null);
  });
});
