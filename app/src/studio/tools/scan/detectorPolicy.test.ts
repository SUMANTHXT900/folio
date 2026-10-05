// @vitest-environment node
/**
 * `detectorPolicy` tests (D46: ML only): constants, `detectorForAttempt`
 * always resolving ML, and `warmMlDetector` — one real preload scan with
 * the policy options, success caching, honest failure reporting with retry,
 * and concurrent sharing.
 *
 * scanic is mocked: warm-up creates a Scanner and runs one detection pass,
 * which is exactly what these tests observe.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import './scanicTestImageData';

const scanicMock = vi.hoisted(() => ({
  scan: vi.fn(),
  constructorOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('scanic', () => ({
  Scanner: class {
    constructor(options: Record<string, unknown>) {
      scanicMock.constructorOptions.push(options);
    }
    scan = scanicMock.scan;
  },
}));

// Warm state is module-level by design; every test loads a fresh module
// instance so each transition is observed from 'cold'.
async function loadPolicy() {
  vi.resetModules();
  return import('./detectorPolicy');
}

beforeEach(() => {
  scanicMock.scan.mockReset();
  scanicMock.constructorOptions.length = 0;
});

describe('detectorPolicy constants and helper', () => {
  it('defaults to ML with the self-hosted asset base and 1 thread', async () => {
    const policy = await loadPolicy();
    expect(policy.DEFAULT_DETECTOR).toBe('ml');
    expect(policy.ML_ASSET_BASE_URL).toBe('/assets/scanic-ml/');
    expect(policy.ML_DETECTOR_OPTIONS).toEqual({
      assetBaseUrl: '/assets/scanic-ml/',
      numThreads: 1,
    });
  });

  it('detectorForAttempt always resolves ML (classical removed)', async () => {
    const { detectorForAttempt } = await loadPolicy();
    expect(detectorForAttempt(true, true)).toBe('ml');
    expect(detectorForAttempt(true, false)).toBe('ml');
    expect(detectorForAttempt(false, true)).toBe('ml');
    expect(detectorForAttempt(false, false)).toBe('ml');
    expect(detectorForAttempt()).toBe('ml');
  });

  it('defaultDetector stays ML even after a failed warm', async () => {
    scanicMock.scan.mockRejectedValue(new Error('model unavailable'));
    const policy = await loadPolicy();
    expect(policy.mlDetectorWarmState()).toBe('cold');
    expect(policy.defaultDetector()).toBe('ml');
    await expect(policy.warmMlDetector()).resolves.toBe(false);
    expect(policy.mlDetectorWarmState()).toBe('failed');
    expect(policy.defaultDetector()).toBe('ml');
  });
});

describe('warmMlDetector', () => {
  it('runs one real ML scan with the policy options and caches success', async () => {
    scanicMock.scan.mockResolvedValue({ success: false, corners: null, confidence: null });
    const policy = await loadPolicy();
    await expect(policy.warmMlDetector()).resolves.toBe(true);
    expect(policy.mlDetectorWarmState()).toBe('ready');
    expect(scanicMock.constructorOptions).toEqual([
      { detector: 'ml', ml: { assetBaseUrl: '/assets/scanic-ml/', numThreads: 1 } },
    ]);
    expect(scanicMock.scan).toHaveBeenCalledTimes(1);
    const [image, options] = scanicMock.scan.mock.calls[0];
    expect((image as ImageData).width).toBeGreaterThan(0);
    expect((image as ImageData).height).toBeGreaterThan(0);
    expect(options).toEqual({
      mode: 'detect',
      detector: 'ml',
      ml: { assetBaseUrl: '/assets/scanic-ml/', numThreads: 1 },
    });
    // Success is cached: a second call resolves true with no new scan.
    await expect(policy.warmMlDetector()).resolves.toBe(true);
    expect(scanicMock.scan).toHaveBeenCalledTimes(1);
  });

  it('resolves false on any ML failure and retries on the next call', async () => {
    scanicMock.scan.mockRejectedValueOnce(new Error('model fetch failed'));
    const policy = await loadPolicy();
    await expect(policy.warmMlDetector()).resolves.toBe(false);
    expect(policy.mlDetectorWarmState()).toBe('failed');

    scanicMock.scan.mockResolvedValueOnce({ success: false, corners: null, confidence: null });
    await expect(policy.warmMlDetector()).resolves.toBe(true);
    expect(policy.mlDetectorWarmState()).toBe('ready');
    expect(scanicMock.scan).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight warmup between concurrent callers', async () => {
    let release: ((value: unknown) => void) | null = null;
    scanicMock.scan.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const policy = await loadPolicy();
    const first = policy.warmMlDetector();
    const second = policy.warmMlDetector();
    expect(policy.mlDetectorWarmState()).toBe('warming');
    // runMlWarmup() awaits the scanic dynamic import before scanning; wait
    // for that first mock call, then resolve it.
    await vi.waitFor(() => expect(scanicMock.scan).toHaveBeenCalledTimes(1));
    // The assignment happened inside the mock callback above; cast away the
    // declaration-time narrowing so the resolver is callable here.
    const releaseScan = release as ((value: unknown) => void) | null;
    releaseScan?.({ success: false, corners: null, confidence: null });
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(scanicMock.scan).toHaveBeenCalledTimes(1);
  });
});
