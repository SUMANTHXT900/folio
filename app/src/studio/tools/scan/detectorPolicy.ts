/**
 * Detector policy for the scanic scan core (D35, D46): ML only — classical
 * was removed (its quads were random auto-crops on real photos).
 *
 * The self-hosted ML detector (DocCornerNet via scanic; assets vendored
 * same-origin under `/assets/scanic-ml/`, D34, precached at install) is the
 * ONLY detector. A miss means the full frame is used, never a guess.
 * This module is shared by the main thread (client/UI) and the scan worker:
 * it uses no DOM and no React, and each JS context warms its own scanic ML
 * session.
 *
 * `warmMlDetector()` is a fire-and-forget preload for scanner open: it loads
 * the ORT runtime chunk + model bytes, creates the session, and runs one
 * inference; it resolves `true` when the ML pipeline is usable in this
 * context, `false` on any failure (the caller uses the full frame).
 * Success is cached; failure is retried by the next call.
 */

import type { ScanicDetectorKind } from './scanicProtocol';

/** ML is the only detector (D35 default, D46 classical removed). */
export const DEFAULT_DETECTOR = 'ml' as const;

/**
 * Self-hosted (same-origin) ML assets: the vendored `scanic-ml@0.2.0` dist,
 * precached by the PWA at install — never a CDN (field scanning assumes zero
 * network).
 */
export const ML_ASSET_BASE_URL = '/assets/scanic-ml/';

/**
 * ML options for every scanic ML call in this core: same-origin assets and
 * `numThreads: 1` (the Folio default — no COOP/COEP isolation; ~13ms
 * inference measured upstream).
 *
 * Session-options note (no-regret lever 1, inspected 2026-10-11 — KEEP
 * constraints hold, so this stays a pin, not a change):
 * - The vendored detector (`node_modules/scanic/dist/scanic-mlDetector.js`,
 *   same bytes as production) already creates its session as
 *   `InferenceSession.create(bytes, { executionProviders: ['wasm'],
 *   graphOptimizationLevel: 'all' })` — the 'all' level this lever asks for
 *   is already the shipping behavior; there is nothing further to set.
 * - scanic's public `MlDetectorOptions` exposes NO session passthrough
 *   (assetBaseUrl / modelUrl / wasmPaths / modelBytes / timeout / threads /
 *   minScore only), so arena (`enableCpuMemArena`) / mem-pattern
 *   (`enableMemPattern`) flags are unreachable without forking scanic or
 *   taking an ORT-direct dependency — both out of scope (no new deps, no EP
 *   change). Skipped with this comment, not silently.
 * - `freeDimensionOverrides` is N/A: the model input is fixed 224×224
 *   (`doccornernet_lean.ort` contains zero `dim_param` entries — fully
 *   static dims; the detector letterboxes every input to 224 and runs a
 *   fixed `[1, 224, 224, 3]` tensor). No symbolic dims exist to override.
 * - Threading / execution providers are FROZEN: 1 thread, wasm EP, no
 *   COOP/COEP (see `app/public/assets/scanic-ml/VERSIONS.md`).
 */
export const ML_DETECTOR_OPTIONS = {
  assetBaseUrl: ML_ASSET_BASE_URL,
  numThreads: 1,
} as const;

/**
 * Fixed DocCornerNet input edge: the vendored detector letterboxes every
 * input to 224×224 and runs a static `[1, 224, 224, 3]` tensor (see the
 * session-options note on `ML_DETECTOR_OPTIONS`). Reported as
 * `instrumentation.modelInputSize` so future pre-downscale work can reason
 * about the detection resize without re-deriving it.
 */
export const ML_MODEL_INPUT_SIZE = 224;

/**
 * Warm-preload state for THIS JS context. The main thread and the scan worker
 * are separate contexts and warm independently.
 */
export type MlWarmState = 'cold' | 'warming' | 'ready' | 'failed';

let warmState: MlWarmState = 'cold';
let warmPromise: Promise<boolean> | null = null;

/** Current warm-preload state (diagnostics; read-only, no side effects). */
export function mlDetectorWarmState(): MlWarmState {
  return warmState;
}

/** Synthetic warm-up image; its pixels never matter, only that inference ran. */
const WARM_IMAGE_SIZE = 16;

async function runMlWarmup(): Promise<boolean> {
  try {
    // Lazy import: importing this policy must not pull scanic into a module
    // graph until the warm preload actually runs.
    const { Scanner } = await import('scanic');
    const scanner = new Scanner({ detector: DEFAULT_DETECTOR, ml: ML_DETECTOR_OPTIONS });
    // A real scan, not `Scanner.initialize()` (which swallows errors), is the
    // only honest success signal: it loads the ORT runtime chunk, fetches the
    // model bytes, creates the session, and runs one inference. A "no
    // document" outcome still proves the ML pipeline is warm.
    await scanner.scan(new ImageData(WARM_IMAGE_SIZE, WARM_IMAGE_SIZE), {
      mode: 'detect',
      detector: DEFAULT_DETECTOR,
      ml: ML_DETECTOR_OPTIONS,
    });
    return true;
  } catch {
    // Any ML failure (chunk import, model fetch, session create, inference)
    // is the normal "ML unavailable in this context" outcome: report it so
    // the caller uses the full frame.
    return false;
  }
}

/**
 * Fire-and-forget preload of THIS context's ML pipeline: ORT runtime, model
 * bytes, session, one inference. Call at scanner open so the first capture
 * never pays the load. Concurrent/repeated calls share the in-flight warmup;
 * success is cached, failure is retried by the next call.
 */
export async function warmMlDetector(): Promise<boolean> {
  if (warmState === 'ready') return true;
  if (warmPromise === null) {
    warmState = 'warming';
    warmPromise = runMlWarmup().then(
      (ready) => {
        warmState = ready ? 'ready' : 'failed';
        return ready;
      },
      () => {
        warmState = 'failed';
        return false;
      },
    );
    void warmPromise.finally(() => {
      warmPromise = null;
    });
  }
  return warmPromise;
}

/**
 * Detector for one attempt: always ML (D46 — classical removed). Kept as a
 * named policy seam (and re-exported) so call sites read intent, not a
 * string literal. Arguments accepted and ignored for call-site stability.
 */
export function detectorForAttempt(_preferMl?: boolean, _mlReady?: boolean): ScanicDetectorKind {
  return 'ml';
}

/**
 * Default detector for this context: ML, unconditionally (D46). This is the
 * resolution `ScanicClient.detect()` uses when the caller names no detector.
 */
export function defaultDetector(): ScanicDetectorKind {
  return 'ml';
}

/**
 * Deferred review-time detection fan-out (D47, P3 shape mirroring
 * `imageSharding.ts`): shutter stays queue-only; detection runs later over
 * the queued pages across K parallel lanes.
 *
 * - `MIN_DETECTION_WORKERS` (1) is the floor: single-page reviews and
 *   low-memory/low-CPU devices stay serial.
 * - `MAX_DETECTION_WORKERS` (3) is the ceiling: detection is ML-bound, so
 *   more lanes add contention without throughput (same P3 rationale as
 *   sharding: K = clamp, device-aware).
 * - `MANY_CORE_DETECTION_THRESHOLD` (8): `hardwareConcurrency >= 8` → 3
 *   lanes, otherwise 2 — byte-for-byte the `imageSharding.ts` CPU rule.
 * - `LOW_MEMORY_GB_THRESHOLD` (2): `deviceMemory <= 2` → 1 lane.
 *   `deviceMemory` is the bucketed Client Hints value
 *   (0.25/0.5/1/2/4/8); absent → ignored, CPU rule decides.
 * - `LOW_CPU_COUNT_THRESHOLD` (2): `hardwareConcurrency <= 2` → 1 lane.
 *
 * Pure: no DOM and no React. Live `navigator` values are read only when the
 * corresponding `opts` field is omitted, guarded for SSR/node (no navigator).
 */
export const MIN_DETECTION_WORKERS = 1;
export const MAX_DETECTION_WORKERS = 3;
export const MANY_CORE_DETECTION_THRESHOLD = 8;
export const LOW_MEMORY_GB_THRESHOLD = 2;
export const LOW_CPU_COUNT_THRESHOLD = 2;

export interface DetectionWorkerOptions {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  pageCount?: number;
}

function readLiveHardwareConcurrency(): number | undefined {
  try {
    const value = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readLiveDeviceMemory(): number | undefined {
  try {
    const value =
      typeof navigator !== 'undefined'
        ? (navigator as unknown as { deviceMemory?: unknown }).deviceMemory
        : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pure policy: how many parallel detection lanes for a review-time run.
 * Clamped to `MIN_DETECTION_WORKERS..MAX_DETECTION_WORKERS`. Exported for
 * unit tests and review-time scheduling.
 *
 * K-lane hygiene (2026-10-11): pass the PENDING (still-undetected) entry
 * count as `pageCount`, NOT the total queue length — a revisit with 1
 * queued page out of 8 total must resolve 1 lane, not over-provision 2–3
 * workers whose sessions warm for nothing. The single-page rule below is
 * exactly that case (`pageCount <= 1` → serial).
 */
export function resolveDetectionWorkerCount(opts?: DetectionWorkerOptions): number {
  if (opts?.pageCount !== undefined && opts.pageCount <= 1) return MIN_DETECTION_WORKERS;
  const deviceMemory = opts?.deviceMemory ?? readLiveDeviceMemory();
  if (deviceMemory !== undefined && deviceMemory <= LOW_MEMORY_GB_THRESHOLD) {
    return MIN_DETECTION_WORKERS;
  }
  const concurrency = opts?.hardwareConcurrency ?? readLiveHardwareConcurrency();
  if (concurrency !== undefined && concurrency <= LOW_CPU_COUNT_THRESHOLD) {
    return MIN_DETECTION_WORKERS;
  }
  const workers =
    concurrency !== undefined && concurrency >= MANY_CORE_DETECTION_THRESHOLD
      ? MAX_DETECTION_WORKERS
      : MIN_DETECTION_WORKERS + 1;
  return Math.min(MAX_DETECTION_WORKERS, Math.max(MIN_DETECTION_WORKERS, workers));
}
