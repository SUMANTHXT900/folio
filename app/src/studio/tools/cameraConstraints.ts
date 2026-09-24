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

/** Builds the `video` constraint block for `getUserMedia`. */
export function buildVideoConstraints(request: ConstraintRequest): MediaTrackConstraints {
  const preferences = {
    width: { ideal: PREFERRED_WIDTH },
    height: { ideal: PREFERRED_HEIGHT },
    frameRate: { ideal: PREFERRED_FRAMERATE },
  };
  if (request.deviceId) {
    return { deviceId: { exact: request.deviceId }, ...preferences };
  }
  return { facingMode: { ideal: request.facing }, ...preferences };
}
