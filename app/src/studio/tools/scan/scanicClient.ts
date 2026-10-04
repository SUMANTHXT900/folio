/**
 * Main-thread client for the scanic scan worker (D34/D35).
 *
 * ```text
 * useScanicProcessor / UI
 *   │  detect(image) / redetect(image) / extract(image, corners)   (Promise)
 *   ▼
 * ScanicClient (this file: lazy worker, epoch guards, cancel-by-terminate)
 *   │  postMessage with the ImageData pixels as TRANSFERRED ArrayBuffer
 *   ▼
 * scanic.worker.ts (scanic Scanner init-once, ML-first + warp)
 * ```
 *
 * Runtime status (D34/D35): the shipped UI still calls scanic directly on the
 * main thread; this client + worker core is the tested swap foundation for
 * background processing — adopting it must keep the review UI's DOM contract
 * unchanged.
 *
 * Ownership rules:
 * - `detect()` and `extract()` TRANSFER the image's pixel buffer
 *   (neuter-on-send): the caller must treat the passed ImageData as
 *   consumed after the call. Views over a larger buffer are copied to
 *   their exact range first so only the image's own bytes ever cross.
 * - One worker per client, created lazily on first use and reused
 *   (init-once). `terminate()` is terminate-to-cancel: pending requests
 *   reject with code `cancelled`, the epoch advances so late results from
 *   the dead generation are dropped, and the NEXT request transparently
 *   recreates the worker.
 */

import { DEFAULT_DETECTOR, defaultDetector } from './detectorPolicy';
import {
  SCANIC_WORKER_PROTOCOL_VERSION,
  validateScanicCorners,
  type ScanicCorners,
  type ScanicDetectionResult,
  type ScanicDetectorKind,
  type ScanicDetectRequest,
  type ScanicExtractRequest,
  type ScanicWorkerRequest,
  type ScanicWorkerResponse,
} from './scanicProtocol';

export type ScanicClientErrorCode =
  'cancelled' | 'invalid-corners' | 'worker-crashed' | 'worker-unavailable' | 'worker-response';

export class ScanicClientError extends Error {
  constructor(
    readonly code: ScanicClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScanicClientError';
  }
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL('./scanic.worker.ts', import.meta.url), { type: 'module' });
}

interface PendingScanicRequest {
  settle(response: ScanicWorkerResponse): void;
  fail(error: Error): void;
  epoch: number;
}

/** Test/platform seams and the ML-first detector resolution for `detect()`. */
export interface ScanicClientOptions {
  /** Test seam: a factory for worker doubles; defaults to the module worker. */
  createWorker?: () => Worker;
  /**
   * Resolves the detector for a `detect()` call made without an explicit
   * one. Defaults to the ML-first policy: ML, unless a warm preload in this
   * context already proved ML unavailable (then classical, silently — see
   * `detectorPolicy.ts`). `redetect()` ignores this seam.
   */
  defaultDetector?: () => ScanicDetectorKind;
}

export class ScanicClient {
  private worker: Worker | null = null;
  /** Worker generation; any worker loss bumps it so late results are stale. */
  private epoch = 0;
  private requestSeq = 0;
  private readonly pending = new Map<number, PendingScanicRequest>();
  private droppedCount = 0;
  private readonly createWorker: () => Worker;
  private readonly defaultDetector: () => ScanicDetectorKind;

  constructor(options: ScanicClientOptions = {}) {
    this.createWorker = options.createWorker ?? defaultCreateWorker;
    this.defaultDetector = options.defaultDetector ?? defaultDetector;
  }

  /** Diagnostic count of dropped malformed/stale worker messages (no UI). */
  get droppedMessages(): number {
    return this.droppedCount;
  }

  /**
   * Terminate-to-cancel: the worker dies (a synchronous in-worker scan
   * cannot observe cooperative cancellation), pending requests reject as
   * `cancelled`, the epoch advances so late results are discarded, and the
   * next request transparently recreates the worker.
   */
  terminate(): void {
    if (this.worker === null && this.pending.size === 0) {
      return;
    }
    this.epoch += 1;
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.destroyWorker();
    for (const request of pending) {
      request.fail(
        new ScanicClientError('cancelled', 'scanic request cancelled (worker terminated)'),
      );
    }
  }

  /**
   * Document detection on a full-resolution ImageData, ML-first. With no
   * explicit detector the policy default applies: ML, unless a warm preload
   * already proved ML unavailable in this context (then classical, silently).
   * The worker answers `'ml'` requests with one classical fallback on ANY ML
   * failure, and the result names the detector behind the corners. The
   * image's pixel buffer is transferred (the caller's ImageData is
   * neutered); corners come back in FULL-RESOLUTION input pixels and
   * `confidence` is scanic's own 0–1 confidence (null when unavailable).
   */
  async detect(image: ImageData, detector?: ScanicDetectorKind): Promise<ScanicDetectionResult> {
    const id = this.nextRequestId();
    const request: ScanicDetectRequest = {
      protocol: SCANIC_WORKER_PROTOCOL_VERSION,
      kind: 'detect',
      id,
      width: image.width,
      height: image.height,
      buffer: toExactBuffer(image),
      detector: detector ?? this.defaultDetector(),
    };
    const response = await this.dispatch(request, [request.buffer]);
    if (response.kind !== 'detect-result') {
      throw new ScanicClientError(
        'worker-response',
        'scanic worker returned a mismatched detect response',
      );
    }
    return response.result;
  }

  /**
   * Fresh detection for the adjust screen's Re-detect action: forces the ML
   * attempt, bypassing the cached warm-failure fallback that `detect()` may
   * have applied. The request itself keeps the worker's ML-then-classical
   * fallback policy; detection results are never cached, so this is the
   * explicit re-run. The image's pixel buffer transfers exactly like
   * `detect()`.
   */
  async redetect(image: ImageData): Promise<ScanicDetectionResult> {
    return this.detect(image, DEFAULT_DETECTOR);
  }

  /**
   * Full-resolution bilinear perspective warp of `image` with `corners`
   * (same pixel space). The image's pixel buffer is transferred (the
   * caller's ImageData is neutered); the resolved ImageData owns the
   * transferred warp output (output sized to the quad).
   *
   * Invalid (non-finite / collapsed) corners are rejected BEFORE any bytes
   * are transferred, so the caller keeps its image on that path.
   */
  async extract(image: ImageData, corners: ScanicCorners): Promise<ImageData> {
    const cornersError = validateScanicCorners(corners);
    if (cornersError !== null) {
      throw new ScanicClientError(
        'invalid-corners',
        `scanic extract rejected corners: ${cornersError}`,
      );
    }
    const id = this.nextRequestId();
    const request: ScanicExtractRequest = {
      protocol: SCANIC_WORKER_PROTOCOL_VERSION,
      kind: 'extract',
      id,
      width: image.width,
      height: image.height,
      buffer: toExactBuffer(image),
      corners,
    };
    const response = await this.dispatch(request, [request.buffer]);
    if (response.kind !== 'extract-result') {
      throw new ScanicClientError(
        'worker-response',
        'scanic worker returned a mismatched extract response',
      );
    }
    const expectedBytes = response.width * response.height * 4;
    if (
      !Number.isInteger(response.width) ||
      !Number.isInteger(response.height) ||
      response.width <= 0 ||
      response.height <= 0 ||
      response.buffer.byteLength !== expectedBytes
    ) {
      throw new ScanicClientError(
        'worker-response',
        `scanic worker returned a malformed warp buffer (${response.width}x${response.height}, ${response.buffer.byteLength} bytes)`,
      );
    }
    return new ImageData(new Uint8ClampedArray(response.buffer), response.width, response.height);
  }

  // -- internals ------------------------------------------------------------

  private nextRequestId(): number {
    this.requestSeq += 1;
    return this.requestSeq;
  }

  private ensureWorker(): Worker {
    if (this.worker !== null) {
      return this.worker;
    }
    const worker = this.createWorker();
    const epoch = this.epoch;
    worker.onmessage = (event: MessageEvent<unknown>): void => {
      this.route(epoch, event.data);
    };
    worker.onerror = (event: ErrorEvent): void => {
      this.handleWorkerFailure(epoch, event);
    };
    this.worker = worker;
    return worker;
  }

  private dispatch(
    request: ScanicWorkerRequest,
    transfer: Transferable[],
  ): Promise<ScanicWorkerResponse> {
    return new Promise<ScanicWorkerResponse>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = this.ensureWorker();
      } catch (error) {
        reject(
          new ScanicClientError(
            'worker-unavailable',
            error instanceof Error ? error.message : 'scanic worker could not be created',
          ),
        );
        return;
      }
      this.pending.set(request.id, { settle: resolve, fail: reject, epoch: this.epoch });
      try {
        worker.postMessage(request, transfer);
      } catch (error) {
        this.pending.delete(request.id);
        reject(
          new ScanicClientError(
            'worker-unavailable',
            error instanceof Error ? error.message : 'scanic worker postMessage failed',
          ),
        );
      }
    });
  }

  private route(workerEpoch: number, data: unknown): void {
    if (data === null || typeof data !== 'object') {
      this.droppedCount += 1;
      return;
    }
    const message = data as {
      protocol?: unknown;
      kind?: unknown;
      id?: unknown;
      message?: unknown;
    };
    if (message.protocol !== SCANIC_WORKER_PROTOCOL_VERSION) {
      this.droppedCount += 1;
      return;
    }
    if (
      message.kind !== 'detect-result' &&
      message.kind !== 'extract-result' &&
      message.kind !== 'error'
    ) {
      this.droppedCount += 1;
      return;
    }
    if (typeof message.id !== 'number') {
      this.droppedCount += 1;
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      this.droppedCount += 1; // Unknown or already-settled request: discard.
      return;
    }
    if (workerEpoch !== this.epoch || pending.epoch !== this.epoch) {
      // Superseded worker generation: settle as cancelled, never as data.
      this.pending.delete(message.id);
      pending.fail(
        new ScanicClientError('cancelled', 'scanic result dropped (worker generation changed)'),
      );
      return;
    }
    this.pending.delete(message.id);
    if (message.kind === 'error') {
      pending.fail(
        new Error(typeof message.message === 'string' ? message.message : 'scanic worker failed'),
      );
      return;
    }
    pending.settle(data as ScanicWorkerResponse);
  }

  private handleWorkerFailure(workerEpoch: number, event: ErrorEvent): void {
    if (workerEpoch !== this.epoch) {
      return; // A dead generation's failure: already handled.
    }
    this.epoch += 1;
    this.destroyWorker();
    const message =
      typeof event.message === 'string' && event.message !== ''
        ? event.message
        : 'scanic worker error (see browser console)';
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      request.fail(new ScanicClientError('worker-crashed', message));
    }
  }

  private destroyWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) {
      try {
        worker.terminate();
      } catch {
        // Termination is best-effort; the reference is dropped regardless.
      }
    }
  }
}

/**
 * Module-level shared client for `redetect()` callers that do not own a
 * client (the adjust screen's Re-detect button): the backing worker is
 * created lazily on first use and reused across calls. Same ML-forcing
 * semantics as `ScanicClient.redetect`; the image's pixel buffer transfers.
 */
let sharedClient: ScanicClient | null = null;

export function redetect(image: ImageData): Promise<ScanicDetectionResult> {
  if (sharedClient === null) {
    sharedClient = new ScanicClient();
  }
  return sharedClient.redetect(image);
}

/**
 * The buffer to transfer for an ImageData. Normally the image owns its exact
 * buffer already; a view over a larger buffer is copied down to its exact
 * range so only the image's own bytes are ever transferred.
 */
function toExactBuffer(image: ImageData): ArrayBuffer {
  const data = image.data;
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data.buffer;
  }
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}
