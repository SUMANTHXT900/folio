/**
 * Camera capability abstraction for the document scanner.
 *
 * Isolates `MediaStreamTrack` capability inspection from
 * `CameraCapture.tsx`. The UI is driven ONLY by what this module
 * reports — never by device assumptions.
 *
 * Critical distinction (Phase 3 rule): `getCapabilities()` reporting a
 * feature does NOT mean `applyConstraints()` will honor it. Every
 * control must handle rejection gracefully (disable + note, never
 * crash). Detection is necessary; only a successful apply proves
 * the feature works.
 */

export interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

export interface CameraCapabilities {
  /** Zoom range when genuinely usable, else null. */
  zoom: ZoomRange | null;
  /** True only when the torch constraint is exposed. */
  torch: boolean;
  /** Focus modes the track reports (e.g. continuous, single-shot, manual). */
  focusModes: string[];
  /** Continuous autofocus may be requested (best-effort, failures ignored). */
  supportsContinuousFocus: boolean;
  /**
   * Tap-to-focus may trigger a real one-shot AF cycle: only when the
   * track reports `single-shot` focus. `manual` + `focusDistance` alone
   * is NOT tap-to-focus (a screen point cannot honestly map to a lens
   * distance), so it stays false there.
   */
  supportsTapToFocus: boolean;
}

export const NO_CAPABILITIES: CameraCapabilities = {
  zoom: null,
  torch: false,
  focusModes: [],
  supportsContinuousFocus: false,
  supportsTapToFocus: false,
};

interface RawCapabilities {
  zoom?: unknown;
  torch?: unknown;
  focusMode?: unknown;
  focusDistance?: unknown;
  exposureMode?: unknown;
}

type CapabilityTrack = Pick<MediaStreamTrack, 'applyConstraints'> & {
  getCapabilities?: () => unknown;
};

/**
 * Reads + normalizes one video track's capabilities. Never throws:
 * missing `getCapabilities`, foreign shapes, and non-finite numbers all
 * degrade to `NO_CAPABILITIES`-equivalent fields.
 */
export function readTrackCapabilities(
  track: CapabilityTrack | null | undefined,
): CameraCapabilities {
  if (track === null || track === undefined) return { ...NO_CAPABILITIES };
  if (typeof track.getCapabilities !== 'function') return { ...NO_CAPABILITIES };
  let raw: RawCapabilities;
  try {
    raw = (track.getCapabilities() ?? {}) as RawCapabilities;
  } catch {
    return { ...NO_CAPABILITIES };
  }
  const focusModes = Array.isArray(raw.focusMode)
    ? raw.focusMode.filter((m): m is string => typeof m === 'string')
    : [];
  return {
    zoom: normalizeZoom(raw.zoom),
    torch: raw.torch === true,
    focusModes,
    supportsContinuousFocus: focusModes.includes('continuous'),
    supportsTapToFocus: focusModes.includes('single-shot'),
  };
}

function normalizeZoom(value: unknown): ZoomRange | null {
  if (typeof value !== 'object' || value === null) return null;
  const { min, max, step } = value as { min?: unknown; max?: unknown; step?: unknown };
  if (
    typeof min !== 'number' ||
    typeof max !== 'number' ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    max <= min
  ) {
    return null;
  }
  const saneStep =
    typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : (max - min) / 10;
  return { min, max, step: saneStep };
}

/**
 * Best-effort request for continuous focus (+ exposure where reported).
 * Resolves silently in all cases — including when the track later
 * rejects despite reporting support. Never surfaces UI; the scanner
 * works identically with or without it.
 */
export async function requestContinuousModes(
  track: Pick<MediaStreamTrack, 'applyConstraints' | 'getCapabilities'> | null | undefined,
): Promise<void> {
  if (track === null || track === undefined) return;
  if (typeof track.getCapabilities !== 'function') return;
  let raw: RawCapabilities;
  try {
    raw = (track.getCapabilities() ?? {}) as RawCapabilities;
  } catch {
    return;
  }
  const advanced: Record<string, string> = {};
  if (Array.isArray(raw.focusMode) && raw.focusMode.includes('continuous')) {
    advanced['focusMode'] = 'continuous';
  }
  if (Array.isArray(raw.exposureMode) && raw.exposureMode.includes('continuous')) {
    advanced['exposureMode'] = 'continuous';
  }
  if (Object.keys(advanced).length === 0) return;
  try {
    await track.applyConstraints({ advanced: [advanced] });
  } catch {
    // Reported-but-rejected: stay silent, camera keeps working.
  }
}
