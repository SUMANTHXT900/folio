/**
 * Detector policy for the scanic scan core (D35): ML first, classical a
 * silent fallback.
 *
 * The self-hosted ML detector (DocCornerNet via scanic; assets vendored
 * same-origin under `/assets/scanic-ml/`, D34) is the DEFAULT because it is
 * dramatically better on real photos; the classical Canny pipeline runs only
 * when ML cannot produce corners. This module is shared by the main thread
 * (client/UI) and the scan worker: it uses no DOM and no React, and each JS
 * context warms its own scanic ML session.
 *
 * `warmMlDetector()` is a fire-and-forget preload for scanner open: it loads
 * the ORT runtime chunk + model bytes, creates the session, and runs one
 * inference; it resolves `true` when the ML pipeline is usable in this
 * context, `false` on any failure (the caller falls back silently). Success
 * is cached; failure is retried by the next call.
 */

import type { ScanicDetectorKind } from './scanicProtocol';

/** ML is the default detector (D35); classical is the silent fallback. */
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
 */
export const ML_DETECTOR_OPTIONS = {
  assetBaseUrl: ML_ASSET_BASE_URL,
  numThreads: 1,
} as const;

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
    // the caller can fall back silently.
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
 * Detector for one attempt: ML when preferred AND expected to work
 * (`mlReady` false means a warm preload already proved ML unavailable in
 * this context), classical otherwise. Callers that send `'ml'` get the
 * worker's one-shot classical fallback for free; this helper is for choosing
 * a single preferred detector up front.
 */
export function detectorForAttempt(preferMl: boolean, mlReady: boolean): ScanicDetectorKind {
  return preferMl && mlReady ? 'ml' : 'classical';
}

/**
 * Default detector for this context: ML unless a warm preload here already
 * proved it unavailable (then classical, silently). This is the resolution
 * `ScanicClient.detect()` uses when the caller names no detector.
 */
export function defaultDetector(): ScanicDetectorKind {
  return detectorForAttempt(DEFAULT_DETECTOR === 'ml', mlDetectorWarmState() !== 'failed');
}
