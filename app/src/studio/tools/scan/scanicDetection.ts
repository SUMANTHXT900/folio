/**
 * ML-only document detection — the worker's detection policy as a plain,
 * testable function (D46: classical removed — its quads were random
 * auto-crops on real photos, worse than no crop at all).
 *
 * The ML detector runs; ANY failure (scanic throw, missing document,
 * invalid quad) resolves to `success: false` with `corners: null`, and the
 * caller commits the full frame uncropped. Every result names `detector:
 * 'ml'`. This function never throws.
 *
 * Instrumentation (no-regret ML pipeline, 2026-10-11): every result also
 * carries `instrumentation` (timings + dims + confidence alongside the
 * corners; field names frozen for the VF lane). scanic's own per-step
 * timings (`ML Session Load`, `ML Inference`) are parsed out of the
 * scanner result; `sessionCreateMs` stays null (folded into Session Load
 * upstream — see `scanicProtocol.ts`); `decodeMs` is caller-supplied via
 * `opts` (the worker never observes decode). Measure-only: nothing here
 * changes detection behavior.
 */

import type { MlDetectorOptions } from 'scanic';
import { ML_DETECTOR_OPTIONS, ML_MODEL_INPUT_SIZE } from './detectorPolicy';
import {
  isValidScanicCorners,
  type ScanicDetectInstrumentation,
  type ScanicDetectionResult,
  type ScanicDetectorKind,
} from './scanicProtocol';

/** The slice of scanic's `Scanner` this module needs (a test seam). */
export interface ScanicDetectionScanner {
  scan(
    image: ImageData,
    options: { mode: 'detect'; detector: ScanicDetectorKind; ml?: MlDetectorOptions },
  ): Promise<{
    success: boolean;
    corners: unknown;
    confidence?: number | null;
    /** scanic's per-step timings (`{ step, ms }`; ms arrives as a string). */
    timings?: Array<{ step: string; ms: unknown }>;
  }>;
}

/** Caller-supplied measurement into `runScanicDetection` (additive). */
export interface ScanicDetectionCallOptions {
  /** Main-thread decode cost in ms; null/omitted when unknown. */
  decodeMs?: number | null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** scanic reports step timings as numeric strings (`"12.34"`); parse one step. */
function stepMs(
  timings: Array<{ step: string; ms: unknown }> | undefined,
  step: string,
): number | null {
  if (timings === undefined) return null;
  for (const timing of timings) {
    if (timing.step === step) {
      const parsed = typeof timing.ms === 'number' ? timing.ms : Number(timing.ms);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function buildInstrumentation(
  image: ImageData,
  confidence: number | null,
  timings: Array<{ step: string; ms: unknown }> | undefined,
  decodeMs: number | null,
): ScanicDetectInstrumentation {
  return {
    decodeMs,
    transferBytes: image.data.byteLength,
    ortLoadMs: stepMs(timings, 'ML Session Load'),
    sessionCreateMs: null,
    inferenceMs: stepMs(timings, 'ML Inference'),
    confidence,
    inputWidth: image.width,
    inputHeight: image.height,
    modelInputSize: ML_MODEL_INPUT_SIZE,
  };
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
  opts?: ScanicDetectionCallOptions,
): Promise<ScanicDetectionResult> {
  const decodeMs = finiteOrNull(opts?.decodeMs ?? null);
  try {
    const detection = await scanner.scan(image, {
      mode: 'detect',
      detector: 'ml',
      ml: ML_DETECTOR_OPTIONS,
    });
    const timings = Array.isArray(detection.timings) ? detection.timings : undefined;
    const confidence = finiteOrNull(detection.confidence ?? null);
    const instrumentation = buildInstrumentation(image, confidence, timings, decodeMs);
    // A quad that fails geometric validation is a MISS, never a result:
    // only a real quadrilateral may travel on to extraction.
    if (detection.success === true && isValidScanicCorners(detection.corners)) {
      return {
        success: true,
        corners: detection.corners,
        confidence,
        detector: 'ml',
        instrumentation,
      };
    }
    return { success: false, corners: null, confidence: null, detector: 'ml', instrumentation };
  } catch {
    // A scanic-level failure is a miss, not fatal: the caller uses the
    // full frame.
  }
  // Miss with no scanner timings: every instrumentation field the worker
  // cannot observe stays null, except the image-known dims/bytes.
  return {
    success: false,
    corners: null,
    confidence: null,
    detector: 'ml',
    instrumentation: buildInstrumentation(image, null, undefined, decodeMs),
  };
}
