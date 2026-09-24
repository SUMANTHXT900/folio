/**
 * ScanWorkerClient: main-thread gateway to the dedicated scan worker.
 *
 * - Lazily creates ONE worker per client (`new Worker(scan.worker.ts)`);
 *   the WASM module initializes once and is reused for every job.
 * - `process()` transfers input bytes (the caller's buffer is NEUTERED —
 *   never touched after posting) and resolves a terminal `ScanResult`.
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

export type ScanStatus = 'processed' | 'original' | 'error';

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
  /** Detected corners in input coordinates (processed only). */
  corners: ScanCorner[] | null;
  /** Earned detection confidence (processed only). */
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

export class ScanWorkerClient {
  private worker: Worker | null = null;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private failReason: string | null = null;
  private jobCounter = 0;
  private epoch = 0;
  private pending = new Map<string, Pending>();

  constructor(private readonly createWorker: ScanWorkerFactory = defaultCreateWorker) {}

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

  /** Runs one scan job. The input buffer is TRANSFERRED (neutered). */
  process(input: Uint8Array, mode: ScanModeName): Promise<ScanResult> {
    const jobId = `scan-${(this.jobCounter += 1)}`;
    const epoch = this.epoch;
    const startedAt = performance.now();
    return new Promise<ScanResult>((resolve, reject) => {
      const job: Pending = { resolve, reject, startedAt, epoch, mode, settled: false };
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
        // touch `input` (or its buffer) after this line. Views over a
        // larger buffer are copied to their exact range first so only
        // the job's own bytes ever cross.
        const exact = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength;
        const buffer = (
          exact
            ? input.buffer
            : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
        ) as ArrayBuffer;
        this.worker?.postMessage(
          { protocol: SCAN_PROTOCOL_VERSION, kind: 'process', jobId, buffer, mode },
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
    if (msg === null) return; // Malformed framing: ignore, never throw.
    switch (msg.kind) {
      case 'ready':
        this.ready = true;
        this.failReason = null;
        this.flushReady();
        break;
      case 'status':
        break; // Coarse phase only; surfaced via future UI if needed.
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
    if (job === undefined || job.settled) return;
    // Stale epoch (terminated/restarted since): discard, never mutate.
    if (job.epoch !== this.epoch) {
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
      corners?: Array<{ x?: number; y?: number }> | null;
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
    if (parsed.status === 'processed') {
      const corners =
        parsed.corners
          ?.filter((c) => typeof c?.x === 'number' && typeof c?.y === 'number')
          .map((c) => ({ x: c.x as number, y: c.y as number })) ?? null;
      job.resolve({
        ...base,
        status: 'processed',
        corners: corners !== null && corners.length === 4 ? corners : null,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        reason: null,
        code: null,
        message: null,
        bytes: msg.output !== undefined ? new Uint8Array(msg.output) : null,
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
