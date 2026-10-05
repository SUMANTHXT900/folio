/**
 * Wire protocol and shared types for the scanic worker boundary (D34).
 *
 * ```text
 * Main thread (ScanicClient / useScanicProcessor)
 *   │  ScanicWorkerRequest (ImageData pixels as TRANSFERRED ArrayBuffers)
 *   ▼
 * Web Worker (scanic.worker.ts: scanic ML-first detection + warp)
 *   │  ScanicWorkerResponse → Promise resolution
 *   ▼
 * Main thread (ImageData rebuilt from the transferred buffer)
 * ```
 *
 * `ScanicCorners` is the public corner shape: four points in
 * FULL-RESOLUTION source pixels — exactly the coordinate space scanic's
 * `scanDocument` returns (it scales detection-scale corners back to the
 * input dimensions itself, see scanic `src/index.js`). Both sides of the
 * wire speak these types, so runtime validation lives here too: a
 * malformed request frame is dropped, and a non-finite or collapsed quad
 * is rejected BEFORE any image bytes are transferred.
 */

export const SCANIC_WORKER_PROTOCOL_VERSION = 1;

export interface ScanicPoint {
  x: number;
  y: number;
}

/** Document quad in FULL-RESOLUTION source pixels (scanic's CornerPoints). */
export interface ScanicCorners {
  topLeft: ScanicPoint;
  topRight: ScanicPoint;
  bottomRight: ScanicPoint;
  bottomLeft: ScanicPoint;
}

/**
 * Detection backend (D46: ML only — the `'classical'` variant is accepted on
 * the wire but never runs; every result reports `detector: 'ml'`).
 */
export type ScanicDetectorKind = 'classical' | 'ml';

export interface ScanicDetectionResult {
  success: boolean;
  corners: ScanicCorners | null;
  confidence: number | null;
  /**
   * Detector behind this result: always `'ml'` (D46). Kept on the wire so
   * the result shape stays untouched.
   */
  detector: ScanicDetectorKind;
}

export interface ScanicDetectRequest {
  protocol: typeof SCANIC_WORKER_PROTOCOL_VERSION;
  kind: 'detect';
  id: number;
  width: number;
  height: number;
  /** RGBA pixels of a `width`×`height` ImageData, transferred (moved). */
  buffer: ArrayBuffer;
  detector: ScanicDetectorKind;
}

export interface ScanicExtractRequest {
  protocol: typeof SCANIC_WORKER_PROTOCOL_VERSION;
  kind: 'extract';
  id: number;
  width: number;
  height: number;
  /** Full-resolution RGBA pixels, transferred (moved). */
  buffer: ArrayBuffer;
  /** Quad in the same full-resolution pixel space as `buffer`. */
  corners: ScanicCorners;
}

export type ScanicWorkerRequest = ScanicDetectRequest | ScanicExtractRequest;

export type ScanicWorkerResponse =
  | {
      protocol: typeof SCANIC_WORKER_PROTOCOL_VERSION;
      kind: 'detect-result';
      id: number;
      result: ScanicDetectionResult;
    }
  | {
      protocol: typeof SCANIC_WORKER_PROTOCOL_VERSION;
      kind: 'extract-result';
      id: number;
      /** Warp output size (the quad's size) in pixels. */
      width: number;
      height: number;
      /** Warped RGBA pixels, transferred back (moved). */
      buffer: ArrayBuffer;
    }
  | {
      protocol: typeof SCANIC_WORKER_PROTOCOL_VERSION;
      kind: 'error';
      id: number;
      message: string;
    };

/** Corner keys in scanic's canonical order (TL → TR → BR → BL). */
export const SCANIC_CORNER_KEYS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const;

/** Two corners closer than this are the same point, not a document side. */
const MIN_CORNER_SEPARATION_PX = 1;
/** A quad with less area than this is degenerate (collapsed). */
const MIN_QUAD_AREA_PX2 = 1;

function readPoint(value: unknown): ScanicPoint | null {
  if (value === null || typeof value !== 'object') return null;
  const point = value as { x?: unknown; y?: unknown };
  if (typeof point.x !== 'number' || typeof point.y !== 'number') return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: point.x, y: point.y };
}

/**
 * Structural + geometric validation for a `ScanicCorners` value.
 * Returns `null` when valid, otherwise a human-readable rejection reason.
 * Rejects: missing/extra-typed corners, non-finite coordinates, corners
 * that collapse onto each other, and zero-area quads — an operator-edited
 * quad must describe a real quadrilateral before it may be handed to the
 * worker (or transferred at all).
 */
export function validateScanicCorners(value: unknown): string | null {
  if (value === null || typeof value !== 'object') {
    return 'corners must be an object with topLeft/topRight/bottomRight/bottomLeft points';
  }
  const record = value as Record<string, unknown>;
  const topLeft = readPoint(record.topLeft);
  const topRight = readPoint(record.topRight);
  const bottomRight = readPoint(record.bottomRight);
  const bottomLeft = readPoint(record.bottomLeft);
  if (topLeft === null || topRight === null || bottomRight === null || bottomLeft === null) {
    return 'corners must provide four finite {x, y} points (topLeft, topRight, bottomRight, bottomLeft)';
  }
  const quad = [topLeft, topRight, bottomRight, bottomLeft];
  for (let i = 0; i < quad.length; i += 1) {
    for (let j = i + 1; j < quad.length; j += 1) {
      const separation = Math.hypot(quad[i].x - quad[j].x, quad[i].y - quad[j].y);
      if (separation < MIN_CORNER_SEPARATION_PX) {
        return `corner ${SCANIC_CORNER_KEYS[i]}/${SCANIC_CORNER_KEYS[j]} collapses to a single point`;
      }
    }
  }
  let twiceArea = 0;
  for (let i = 0; i < quad.length; i += 1) {
    const current = quad[i];
    const next = quad[(i + 1) % quad.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  if (Math.abs(twiceArea) / 2 < MIN_QUAD_AREA_PX2) {
    return 'quad has no area (collapsed document)';
  }
  return null;
}

export function isValidScanicCorners(value: unknown): value is ScanicCorners {
  return validateScanicCorners(value) === null;
}

export function isScanicDetectorKind(value: unknown): value is ScanicDetectorKind {
  return value === 'classical' || value === 'ml';
}
