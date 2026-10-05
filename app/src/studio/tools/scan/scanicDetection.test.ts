// @vitest-environment node
/**
 * `runScanicDetection` tests (D46: ML only — classical removed): ML success,
 * ML miss shapes (throw, no document, invalid quad) all resolving to the
 * full-frame miss result, invalid-quad rejection, and the detector field
 * always naming ML. A single scanner call per detection, always ML.
 */
import { describe, expect, it } from 'vitest';
import './scanicTestImageData';
import { ML_ASSET_BASE_URL } from './detectorPolicy';
import { runScanicDetection, type ScanicDetectionScanner } from './scanicDetection';
import type { ScanicCorners } from './scanicProtocol';

const CORNERS: ScanicCorners = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 100, y: 0 },
  bottomRight: { x: 100, y: 80 },
  bottomLeft: { x: 0, y: 80 },
};

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
} {
  switch (outcome.kind) {
    case 'throw':
      throw new Error('ml detector exploded');
    case 'no-document':
      return { success: false, corners: null, confidence: null };
    case 'invalid-corners':
      return {
        success: true,
        corners: { ...CORNERS, topRight: { ...CORNERS.topLeft } },
        confidence: 0.9,
      };
    case 'success':
      return { success: true, corners: CORNERS, confidence: outcome.confidence ?? 0.8 };
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
    expect(result).toEqual({ success: true, corners: CORNERS, confidence: 0.93, detector: 'ml' });
    expect(calls).toHaveLength(1);
    expect(calls[0].detector).toBe('ml');
    expect(calls[0].options.ml).toEqual({ assetBaseUrl: ML_ASSET_BASE_URL, numThreads: 1 });
  });

  it('resolves a full-frame miss (no second attempt) when ML throws', async () => {
    const { scanner, calls } = makeScanner({ kind: 'throw' });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toEqual({ success: false, corners: null, confidence: null, detector: 'ml' });
    expect(calls).toHaveLength(1);
  });

  it('resolves a full-frame miss when ML finds no document', async () => {
    const { scanner, calls } = makeScanner({ kind: 'no-document' });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toEqual({ success: false, corners: null, confidence: null, detector: 'ml' });
    expect(calls).toHaveLength(1);
  });

  it('treats an invalid ML quad as a miss, never a result', async () => {
    const { scanner, calls } = makeScanner({ kind: 'invalid-corners' });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toEqual({ success: false, corners: null, confidence: null, detector: 'ml' });
    expect(calls).toHaveLength(1);
  });
});
