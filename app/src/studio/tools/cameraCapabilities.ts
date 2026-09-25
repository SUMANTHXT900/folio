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
 *
 * Zoom is deliberately absent: the track's reported zoom range is not a
 * focal-length multiplier (devices report "1×" while actually using the
 * ultrawide lens), so any slider lied to users. The control was removed
 * (docs/BUGS.md F-11) and returns only with focal-accurate handling.
 */

export interface CameraCapabilities {
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
  torch: false,
  focusModes: [],
  supportsContinuousFocus: false,
  supportsTapToFocus: false,
};

interface RawCapabilities {
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
    torch: raw.torch === true,
    focusModes,
    supportsContinuousFocus: focusModes.includes('continuous'),
    supportsTapToFocus: focusModes.includes('single-shot'),
  };
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
