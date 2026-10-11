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
 * scanic.worker.ts (scanic Scanner init-once, ML-only + warp)
 * ```
 *
 * Runtime status (D34/D35/D46): capture detection + warp run through this
 * client; the review UI's DOM contract is unchanged.
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

import { DEFAULT_DETECTOR, ML_MODEL_INPUT_SIZE, defaultDetector } from './detectorPolicy';
import {
  SCANIC_WORKER_PROTOCOL_VERSION,
  validateScanicCorners,
  type ScanicCorners,
  type ScanicDetectInstrumentation,
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
   * one. Defaults to the policy default: ML, unconditionally (D46).
   * `redetect()` ignores this seam.
   */
  defaultDetector?: () => ScanicDetectorKind;
}

/**
 * Caller-supplied measurement into `ScanicClient.detect()` (additive —
 * existing two-argument calls are untouched).
 */
export interface ScanicClientDetectOptions {
  /**
   * Main-thread decode cost in ms for the image being detected. Reported as
   * `instrumentation.decodeMs`; null/omitted when unknown. Log/collect
   * only — never changes detection behavior.
   */
  decodeMs?: number | null;
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
   * Document detection on a full-resolution ImageData, ML-only (D46). With
   * no explicit detector the policy default (ML) applies. An ML miss
   * resolves to `success: false` with null corners (the caller uses the
   * full frame). The image's pixel buffer is transferred (the caller's
   * ImageData is neutered); corners come back in FULL-RESOLUTION input
   * pixels and `confidence` is scanic's own 0–1 confidence (null when
   * unavailable).
   *
   * Instrumentation: the result always carries `instrumentation` (frozen
   * field names — see `scanicProtocol.ts`). The worker produces the
   * ORT-side fields; this client backfills the client-known ones
   * (`transferBytes`, dims) when the worker predates instrumentation, and
   * applies the caller-supplied `opts.decodeMs` when finite. Measure-only.
   */
  async detect(
    image: ImageData,
    detector?: ScanicDetectorKind,
    opts?: ScanicClientDetectOptions,
  ): Promise<ScanicDetectionResult> {
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
    const transferBytes = request.buffer.byteLength;
    const response = await this.dispatch(request, [request.buffer]);
    if (response.kind !== 'detect-result') {
      throw new ScanicClientError(
        'worker-response',
        'scanic worker returned a mismatched detect response',
      );
    }
    return withClientInstrumentation(response.result, {
      decodeMs: opts?.decodeMs ?? null,
      transferBytes,
      width: image.width,
      height: image.height,
    });
  }

  /**
   * Fresh detection for the adjust screen's Re-detect action: an explicit
   * ML re-run (detection results are never cached). The image's pixel
   * buffer transfers exactly like `detect()`.
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
 * Mount-lifetime retained detect client (no-regret ML pipeline, 2026-10-11).
 *
 * Factory name + release fn are FROZEN for the VF lane — do not rename.
 *
 * Created lazily on first `getRetainedDetectClient()` and reused across
 * drains, so review revisits + Re-detect skip cold session creates (ORT
 * runtime + model bytes + session stay warm in the retained worker). The
 * FIRST call's `options` win (subsequent calls reuse the live client —
 * pass the counting factory before first use in tests).
 *
 * Isolation rules (epoch/generation safety):
 * - NEVER terminate the retained client on drain cancel/completion — only
 *   `releaseRetainedDetectClient()` (mount unmount) may end it. A cancelled
 *   drain drops its continuations cooperatively (generation guards), never
 *   by terminating shared warmth; use `acquireDetectionPool()` so
 *   `releaseOwned()` terminates pool-owned lanes only.
 * - Terminate-on-unmount hygiene stays: the owner calls
 *   `releaseRetainedDetectClient()` when the scanner unmounts (same place
 *   owned per-mount clients are terminated today).
 */
let retainedDetectClient: ScanicClient | null = null;

export function getRetainedDetectClient(options: ScanicClientOptions = {}): ScanicClient {
  if (retainedDetectClient === null) {
    retainedDetectClient = new ScanicClient(options);
  }
  return retainedDetectClient;
}

/**
 * Explicit release for the retained detect client: terminate-to-cancel any
 * in-flight work and drop the reference so the next
 * `getRetainedDetectClient()` starts cold. Call on scanner unmount only —
 * never on drain cancel (see `getRetainedDetectClient`).
 */
export function releaseRetainedDetectClient(): void {
  const client = retainedDetectClient;
  retainedDetectClient = null;
  if (client !== null) {
    try {
      client.terminate();
    } catch {
      // Termination is best-effort; the reference is dropped regardless.
    }
  }
}

/**
 * Module-level shared `redetect()` for callers that do not own a client
 * (the adjust screen's Re-detect button): served by the retained client so
 * repeat Re-detects reuse the warm session. Same ML-forcing semantics as
 * `ScanicClient.redetect`; the image's pixel buffer transfers. The retained
 * lifetime applies — release happens via `releaseRetainedDetectClient()`.
 */
export function redetect(image: ImageData): Promise<ScanicDetectionResult> {
  return getRetainedDetectClient().redetect(image);
}

/**
 * K-lane detection pool that prefers the retained client (no-regret ML
 * pipeline, 2026-10-11). Pool SHAPE is unchanged: 1–3 lanes, each lane its
 * own `ScanicClient` (own worker + ORT session — no COOP/COEP needed);
 * only lane 0 is the shared mount-lifetime client when `preferRetained`
 * (default true) so a revisit drain reuses one warm session instead of
 * creating K cold ones.
 *
 * The caller still derives the lane count from PENDING entries via
 * `resolveDetectionWorkerCount({ pageCount: pending.length })` — this
 * helper only staffs the lanes, it never sizes them.
 *
 * Generation isolation: `releaseOwned()` terminates pool-owned lanes ONLY;
 * the retained lane survives for revisits/Re-detect. Drain cancel therefore
 * calls `releaseOwned()` (plus its generation bump), while unmount calls
 * `releaseOwned()` AND `releaseRetainedDetectClient()`.
 */
export interface DetectionPoolOptions {
  /** Test seam: worker factory for the retained + fresh lanes. */
  createWorker?: () => Worker;
  /**
   * Default true: lane 0 is `getRetainedDetectClient()`. False: every lane
   * is a fresh owned client (release terminates all).
   */
  preferRetained?: boolean;
}

export interface DetectionPool {
  /** Lane clients in order; lane `w` is `clients[w]` (direct — no modulo). */
  clients: ScanicClient[];
  /** Terminates pool-owned lanes only; the retained lane (if any) survives. */
  releaseOwned: () => void;
}

export function acquireDetectionPool(
  workerCount: number,
  options: DetectionPoolOptions = {},
): DetectionPool {
  const count = Math.max(1, Math.floor(Number.isFinite(workerCount) ? workerCount : 1));
  const preferRetained = options.preferRetained ?? true;
  const seams: ScanicClientOptions =
    options.createWorker !== undefined ? { createWorker: options.createWorker } : {};
  const clients: ScanicClient[] = [];
  const owned: ScanicClient[] = [];
  if (preferRetained) {
    clients.push(getRetainedDetectClient(seams));
  }
  while (clients.length < count) {
    const fresh = new ScanicClient(seams);
    clients.push(fresh);
    owned.push(fresh);
  }
  return {
    clients,
    releaseOwned: () => {
      for (const client of owned) {
        try {
          client.terminate();
        } catch {
          // Termination is best-effort; the reference is dropped regardless.
        }
      }
      owned.length = 0;
    },
  };
}

/**
 * Lane indexer for K-lane drains (hygiene cleanup, behavior-preserving):
 * stride-lane `workerIndex` values are always `< pool.length`, so lane `w`
 * is `pool[w]` directly — the old `pool[w % pool.length]` modulo was
 * vacuous and hid that invariant. Throws (never wraps) on an out-of-range
 * index so a mis-sized pool fails loudly instead of mis-detecting.
 */
export function detectionLaneClient(pool: ScanicClient[], workerIndex: number): ScanicClient {
  const client = pool[workerIndex];
  if (client === undefined) {
    throw new ScanicClientError(
      'worker-unavailable',
      `detection lane ${workerIndex} has no client (pool size ${pool.length})`,
    );
  }
  return client;
}

/**
 * Guarantees `instrumentation` on every detect result crossing this client:
 * worker-produced fields are kept (caller-supplied finite `decodeMs` wins
 * over the worker's null), and pre-instrumentation results (old workers,
 * test doubles) are backfilled from client-known transfer bytes + dims.
 * Everything unobservable from here stays null. Measure-only.
 */
function withClientInstrumentation(
  result: ScanicDetectionResult,
  known: { decodeMs: number | null; transferBytes: number; width: number; height: number },
): ScanicDetectionResult {
  const decodeMs =
    typeof known.decodeMs === 'number' && Number.isFinite(known.decodeMs) ? known.decodeMs : null;
  const existing = result.instrumentation;
  if (existing !== undefined) {
    if (decodeMs === null || existing.decodeMs === decodeMs) return result;
    return { ...result, instrumentation: { ...existing, decodeMs } };
  }
  const instrumentation: ScanicDetectInstrumentation = {
    decodeMs,
    transferBytes: known.transferBytes,
    ortLoadMs: null,
    sessionCreateMs: null,
    inferenceMs: null,
    confidence: typeof result.confidence === 'number' ? result.confidence : null,
    inputWidth: known.width,
    inputHeight: known.height,
    modelInputSize: ML_MODEL_INPUT_SIZE,
  };
  return { ...result, instrumentation };
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
