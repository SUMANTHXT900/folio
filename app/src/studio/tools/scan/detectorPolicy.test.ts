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
    // No-regret lever 1 (2026-10-11): session options stay untouched —
    // no threading change, no EP change, no new deps. The vendored detector
    // already creates its session with graphOptimizationLevel 'all'; the
    // fixed 224 input has no symbolic dims (see ML_DETECTOR_OPTIONS note).
    expect(policy.ML_MODEL_INPUT_SIZE).toBe(224);
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

describe('resolveDetectionWorkerCount', () => {
  it('exposes the MIN/MAX worker bounds and thresholds', async () => {
    const policy = await loadPolicy();
    expect(policy.MIN_DETECTION_WORKERS).toBe(1);
    expect(policy.MAX_DETECTION_WORKERS).toBe(3);
    expect(policy.MANY_CORE_DETECTION_THRESHOLD).toBe(8);
    expect(policy.LOW_MEMORY_GB_THRESHOLD).toBe(2);
  });

  it('collapses to 1 worker on low memory even with many cores', async () => {
    const policy = await loadPolicy();
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 8, deviceMemory: 1 })).toBe(1);
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 12, deviceMemory: 2 })).toBe(
      1,
    );
  });

  it('collapses to 1 worker for a single page', async () => {
    const policy = await loadPolicy();
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 8, pageCount: 1 })).toBe(1);
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 4, pageCount: 1 })).toBe(1);
  });

  it('resolves 2 workers on mid-range CPUs', async () => {
    const policy = await loadPolicy();
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 4 })).toBe(2);
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 4, deviceMemory: 4 })).toBe(2);
  });

  it('resolves 3 workers on many-core CPUs', async () => {
    const policy = await loadPolicy();
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 8 })).toBe(3);
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 12 })).toBe(3);
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 16, deviceMemory: 8 })).toBe(
      3,
    );
  });

  it('falls back to the CPU rule when device memory is unknown', async () => {
    const policy = await loadPolicy();
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 8 })).toBe(3);
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 4 })).toBe(2);
  });

  it('collapses to 1 worker on low-CPU devices', async () => {
    const policy = await loadPolicy();
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 2 })).toBe(1);
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 1 })).toBe(1);
  });

  it('sizes lanes from PENDING entries, not the total queue (no over-provisioning)', async () => {
    const policy = await loadPolicy();
    // Revisit with 1 still-queued page out of 8 total: 1 lane, even on a
    // many-core device that would fan out for a full queue.
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 8, pageCount: 1 })).toBe(1);
    // Full pending queue on the same device: full fan-out.
    expect(policy.resolveDetectionWorkerCount({ hardwareConcurrency: 8, pageCount: 8 })).toBe(3);
  });
});
