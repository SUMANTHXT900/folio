// @vitest-environment node
/**
 * `runScanicDetection` tests (D46: ML only — classical removed): ML success,
 * ML miss shapes (throw, no document, invalid quad) all resolving to the
 * full-frame miss result, invalid-quad rejection, and the detector field
 * always naming ML. A single scanner call per detection, always ML.
 *
 * Instrumentation (2026-10-11): every result carries `instrumentation`
 * (frozen field names) — scanic step timings parsed, image-known dims/bytes
 * filled, caller-supplied `decodeMs` applied, `sessionCreateMs` null
 * (unobservable through scanic). Measure-only: success/corners/confidence
 * behavior unchanged.
 */
import { describe, expect, it } from 'vitest';
import './scanicTestImageData';
import { ML_ASSET_BASE_URL, ML_MODEL_INPUT_SIZE } from './detectorPolicy';
import { runScanicDetection, type ScanicDetectionScanner } from './scanicDetection';
import type { ScanicCorners } from './scanicProtocol';

const CORNERS: ScanicCorners = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 100, y: 0 },
  bottomRight: { x: 100, y: 80 },
  bottomLeft: { x: 0, y: 80 },
};

const SCANIC_TIMINGS = [
  { step: 'ML Session Load', ms: '41.20' },
  { step: 'ML Preprocess', ms: '3.10' },
  { step: 'ML Inference', ms: '12.55' },
];

type Outcome =
  | { kind: 'success'; confidence?: number | null }
  | { kind: 'no-document' }
  | { kind: 'invalid-corners' }
  | { kind: 'throw' };

interface ScannerCall {
  detector: string;
  options: { mode: string; detector: string; ml?: unknown };
}

function outcomeToResult(outcome: Outcome): {
  success: boolean;
  corners: unknown;
  confidence?: number | null;
  timings?: Array<{ step: string; ms: unknown }>;
} {
  switch (outcome.kind) {
    case 'throw':
      throw new Error('ml detector exploded');
    case 'no-document':
      return { success: false, corners: null, confidence: null, timings: SCANIC_TIMINGS };
    case 'invalid-corners':
      return {
        success: true,
        corners: { ...CORNERS, topRight: { ...CORNERS.topLeft } },
        confidence: 0.9,
        timings: SCANIC_TIMINGS,
      };
    case 'success':
      return {
        success: true,
        corners: CORNERS,
        confidence: outcome.confidence ?? 0.8,
        timings: SCANIC_TIMINGS,
      };
  }
}

function makeScanner(outcome: Outcome): { scanner: ScanicDetectionScanner; calls: ScannerCall[] } {
  const calls: ScannerCall[] = [];
  const scanner: ScanicDetectionScanner = {
    async scan(_image, options) {
      calls.push({ detector: options.detector, options });
      return outcomeToResult(outcome);
    },
  };
  return { scanner, calls };
}

describe('runScanicDetection', () => {
  it('runs ML with the self-hosted 1-thread options and returns its quad', async () => {
    const { scanner, calls } = makeScanner({ kind: 'success', confidence: 0.93 });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toMatchObject({
      success: true,
      corners: CORNERS,
      confidence: 0.93,
      detector: 'ml',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].detector).toBe('ml');
    expect(calls[0].options.ml).toEqual({ assetBaseUrl: ML_ASSET_BASE_URL, numThreads: 1 });
  });

  it('resolves a full-frame miss (no second attempt) when ML throws', async () => {
    const { scanner, calls } = makeScanner({ kind: 'throw' });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toMatchObject({
      success: false,
      corners: null,
      confidence: null,
      detector: 'ml',
    });
    expect(calls).toHaveLength(1);
  });

  it('resolves a full-frame miss when ML finds no document', async () => {
    const { scanner, calls } = makeScanner({ kind: 'no-document' });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toMatchObject({
      success: false,
      corners: null,
      confidence: null,
      detector: 'ml',
    });
    expect(calls).toHaveLength(1);
  });

  it('treats an invalid ML quad as a miss, never a result', async () => {
    const { scanner, calls } = makeScanner({ kind: 'invalid-corners' });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toMatchObject({
      success: false,
      corners: null,
      confidence: null,
      detector: 'ml',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('runScanicDetection instrumentation', () => {
  it('parses scanic step timings and fills image-known fields on success', async () => {
    const { scanner } = makeScanner({ kind: 'success', confidence: 0.93 });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result.instrumentation).toEqual({
      decodeMs: null, // Not caller-supplied on this call.
      transferBytes: 4 * 4 * 4,
      ortLoadMs: 41.2,
      sessionCreateMs: null, // Folded into Session Load upstream; never split here.
      inferenceMs: 12.55,
      confidence: 0.93,
      inputWidth: 4,
      inputHeight: 4,
      modelInputSize: ML_MODEL_INPUT_SIZE,
    });
    expect(ML_MODEL_INPUT_SIZE).toBe(224);
  });

  it('applies caller-supplied decodeMs and keeps it on miss results', async () => {
    const { scanner } = makeScanner({ kind: 'no-document' });
    const result = await runScanicDetection(scanner, new ImageData(2, 3), 'ml', { decodeMs: 7.5 });
    expect(result.instrumentation).toMatchObject({
      decodeMs: 7.5,
      transferBytes: 2 * 3 * 4,
      ortLoadMs: 41.2,
      inferenceMs: 12.55,
      inputWidth: 2,
      inputHeight: 3,
    });
  });

  it('reports null ORT timings (but image-known dims) when the scanner throws', async () => {
    const { scanner } = makeScanner({ kind: 'throw' });
    const result = await runScanicDetection(scanner, new ImageData(5, 6), 'ml');
    expect(result.instrumentation).toEqual({
      decodeMs: null,
      transferBytes: 5 * 6 * 4,
      ortLoadMs: null,
      sessionCreateMs: null,
      inferenceMs: null,
      confidence: null,
      inputWidth: 5,
      inputHeight: 6,
      modelInputSize: ML_MODEL_INPUT_SIZE,
    });
  });

  it('ignores non-finite decodeMs instead of recording it', async () => {
    const { scanner } = makeScanner({ kind: 'success' });
    const result = await runScanicDetection(scanner, new ImageData(2, 2), 'ml', {
      decodeMs: Number.NaN,
    });
    expect(result.instrumentation?.decodeMs).toBeNull();
  });
});
