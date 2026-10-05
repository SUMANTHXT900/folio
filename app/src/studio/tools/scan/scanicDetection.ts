/**
 * ML-only document detection — the worker's detection policy as a plain,
 * testable function (D46: classical removed — its quads were random
 * auto-crops on real photos, worse than no crop at all).
 *
 * The ML detector runs; ANY failure (scanic throw, missing document,
 * invalid quad) resolves to `success: false` with `corners: null`, and the
 * caller commits the full frame uncropped. Every result names `detector:
 * 'ml'`. This function never throws.
 */

import type { MlDetectorOptions } from 'scanic';
import { ML_DETECTOR_OPTIONS } from './detectorPolicy';
import {
  isValidScanicCorners,
  type ScanicDetectionResult,
  type ScanicDetectorKind,
} from './scanicProtocol';

/** The slice of scanic's `Scanner` this module needs (a test seam). */
export interface ScanicDetectionScanner {
  scan(
    image: ImageData,
    options: { mode: 'detect'; detector: ScanicDetectorKind; ml?: MlDetectorOptions },
  ): Promise<{ success: boolean; corners: unknown; confidence?: number | null }>;
}

/**
 * Detect a document quad with the ML detector. A quad that fails geometric
 * validation is a MISS, never a result: only a real quadrilateral may travel
 * on to extraction, otherwise the full frame is used. Never throws.
 */
export async function runScanicDetection(
  scanner: ScanicDetectionScanner,
  image: ImageData,
  // Accepted and ignored (D46): the detector is always ML. Kept so the
  // worker call-site and the wire shape stay untouched.
  _detector?: ScanicDetectorKind,
): Promise<ScanicDetectionResult> {
  try {
    const detection = await scanner.scan(image, {
      mode: 'detect',
      detector: 'ml',
      ml: ML_DETECTOR_OPTIONS,
    });
    // A quad that fails geometric validation is a MISS, never a result:
    // only a real quadrilateral may travel on to extraction.
    if (detection.success === true && isValidScanicCorners(detection.corners)) {
      return {
        success: true,
        corners: detection.corners,
        confidence: typeof detection.confidence === 'number' ? detection.confidence : null,
        detector: 'ml',
      };
    }
  } catch {
    // A scanic-level failure is a miss, not fatal: the caller uses the
    // full frame.
  }
  return { success: false, corners: null, confidence: null, detector: 'ml' };
}
