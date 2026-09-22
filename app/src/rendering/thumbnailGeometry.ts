/**
 * Pure thumbnail geometry (Lesson 13).
 *
 * No PDF.js, no DOM, no rendering — safe for jsdom unit tests and easy
 * to verify for portrait/landscape/square pages. The rule is strict:
 * fit inside the target box, preserve aspect ratio, never stretch, never
 * crop, never distort.
 */

/** Result of fitting a source page inside a target box. */
export interface ThumbnailGeometry {
  /** Uniform render scale: `min(targetW/srcW, targetH/srcH)`. */
  scale: number;
  /** Bitmap width: `max(1, floor(srcW * scale))`. */
  width: number;
  /** Bitmap height: `max(1, floor(srcH * scale))`. */
  height: number;
}

/**
 * Calculates the uniform scale plus deterministic bitmap dimensions for a
 * source page (`srcW x srcH` at scale 1, rotation already applied) inside
 * a `targetW x targetH` box. All inputs must be finite and positive;
 * throws `RangeError` otherwise (callers map it to structured errors).
 */
export function calculateThumbnailGeometry(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
): ThumbnailGeometry {
  if (
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    !Number.isFinite(targetW) ||
    !Number.isFinite(targetH) ||
    srcW <= 0 ||
    srcH <= 0 ||
    targetW <= 0 ||
    targetH <= 0
  ) {
    throw new RangeError(
      `thumbnail geometry needs finite positive inputs, got src=${String(srcW)}x${String(srcH)} target=${String(targetW)}x${String(targetH)}`,
    );
  }
  const scale = Math.min(targetW / srcW, targetH / srcH);
  const width = Math.max(1, Math.floor(srcW * scale));
  const height = Math.max(1, Math.floor(srcH * scale));
  return { scale, width, height };
}
