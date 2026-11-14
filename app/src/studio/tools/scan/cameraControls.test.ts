import { describe, expect, it, vi } from 'vitest';
import { cameraRange, clampCameraValue, applyTrackControl } from './cameraControls';

describe('camera capability controls', () => {
  it('keeps sub-one zoom values and rejects bogus or fixed ranges', () => {
    expect(cameraRange({ min: 0.5, max: 8, step: 0.1 })).toEqual({ min: 0.5, max: 8, step: 0.1 });
    expect(cameraRange({ min: 1, max: 1 })).toBeUndefined();
    expect(cameraRange({ min: NaN, max: 4 })).toBeUndefined();
    expect(cameraRange({ min: 0, max: Infinity })).toBeUndefined();
  });
  it('clamps and snaps to the hardware step', () => {
    const range = { min: 0.5, max: 4, step: 0.1 };
    expect(clampCameraValue(0, range)).toBe(0.5);
    expect(clampCameraValue(1.26, range)).toBe(1.3);
    expect(clampCameraValue(20, range)).toBe(4);
  });
  it('preserves resolution, focus, torch and zoom when changing exposure', async () => {
    const applyConstraints = vi.fn(async () => undefined);
    const track = {
      getConstraints: () => ({
        width: { ideal: 1920 },
        advanced: [{ focusMode: 'continuous', zoom: 0.5, torch: true }],
      }),
      applyConstraints,
    } as unknown as MediaStreamTrack;
    await applyTrackControl(track, { exposureCompensation: -1 });
    expect(applyConstraints).toHaveBeenCalledWith({
      width: { ideal: 1920 },
      advanced: [{ focusMode: 'continuous', zoom: 0.5, torch: true, exposureCompensation: -1 }],
    });
  });
  it('serializes concurrent settings and recovers after a rejected control', async () => {
    let current: MediaTrackConstraints = {};
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applyConstraints = vi.fn(async (next: MediaTrackConstraints) => {
      if (applyConstraints.mock.calls.length === 1) await first;
      current = next;
    });
    const track = {
      getConstraints: () => current,
      applyConstraints,
    } as unknown as MediaStreamTrack;
    const zoom = applyTrackControl(track, { zoom: 0.5 });
    const light = applyTrackControl(track, { exposureCompensation: -1 });
    await Promise.resolve();
    expect(applyConstraints).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([zoom, light]);
    expect(current.advanced).toEqual([{ zoom: 0.5, exposureCompensation: -1 }]);
    applyConstraints.mockRejectedValueOnce(new Error('unsupported'));
    await expect(applyTrackControl(track, { torch: true })).rejects.toThrow('unsupported');
    await applyTrackControl(track, { focusMode: 'continuous' });
    expect(current.advanced).toEqual([
      { zoom: 0.5, exposureCompensation: -1, focusMode: 'continuous' },
    ]);
  });
});
