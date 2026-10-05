/// <reference lib="webworker" />
/**
 * scanic scan worker: all document detection + warping runs here, off the
 * main thread.
 *
 * ```text
 * Main thread (ScanicClient, see scanicClient.ts)
 *   │  detect:  full-res ImageData → scanic ML detection (miss = full frame)
 *   │  extract: full-res ImageData + full-res quad → bilinear warp
 *   ▼
 * this worker: scanic Scanner (init-once), OffscreenCanvas, no DOM
 * ```
 *
 * Runtime status (D34/D35/D46): capture detection + warp run through this
 * worker via `ScanicClient`; the review UI's DOM contract is unchanged.
 *
 * Environment contract:
 * - ImageData input only (never DOM elements). A detection-level throw is
 *   mapped to a normal "no detection" result so a capture always keeps its
 *   original.
 * - Detection downscales internally (scanic default ≤800px) and returns
 *   corners already scaled back to the FULL-RESOLUTION input dimensions.
 * - `extract` uses the DOM-free warp in `scanicWarp.ts` (scanic's own
 *   extract path builds a `<canvas>` and cannot run in a worker).
 * - ML is the ONLY detector (D35 default, D46 classical removed): requests
 *   use the self-hosted `/assets/scanic-ml/` assets on 1 thread, any ML
 *   miss resolves to the full frame, and every result reports `detector:
 *   'ml'`. The worker warms its own ML session on startup.
 */

import { Scanner } from 'scanic';
import { warmMlDetector } from './detectorPolicy';
import { runScanicDetection } from './scanicDetection';
import {
  SCANIC_WORKER_PROTOCOL_VERSION,
  isScanicDetectorKind,
  validateScanicCorners,
  type ScanicDetectRequest,
  type ScanicExtractRequest,
  type ScanicWorkerRequest,
  type ScanicWorkerResponse,
} from './scanicProtocol';
import { warpImageData } from './scanicWarp';

declare const self: DedicatedWorkerGlobalScope;

/** scanic's default processing ceiling; corners come back in input space. */
const MAX_PROCESSING_DIMENSION = 800;

const scanner = new Scanner({ maxProcessingDimension: MAX_PROCESSING_DIMENSION });

/**
 * Init-once, best-effort: scans share the one scanner (and its one warmed
 * WASM instance). A failed warmup resolves anyway — scanic's pipeline falls
 * back to pure JS, so detection stays available.
 */
const scannerReady: Promise<void> = scanner.initialize().catch(() => undefined);

/**
 * Fire-and-forget ML preload for THIS worker context: the ORT runtime + model
 * bytes load at startup, and the first ML detect reuses the in-flight
 * session. Failure is silent — the detection path still attempts ML, and a
 * miss resolves to the full frame.
 */
void warmMlDetector();

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
  // ML-only (D46); never throws and always names the detector behind
  // the result.
  const result = await runScanicDetection(scanner, image, request.detector);
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
