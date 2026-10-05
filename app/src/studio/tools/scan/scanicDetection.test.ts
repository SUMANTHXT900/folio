// @vitest-environment node
/**
 * `runScanicDetection` tests: ML-first ordering, exactly one classical
 * fallback on any ML failure (throw, no document, invalid quad), explicit
 * classical without an ML attempt, invalid-quad rejection, and the detector
 * field naming the backend behind every result.
 */
import { describe, expect, it } from 'vitest';
import './scanicTestImageData';
import { ML_ASSET_BASE_URL } from './detectorPolicy';
import { runScanicDetection, type ScanicDetectionScanner } from './scanicDetection';
import type { ScanicCorners, ScanicDetectorKind } from './scanicProtocol';

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
  detector: ScanicDetectorKind;
  options: { mode: string; detector: ScanicDetectorKind; ml?: unknown };
}

function outcomeToResult(
  detector: ScanicDetectorKind,
  outcome: Outcome,
): { success: boolean; corners: unknown; confidence?: number | null } {
  switch (outcome.kind) {
    case 'throw':
      throw new Error(`${detector} detector exploded`);
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

function makeScanner(outcomes: Record<ScanicDetectorKind, Outcome>): {
  scanner: ScanicDetectionScanner;
  calls: ScannerCall[];
} {
  const calls: ScannerCall[] = [];
  const scanner: ScanicDetectionScanner = {
    async scan(_image, options) {
      calls.push({ detector: options.detector, options });
      return outcomeToResult(options.detector, outcomes[options.detector]);
    },
  };
  return { scanner, calls };
}

describe('runScanicDetection', () => {
  it('tries ML first with the self-hosted 1-thread options and skips classical on ML success', async () => {
    const { scanner, calls } = makeScanner({
      ml: { kind: 'success', confidence: 0.93 },
      classical: { kind: 'success' },
    });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toEqual({ success: true, corners: CORNERS, confidence: 0.93, detector: 'ml' });
    expect(calls).toHaveLength(1);
    expect(calls[0].detector).toBe('ml');
    expect(calls[0].options.ml).toEqual({ assetBaseUrl: ML_ASSET_BASE_URL, numThreads: 1 });
  });

  it('falls back to classical exactly once when ML throws', async () => {
    const { scanner, calls } = makeScanner({
      ml: { kind: 'throw' },
      classical: { kind: 'success', confidence: 0.7 },
    });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toEqual({
      success: true,
      corners: CORNERS,
      confidence: 0.7,
      detector: 'classical',
    });
    expect(calls.map((call) => call.detector)).toEqual(['ml', 'classical']);
    expect(calls[1].options.ml).toBeUndefined();
  });

  it('falls back to classical exactly once when ML finds no document', async () => {
    const { scanner, calls } = makeScanner({
      ml: { kind: 'no-document' },
      classical: { kind: 'success', confidence: 0.6 },
    });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toEqual({
      success: true,
      corners: CORNERS,
      confidence: 0.6,
      detector: 'classical',
    });
    expect(calls.map((call) => call.detector)).toEqual(['ml', 'classical']);
  });

  it('treats an invalid ML quad as a failed attempt and reports the classical result', async () => {
    const { scanner, calls } = makeScanner({
      ml: { kind: 'invalid-corners' },
      classical: { kind: 'success' },
    });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toMatchObject({ success: true, corners: CORNERS, detector: 'classical' });
    expect(calls.map((call) => call.detector)).toEqual(['ml', 'classical']);
  });

  it('never returns invalid corners: both invalid resolves success false with the final detector', async () => {
    const { scanner, calls } = makeScanner({
      ml: { kind: 'invalid-corners' },
      classical: { kind: 'invalid-corners' },
    });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toEqual({
      success: false,
      corners: null,
      confidence: null,
      detector: 'classical',
    });
    expect(calls.map((call) => call.detector)).toEqual(['ml', 'classical']);
  });

  it('resolves success false with the final detector when both backends throw', async () => {
    const { scanner, calls } = makeScanner({
      ml: { kind: 'throw' },
      classical: { kind: 'throw' },
    });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'ml');
    expect(result).toEqual({
      success: false,
      corners: null,
      confidence: null,
      detector: 'classical',
    });
    expect(calls.map((call) => call.detector)).toEqual(['ml', 'classical']);
  });

  it('runs classical directly for an explicit classical request (no ML attempt)', async () => {
    const { scanner, calls } = makeScanner({
      ml: { kind: 'success' },
      classical: { kind: 'success', confidence: 0.5 },
    });
    const result = await runScanicDetection(scanner, new ImageData(4, 4), 'classical');
    expect(result).toEqual({
      success: true,
      corners: CORNERS,
      confidence: 0.5,
      detector: 'classical',
    });
    expect(calls.map((call) => call.detector)).toEqual(['classical']);
    expect(calls[0].options.ml).toBeUndefined();
  });
});
