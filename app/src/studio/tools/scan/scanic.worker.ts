/// <reference lib="webworker" />
/**
 * scanic scan worker: all document detection + warping runs here, off the
 * main thread.
 *
 * ```text
 * Main thread (ScanicClient, see scanicClient.ts)
 *   │  detect:  full-res ImageData → scanic classical/ML detection
 *   │  extract: full-res ImageData + full-res quad → bilinear warp
 *   ▼
 * this worker: scanic Scanner (init-once), OffscreenCanvas, no DOM
 * ```
 *
 * Environment contract:
 * - ImageData input only (never DOM elements): scanic's classical pipeline
 *   uses `OffscreenCanvas` when available (`prepareScaleAndGrayscale`) and
 *   falls back to pure JS per stage when its optional WASM is unavailable —
 *   both are NORMAL paths, never fatal. A scanic-level throw is mapped to a
 *   normal "no detection" result so a capture always keeps its original.
 * - Detection downscales internally (scanic default ≤800px) and returns
 *   corners already scaled back to the FULL-RESOLUTION input dimensions.
 * - `extract` uses the DOM-free warp in `scanicWarp.ts` (scanic's own
 *   extract path builds a `<canvas>` and cannot run in a worker).
 * - ML (`detector: 'ml'`) is explicit opt-in: ORT is imported and the
 *   self-hosted `/assets/scanic-ml/` assets are fetched lazily on the FIRST
 *   ml call only, on 1 thread, with no COOP/COEP requirement.
 */

import { Scanner } from 'scanic';
import {
  SCANIC_WORKER_PROTOCOL_VERSION,
  isScanicDetectorKind,
  isValidScanicCorners,
  validateScanicCorners,
  type ScanicDetectionResult,
  type ScanicDetectRequest,
  type ScanicExtractRequest,
  type ScanicWorkerRequest,
  type ScanicWorkerResponse,
} from './scanicProtocol';
import { warpImageData } from './scanicWarp';

declare const self: DedicatedWorkerGlobalScope;

/**
 * Self-hosted ML assets (D34): same-origin dist of `scanic-ml@0.2.0`,
 * precached by the PWA at install — never a CDN (field scanning assumes
 * zero network). `numThreads: 1` is the Folio default (no COOP/COEP
 * isolation; ~13ms inference measured upstream).
 */
const ML_ASSET_BASE_URL = '/assets/scanic-ml/';

/** scanic's default processing ceiling; corners come back in input space. */
const MAX_PROCESSING_DIMENSION = 800;

const scanner = new Scanner({ maxProcessingDimension: MAX_PROCESSING_DIMENSION });

/**
 * Init-once, best-effort: scans share the one scanner (and its one warmed
 * WASM instance). A failed warmup resolves anyway — scanic's pipeline falls
 * back to pure JS, so detection stays available.
 */
const scannerReady: Promise<void> = scanner.initialize().catch(() => undefined);

function post(message: ScanicWorkerResponse, transfer?: Transferable[]): void {
  // Array form (not the options bag): supported by every worker runtime.
  if (transfer === undefined) {
    self.postMessage(message);
  } else {
    self.postMessage(message, transfer);
  }
}

function postError(id: number, error: unknown): void {
  post({
    protocol: SCANIC_WORKER_PROTOCOL_VERSION,
    kind: 'error',
    id,
    message: error instanceof Error ? error.message : 'scanic worker failure',
  });
}

function toImageData(buffer: ArrayBuffer, width: number, height: number): ImageData {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`scanic worker received invalid image dimensions (${width}x${height})`);
  }
  if (buffer.byteLength !== width * height * 4) {
    throw new Error(
      `scanic worker received ${buffer.byteLength} bytes for a ${width}x${height} RGBA image`,
    );
  }
  return new ImageData(new Uint8ClampedArray(buffer), width, height);
}

async function runDetect(request: ScanicDetectRequest): Promise<void> {
  await scannerReady;
  const image = toImageData(request.buffer, request.width, request.height);
  let result: ScanicDetectionResult;
  try {
    const detection = await scanner.scan(image, {
      mode: 'detect',
      detector: request.detector,
      ...(request.detector === 'ml'
        ? { ml: { assetBaseUrl: ML_ASSET_BASE_URL, numThreads: 1 } }
        : {}),
    });
    const corners =
      detection.success === true && isValidScanicCorners(detection.corners)
        ? detection.corners
        : null;
    result = {
      success: corners !== null,
      corners,
      confidence: typeof detection.confidence === 'number' ? detection.confidence : null,
    };
  } catch {
    // scanic-level failure (canvas backend missing, WASM instantiation
    // broken, …) is still a NORMAL outcome: no detection. The capture stays
    // an original photo; nothing here is fatal to the app.
    result = { success: false, corners: null, confidence: null };
  }
  post({
    protocol: SCANIC_WORKER_PROTOCOL_VERSION,
    kind: 'detect-result',
    id: request.id,
    result,
  });
}

async function runExtract(request: ScanicExtractRequest): Promise<void> {
  const cornersError = validateScanicCorners(request.corners);
  if (cornersError !== null) {
    throw new Error(`scanic extract rejected corners: ${cornersError}`);
  }
  const image = toImageData(request.buffer, request.width, request.height);
  const warped = warpImageData(image, request.corners);
  const buffer = warped.data.buffer;
  post(
    {
      protocol: SCANIC_WORKER_PROTOCOL_VERSION,
      kind: 'extract-result',
      id: request.id,
      width: warped.width,
      height: warped.height,
      buffer,
    },
    [buffer],
  );
}

function isScanicWorkerRequest(data: unknown): data is ScanicWorkerRequest {
  if (data === null || typeof data !== 'object') return false;
  const message = data as {
    protocol?: unknown;
    kind?: unknown;
    id?: unknown;
    width?: unknown;
    height?: unknown;
    buffer?: unknown;
    detector?: unknown;
  };
  if (message.protocol !== SCANIC_WORKER_PROTOCOL_VERSION) return false;
  if (typeof message.id !== 'number') return false;
  if (typeof message.width !== 'number' || typeof message.height !== 'number') return false;
  // An RGBA buffer crosses in as a transferred exact ArrayBuffer.
  if (!(message.buffer instanceof ArrayBuffer)) return false;
  if (message.kind === 'detect') return isScanicDetectorKind(message.detector);
  if (message.kind === 'extract') return true; // corners validated per-request.
  return false;
}

async function handleMessage(data: unknown): Promise<void> {
  if (!isScanicWorkerRequest(data)) {
    return; // Malformed framing is the client's bug: ignore, never throw.
  }
  try {
    if (data.kind === 'detect') {
      await runDetect(data);
    } else {
      await runExtract(data);
    }
  } catch (error) {
    postError(data.id, error);
  }
}

self.onmessage = (event: MessageEvent<unknown>): void => {
  void handleMessage(event.data);
};
