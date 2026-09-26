/**
 * ScanWorkerClient: main-thread gateway to the dedicated scan worker.
 *
 * - Lazily creates ONE worker per client (`new Worker(scan.worker.ts)`);
 *   the WASM module initializes once and is reused for every job.
 * - `process()` transfers input bytes (the caller's buffer is NEUTERED —
 *   never touched after posting) and resolves a terminal `ScanResult`.
 *   `detectOnly` requests stop after detection (status `detected`, no
 *   output bytes); the shutter always runs the full pipeline.
 * - Generation safety (§5): every client owns a monotonic `epoch`,
 *   bumped by `terminate()`. Results from older epochs are DISCARDED —
 *   a stale scan can never create/update a page, replace a preview, or
 *   resurrect a closed session. Termination rejects pending jobs as
 *   cancelled; the next `process()` transparently recreates the worker.
 *
 * Worker factory is injectable for unit tests (FakeWorker pattern, same
 * as `WasmWorkerEngineAdapter`). The real worker+WASM path is covered by
 * E2E/benchmark harnesses, never mocked here.
 */

import {
  SCAN_PROTOCOL_VERSION,
  parseScanMessage,
  type ScanModeName,
  type ScanWorkerToMain,
} from './scanProtocol';

export type ScanStatus = 'processed' | 'detected' | 'original' | 'error';

export interface ScanCorner {
  x: number;
  y: number;
}

export interface ScanResult {
  status: ScanStatus;
  jobId: string;
  width: number;
  height: number;
  mode: ScanModeName;
  /** Detected corners in input coordinates (processed/detected only). */
  corners: ScanCorner[] | null;
  /** Earned detection confidence (processed/detected only). */
  confidence: number;
  /** Fallback reason (original only, e.g. `no-document-detected`). */
  reason: string | null;
  /** Error code/message (error only). */
  code: string | null;
  message: string | null;
  /** Output JPEG bytes (processed only). Fresh buffer, owned by caller. */
  bytes: Uint8Array | null;
  /** Client-measured wall time incl. transfer (ms). */
  wallMs: number;
}

interface Pending {
  resolve: (r: ScanResult) => void;
  reject: (e: Error) => void;
  startedAt: number;
  epoch: number;
  mode: ScanModeName;
  detectOnly: boolean;
  settled: boolean;
}

export interface ScanWorkerFactory {
  (): Worker;
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL('./scan.worker.ts', import.meta.url), { type: 'module' });
}

function terminalError(
  jobId: string,
  mode: ScanModeName,
  code: string,
  message: string,
): ScanResult {
  return {
    status: 'error',
    jobId,
    width: 0,
    height: 0,
    mode,
    corners: null,
    confidence: 0,
    reason: null,
    code,
    message,
    bytes: null,
    wallMs: 0,
  };
}

/**
 * Reads detection corners from an envelope. The WASM glue emits
 * `[[x, y], …]` pairs; `{x, y}` objects are accepted too (test doubles
 * and older fixtures). Anything that is not four readable points → null.
 */
function parseCorners(raw: unknown): ScanCorner[] | null {
  if (!Array.isArray(raw)) return null;
  const points: ScanCorner[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry)) {
      const [x, y] = entry as unknown[];
      if (typeof x === 'number' && typeof y === 'number') points.push({ x, y });
    } else if (typeof entry === 'object' && entry !== null) {
      const point = entry as { x?: unknown; y?: unknown };
      if (typeof point.x === 'number' && typeof point.y === 'number') {
        points.push({ x: point.x, y: point.y });
      }
    }
  }
  return points.length === 4 ? points : null;
}

export class ScanWorkerClient {
  private worker: Worker | null = null;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private failReason: string | null = null;
  private jobCounter = 0;
  private epoch = 0;
  private pending = new Map<string, Pending>();
  /**
   * Silently-dropped worker messages (malformed framing, legacy `status`,
   * unknown/settled results, stale epochs). Diagnostic only — no UI reads
   * this; unit tests assert it so nothing vanishes uncounted.
   */
  private droppedCount = 0;

  constructor(private readonly createWorker: ScanWorkerFactory = defaultCreateWorker) {}

  /** Diagnostic count of silently-dropped worker messages (no UI). */
  get droppedMessages(): number {
    return this.droppedCount;
  }

  /** Terminates the worker: pending jobs reject as cancelled, the epoch
   * advances so late results are discarded, and the next job recreates. */
  terminate(): void {
    this.epoch += 1;
    this.failReason = null;
    try {
      this.worker?.terminate();
    } catch {
      // Best effort.
    }
    this.worker = null;
    this.ready = false;
    for (const [jobId, job] of this.pending) {
      if (!job.settled) {
        job.settled = true;
        job.reject(
          Object.assign(new Error(`scan job ${jobId} cancelled (worker terminated)`), {
            code: 'SCAN_CANCELLED',
          }),
        );
      }
    }
    this.pending.clear();
  }

  /**
   * Explicit disposal. Identical to `terminate()`: cancel-by-terminate is
   * the audit-accepted mechanism (a synchronous WASM call cannot observe
   * cooperative cancellation mid-flight), so disposal terminates the
   * worker, rejects pending jobs as cancelled, and advances the epoch so
   * late results are discarded. The client stays reusable — the next
   * `process()` transparently recreates the worker.
   */
  dispose(): void {
    this.terminate();
  }

  /**
   * Runs one scan job. The input buffer is TRANSFERRED (neutered).
   * `detectOnly` selects the live-guidance fast path (no warp/encode,
   * no output bytes; resolves with status `detected`).
   *
   * Concurrency note (single-flight lives with the caller): the worker
   * executes one synchronous WASM call at a time and serves jobs in
   * arrival order; this client does NOT serialize — concurrent `process()`
   * calls each get a job id and resolve independently. Callers needing
   * latest-frame-only semantics (live guidance) must gate themselves
   * (cf. `useScanProcessor`'s live-pending flag).
   */
  process(input: Uint8Array, mode: ScanModeName, detectOnly = false): Promise<ScanResult> {
    const jobId = `scan-${(this.jobCounter += 1)}`;
    const epoch = this.epoch;
    const startedAt = performance.now();
    return new Promise<ScanResult>((resolve, reject) => {
      const job: Pending = {
        resolve,
        reject,
        startedAt,
        epoch,
        mode,
        detectOnly,
        settled: false,
      };
      this.pending.set(jobId, job);
      this.ensureWorker();
      this.whenReady(() => {
        const current = this.pending.get(jobId);
        if (current === undefined || current.settled) return;
        if (this.failReason !== null) {
          current.settled = true;
          this.pending.delete(jobId);
          current.resolve(terminalError(jobId, mode, 'init-failed', this.failReason));
          return;
        }
        // Transfer: ownership moves to the worker; the caller must never
        // touch `input` (or its buffer) after this line. Exact-range guard
        // (mirrors `WasmWorkerEngineAdapter`): views over a larger buffer
        // are copied to their exact range first so only the job's own
        // bytes ever cross.
        const exact = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength;
        const buffer = (
          exact
            ? input.buffer
            : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
        ) as ArrayBuffer;
        this.worker?.postMessage(
          {
            protocol: SCAN_PROTOCOL_VERSION,
            kind: 'process',
            jobId,
            buffer,
            mode,
            detectOnly: job.detectOnly,
          },
          [buffer],
        );
      });
    });
  }

  private ensureWorker(): void {
    if (this.worker !== null) return;
    const worker = this.createWorker();
    this.worker = worker;
    this.ready = false;
    worker.onmessage = (ev: MessageEvent) => this.route(ev.data);
    worker.onerror = (ev: ErrorEvent) => {
      this.failReason = ev.message || 'scan worker error';
      this.flushInitFailure();
    };
  }

  private whenReady(fn: () => void): void {
    if (this.ready && this.failReason === null) {
      fn();
      return;
    }
    if (this.failReason !== null) {
      fn();
      return;
    }
    this.readyWaiters.push(fn);
  }

  private flushInitFailure(): void {
    const waiters = this.readyWaiters.splice(0);
    for (const fn of waiters) fn();
  }

  private route(data: unknown): void {
    const msg = parseScanMessage(data);
    if (msg === null) {
      this.droppedCount += 1; // Malformed framing: ignore, never throw.
      return;
    }
    switch (msg.kind) {
      case 'ready':
        this.ready = true;
        this.failReason = null;
        this.flushReady();
        break;
      case 'status':
        // No UI consumer (the worker no longer sends these): ignored and
        // counted. Branch retained for forward compatibility.
        this.droppedCount += 1;
        break;
      case 'result':
        this.finish(msg);
        break;
      case 'fatal':
        this.onFatal(msg.jobId, msg.message);
        break;
    }
  }

  private flushReady(): void {
    const waiters = this.readyWaiters.splice(0);
    for (const fn of waiters) fn();
  }

  private finish(msg: Extract<ScanWorkerToMain, { kind: 'result' }>): void {
    const job = this.pending.get(msg.jobId);
    if (job === undefined || job.settled) {
      this.droppedCount += 1; // Unknown or already-settled job: discard.
      return;
    }
    // Stale epoch (terminated/restarted since): discard, never mutate.
    if (job.epoch !== this.epoch) {
      this.droppedCount += 1;
      job.settled = true;
      this.pending.delete(msg.jobId);
      job.reject(
        Object.assign(new Error(`scan job ${msg.jobId} is stale (worker restarted)`), {
          code: 'SCAN_STALE',
        }),
      );
      return;
    }
    job.settled = true;
    this.pending.delete(msg.jobId);
    let parsed: {
      status?: string;
      width?: number;
      height?: number;
      mode?: string;
      corners?: unknown;
      confidence?: number;
      reason?: string;
      code?: string;
      message?: string;
    };
    try {
      parsed = JSON.parse(msg.resultJson) as typeof parsed;
    } catch {
      job.resolve(
        terminalError(msg.jobId, job.mode, 'bad-envelope', 'scan worker returned unreadable JSON'),
      );
      return;
    }
    const wallMs = performance.now() - job.startedAt;
    const base = {
      jobId: msg.jobId,
      width: typeof parsed.width === 'number' ? parsed.width : 0,
      height: typeof parsed.height === 'number' ? parsed.height : 0,
      mode: job.mode,
      wallMs,
    };
    const corners = parseCorners(parsed.corners);
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    if (parsed.status === 'processed') {
      job.resolve({
        ...base,
        status: 'processed',
        corners,
        confidence,
        reason: null,
        code: null,
        message: null,
        // Defensive: a detect-only job may never deliver bytes.
        bytes: !job.detectOnly && msg.output !== undefined ? new Uint8Array(msg.output) : null,
      });
      return;
    }
    if (parsed.status === 'detected') {
      // Live-guidance fast path: corners/confidence only, never bytes.
      job.resolve({
        ...base,
        status: 'detected',
        corners,
        confidence,
        reason: null,
        code: null,
        message: null,
        bytes: null,
      });
      return;
    }
    if (parsed.status === 'original') {
      job.resolve({
        ...base,
        status: 'original',
        corners: null,
        confidence: 0,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'no-document-detected',
        code: null,
        message: null,
        bytes: null,
      });
      return;
    }
    job.resolve({
      ...base,
      status: 'error',
      corners: null,
      confidence: 0,
      reason: null,
      code: typeof parsed.code === 'string' ? parsed.code : 'unknown',
      message: typeof parsed.message === 'string' ? parsed.message : 'scan failed',
      bytes: null,
    });
  }

  private onFatal(jobId: string | null, message: string): void {
    // Fatal poisons this worker instance: fail pending jobs, drop the
    // worker so the next job recreates cleanly (never a broken worker).
    this.failReason = message;
    try {
      this.worker?.terminate();
    } catch {
      // Best effort.
    }
    this.worker = null;
    this.ready = false;
    for (const [id, job] of this.pending) {
      if (job.settled) continue;
      job.settled = true;
      if (jobId === null || id === jobId) {
        job.resolve(terminalError(id, job.mode, 'worker-fatal', message));
      } else {
        job.reject(
          Object.assign(new Error(`scan job ${id} aborted (worker fatal)`), {
            code: 'SCAN_ABORTED',
          }),
        );
      }
    }
    this.pending.clear();
    this.flushInitFailure();
  }
}
