/**
 * Camera constraint construction (P3/P4): preference-only negotiation.
 *
 * Every constraint beyond the device/facing selection is `ideal`, never
 * exact — a weak webcam falls back to whatever it supports instead of
 * failing with `OverconstrainedError`. After `getUserMedia` succeeds the
 * caller must read back `track.getSettings()`: requested ideals never
 * equal negotiated reality.
 *
 * Preferred capture: 1080p-ish at 30 fps where the hardware allows it.
 * The historical `{facingMode: {ideal}}`-only request left desktop
 * browsers free to negotiate 640×480 on capable webcams.
 *
 * Low-memory devices (`navigator.deviceMemory <= 4`, where reported)
 * prefer 720p ideals instead — less decode/scale memory on constrained
 * phones. Unknown/absent `deviceMemory` keeps current behavior.
 *
 * All of these are REQUESTS, not guarantees: every value below is
 * `ideal`, never `exact`/`min`/`max`, so the browser negotiates the
 * closest its hardware supports. Callers must read back
 * `track.getSettings()` after `getUserMedia` — requested ideals never
 * equal negotiated reality.
 */

export type CameraFacing = 'environment' | 'user';

export interface ConstraintRequest {
  facing: CameraFacing;
  /** Explicit device id (exact match); empty means facing-mode selection. */
  deviceId: string;
}

/** Preferred (ideal-only) capture profile. */
export const PREFERRED_WIDTH = 1920;
export const PREFERRED_HEIGHT = 1080;
export const PREFERRED_FRAMERATE = 30;

/** Low-tier (ideal-only) capture profile for constrained devices. */
export const LOW_TIER_WIDTH = 1280;
export const LOW_TIER_HEIGHT = 720;

/**
 * True when the device reports ≤4 GB RAM via `navigator.deviceMemory`.
 * Guarded: unknown, absent, or non-numeric values mean "not low-tier"
 * (current behavior). `deviceMemory` is Chromium-only and rounded to
 * powers of two — a coarse hint, never a capability probe.
 */
export function prefersLowTierCapture(): boolean {
  try {
    const memory =
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & { deviceMemory?: unknown }).deviceMemory
        : undefined;
    return typeof memory === 'number' && Number.isFinite(memory) && memory <= 4;
  } catch {
    return false;
  }
}

/** Builds the `video` constraint block for `getUserMedia`. */
export function buildVideoConstraints(request: ConstraintRequest): MediaTrackConstraints {
  const lowTier = prefersLowTierCapture();
  const preferences = {
    width: { ideal: lowTier ? LOW_TIER_WIDTH : PREFERRED_WIDTH },
    height: { ideal: lowTier ? LOW_TIER_HEIGHT : PREFERRED_HEIGHT },
    frameRate: { ideal: PREFERRED_FRAMERATE },
  };
  if (request.deviceId) {
    return { deviceId: { exact: request.deviceId }, ...preferences };
  }
  return { facingMode: { ideal: request.facing }, ...preferences };
}
