/**
 * ML-first detection with one classical fallback — the worker's detection
 * policy as a plain, testable function.
 *
 * Requesting `'ml'` tries the ML detector first; ANY failure (scanic throw,
 * missing document, invalid quad) falls back to classical ONCE. Requesting
 * `'classical'` runs classical directly. Every result names the detector
 * behind it (`detector: 'ml' | 'classical'`) so a silent fallback stays
 * reportable; a total failure resolves `success: false` with `detector`
 * naming the final attempt. This function never throws.
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

/** One detector pass; `null` = no usable quad (throw, none found, invalid). */
async function attempt(
  scanner: ScanicDetectionScanner,
  image: ImageData,
  detector: ScanicDetectorKind,
): Promise<ScanicDetectionResult | null> {
  try {
    const detection = await scanner.scan(image, {
      mode: 'detect',
      detector,
      ...(detector === 'ml' ? { ml: ML_DETECTOR_OPTIONS } : {}),
    });
    // A quad that fails geometric validation is a FAILED attempt, never a
    // result: only a real quadrilateral may travel on to extraction.
    if (detection.success !== true || !isValidScanicCorners(detection.corners)) {
      return null;
    }
    return {
      success: true,
      corners: detection.corners,
      confidence: typeof detection.confidence === 'number' ? detection.confidence : null,
      detector,
    };
  } catch {
    // A scanic-level failure is a failed attempt, not fatal: the caller may
    // still get classical corners.
    return null;
  }
}

/**
 * Detect a document quad: ML-first when requested with a single classical
 * fallback; classical only when requested. Never throws — a total failure
 * resolves to `success: false`, `corners: null`, with `detector` naming the
 * last attempted backend.
 */
export async function runScanicDetection(
  scanner: ScanicDetectionScanner,
  image: ImageData,
  detector: ScanicDetectorKind,
): Promise<ScanicDetectionResult> {
  const primary = await attempt(scanner, image, detector);
  if (primary !== null) return primary;
  if (detector === 'classical') {
    return { success: false, corners: null, confidence: null, detector: 'classical' };
  }
  const fallback = await attempt(scanner, image, 'classical');
  return fallback ?? { success: false, corners: null, confidence: null, detector: 'classical' };
}
