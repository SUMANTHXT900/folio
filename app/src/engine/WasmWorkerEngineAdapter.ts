/**
 * Real browser engine adapter: React → Web Worker → Rust/WASM.
 *
 * ```text
 * Developer Console (this adapter, main thread)
 *   │  postMessage (inputs as TRANSFERRED ArrayBuffers) / terminate
 *   ▼
 * Web Worker (engine.worker.ts, init-once WASM module + WasmEngine)
 *   │  synchronous execute (blocking the worker is by design)
 *   ▼
 * Real Rust Engine (WASM) → lopdf
 * ```
 *
 * Everything surfaced is authoritative engine data: real `job-N` ids,
 * real progress fractions, real monotonic engine durations, real
 * structured errors, real output PDFs (transferred buffers registered in
 * the binary store — never base64, never JSON, never React/Zustand state).
 *
 * Cancellation is by worker termination + recreation (documented
 * explicitly): a synchronous WASM `execute` cannot process another
 * message until it returns, so cooperative in-engine cancellation is
 * impossible on the worker thread. `cancel()` terminates the worker,
 * spins up a fresh one lazily, and seals the job `CANCELLED` with the
 * real `CANCELLED` code. Engine duration for a terminated run is
 * genuinely unavailable, so it is reported as 0 with an explicit event
 * saying so — never a fabricated number.
 */

import { registerBytes } from './binaryStore';
import type { EngineAdapter } from './EngineAdapter';
import { errorData, translateSummary, translateWireEvent } from './engineResult';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerExecuteRequest,
  type WorkerResultEnvelope,
  type WorkerToMain,
} from './workerProtocol';
import type {
  EngineEvent,
  EngineExecution,
  EngineRequest,
  OperationId,
  OutputDocumentRef,
} from '../types/engine';

interface WorkerJobRecord {
  clientJobId: string;
  listeners: Set<(event: EngineEvent) => void>;
  events: EngineEvent[];
  seq: number;
  engineJobId: string | null;
  operation: OperationId;
  startedAt: string;
  settled: boolean;
  resolve: (execution: EngineExecution) => void;
}

const READY_TIMEOUT_MS = 60_000;

function defaultCreateWorker(): Worker {
  return new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
}

export class WasmWorkerEngineAdapter implements EngineAdapter {
  readonly kind = 'wasm-worker' as const;
  readonly simulated = false;

  /**
   * Maximum settled job records retained for late `subscribe` replay.
   * Each record holds its full event array (thousands of entries for
   * large documents), so without a cap repeated runs accumulate
   * unbounded structured state. Mirrors the testbench history window.
   * Unsettled (in-flight) records are never pruned.
   */
  private static readonly MAX_RETAINED_JOBS = 25;

  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private jobCounter = 0;
  private readonly jobs = new Map<string, WorkerJobRecord>();

  /**
   * Debug escape hatch: when true, settled records (and their executions)
   * retain the FULL live event trail instead of the condensed replay
   * shape. Defaults to false — full trails of large jobs are thousands of
   * structured events per retained record. Unit tests only; the UI never
   * sets this.
   */
  static retainFullEventTrail = false;

  /** Injected for unit tests (fake worker); defaults to the real one. */
  constructor(private readonly createWorker: () => Worker = defaultCreateWorker) {}

  subscribe(jobId: string, listener: (event: EngineEvent) => void): () => void {
    const record = this.jobs.get(jobId);
    if (record === undefined) {
      return () => undefined;
    }
    for (const event of record.events) {
      listener(event);
    }
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  async cancel(jobId: string): Promise<void> {
    const record = this.jobs.get(jobId);
    if (record === undefined || record.settled) {
      return;
    }
    // Terminate the worker: the only way to stop a synchronous WASM run
    // (see module docs). A fresh worker is created lazily on next execute.
    this.destroyWorker();
    this.sealCancelled(record, jobId);
    // Any other in-flight jobs lost their worker too — fail them honestly
    // rather than hanging (the console runs one job at a time in practice;
    // concurrent adapter-level executes are an edge case, documented here).
    for (const [otherId, other] of this.jobs) {
      if (otherId !== jobId && !other.settled) {
        this.sealFailed(
          other,
          otherId,
          'IO_ERROR',
          'worker was restarted by another job\u2019s cancellation',
        );
      }
    }
  }

  execute(request: EngineRequest): { jobId: string; done: Promise<EngineExecution> } {
    this.jobCounter += 1;
    const jobId = `wasm-${this.jobCounter}`;
    let resolve!: (execution: EngineExecution) => void;
    const done = new Promise<EngineExecution>((innerResolve) => {
      resolve = innerResolve;
    });
    const record: WorkerJobRecord = {
      clientJobId: jobId,
      listeners: new Set(),
      events: [],
      seq: 0,
      engineJobId: null,
      operation: request.operation,
      startedAt: new Date().toISOString(),
      settled: false,
      resolve,
    };
    this.jobs.set(jobId, record);
    void this.pipeline(jobId, record, request);
    return { jobId, done };
  }

  // -- worker lifecycle -----------------------------------------------------

  private ensureWorker(): Promise<void> {
    if (this.worker !== null && this.ready !== null) {
      return this.ready;
    }
    const worker = this.createWorker();
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        this.readyTimer = null;
        this.readyReject = null;
        reject(
          new Error(
            `WASM worker did not signal ready within ${READY_TIMEOUT_MS / 1000}s (WASM init failed?)`,
          ),
        );
      }, READY_TIMEOUT_MS);
      const onReady = (event: MessageEvent<WorkerToMain>): void => {
        const msg = event.data;
        if (msg !== null && typeof msg === 'object' && msg.kind === 'ready') {
          this.clearReadyTimer();
          resolve();
        }
        // Boot-time init-fatals arrive via the permanent router below
        // (orphan-fatal path), not this waiter: they carry no job context.
      };
      // The permanent router is installed below; this one-shot only waits.
      worker.addEventListener('message', onReady as EventListener, { once: true });
    });
    worker.onmessage = (event: MessageEvent<WorkerToMain>) => this.route(event.data);
    worker.onerror = () => this.handleWorkerCrash('worker error (see browser console)');
    return this.ready;
  }

  /** Clears a pending ready timer without settling the waiter. */
  private clearReadyTimer(): void {
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.readyReject = null;
  }

  private destroyWorker(reason?: string): void {
    // The worker is gone: a pending readiness waiter must never hang
    // until the 60s timeout — reject it now so in-flight pipelines fail
    // fast (their catch is settled-guarded, so double-seals are safe).
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    const reject = this.readyReject;
    this.readyReject = null;
    try {
      this.worker?.terminate();
    } catch {
      // Termination is best-effort; the reference is dropped regardless.
    }
    this.worker = null;
    this.ready = null;
    reject?.(new Error(reason ?? 'WASM worker was destroyed before signaling ready'));
  }

  private handleWorkerCrash(message: string): void {
    this.destroyWorker(message);
    for (const [jobId, record] of this.jobs) {
      if (!record.settled) {
        this.sealFailed(record, jobId, 'IO_ERROR', message);
      }
    }
  }

  /**
   * Worker-level fatal with no live job context: the boot-time init-fatal
   * (empty clientJobId — the worker has no job to blame yet) or a fatal
   * for an already-settled/unknown job. The worker instance is poisoned,
   * so it is destroyed (which also rejects the pending ready waiter — no
   * 60s hang) and every unsettled job fails fast with INTERNAL. Pipelines
   * still awaiting readiness hit the settled guard in their catch.
   */
  private handleOrphanFatal(message: string): void {
    this.destroyWorker(message);
    for (const [jobId, record] of this.jobs) {
      if (!record.settled) {
        this.sealFailed(record, jobId, 'INTERNAL', message);
      }
    }
  }

  // -- pipeline ---------------------------------------------------------------

  private async pipeline(
    jobId: string,
    record: WorkerJobRecord,
    request: EngineRequest,
  ): Promise<void> {
    this.emit(record, { kind: 'lifecycle', level: 'info', message: 'job started' });
    try {
      await this.ensureWorker();
      if (record.settled) {
        return; // Cancelled while initializing.
      }
      const worker = this.worker;
      if (worker === null) {
        throw new Error('WASM worker unavailable after initialization');
      }
      const inputs = request.inputs.map((input) => {
        // Exactness assert before transfer: a transfer moves the WHOLE
        // underlying buffer, so only a view that IS its whole buffer may
        // move. Staged inputs (`transfer: true`) over an exact range move
        // with zero copy; everything else (unstaged, or a view over a
        // larger buffer) takes the `.slice()` copy path — `slice()` copies
        // exactly the viewed range, so the posted buffer is always exact
        // and the source is never neutered.
        if (
          input.transfer === true &&
          input.bytes.byteOffset === 0 &&
          input.bytes.byteLength === input.bytes.buffer.byteLength
        ) {
          // Staged input with no other owner: move the buffer itself,
          // neutering the staged view (released by the caller in its
          // finally). Rendering-backed inputs always take the copy path
          // below — transferring them would destroy the renderer's bytes.
          return { name: input.name, buffer: input.bytes.buffer as ArrayBuffer };
        }
        // Copy: the store's buffer must survive for re-runs/benchmarks;
        // the copy's ArrayBuffer is TRANSFERRED (moved, zero-copy).
        const copy = input.bytes.slice();
        return { name: input.name, buffer: copy.buffer as ArrayBuffer, view: copy };
      });
      const message: WorkerExecuteRequest = {
        protocol: WORKER_PROTOCOL_VERSION,
        kind: 'execute',
        clientJobId: jobId,
        operation: request.operation,
        inputs: inputs.map((input) => ({ name: input.name, buffer: input.buffer })),
        options: this.buildOptions(request),
      };
      worker.postMessage(message, {
        transfer: inputs.map((input) => input.buffer),
      });
    } catch (error) {
      if (!record.settled) {
        this.sealFailed(
          record,
          jobId,
          'IO_ERROR',
          error instanceof Error ? error.message : 'WASM worker initialization failed',
        );
      }
    }
  }

  private buildOptions(request: EngineRequest): Record<string, unknown> {
    switch (request.operation) {
      case 'pdf.inspect':
        return { level: request.options.level };
      case 'pdf.extract_pages':
      case 'pdf.delete_pages':
        return { pages: request.options.pages };
      case 'pdf.reorder':
        return { order: request.options.order };
      case 'pdf.rotate':
        return { pages: request.options.pages, angle_deg: request.options.angleDeg };
      case 'pdf.split':
        return {
          parts: request.options.parts.map((part) =>
            part.name === undefined
              ? { pages: part.pages }
              : { pages: part.pages, name: part.name },
          ),
        };
      case 'pdf.merge':
        return {};
      case 'pdf.images_to_pdf':
        return {
          page_size: request.options.pageSize,
          background_rgb: request.options.backgroundRgb,
        };
      case 'pdf.read_metadata':
        return {};
      case 'pdf.set_metadata':
        return { patch: request.options.patch };
    }
  }

  // -- message routing ----------------------------------------------------------

  private route(msg: WorkerToMain): void {
    if (msg === null || typeof msg !== 'object' || msg.protocol !== WORKER_PROTOCOL_VERSION) {
      return; // Malformed framing: ignore, never throw (adapter bug, not engine data).
    }
    if (msg.kind === 'ready') {
      return; // Consumed by the one-shot readiness waiter.
    }
    const record = this.jobs.get(msg.clientJobId);
    if (record === undefined || record.settled) {
      if (msg.kind === 'fatal') {
        this.handleOrphanFatal(msg.message);
      }
      return;
    }
    switch (msg.kind) {
      case 'event':
        this.noteEngineId(record, msg.event.engine_job_id ?? null);
        this.emit(record, translateWireEvent(msg.event, msg.clientJobId));
        break;
      case 'result':
        this.finishFromEnvelope(record, msg.clientJobId, msg.resultJson, msg.outputs);
        break;
      case 'fatal':
        this.sealFailed(record, msg.clientJobId, 'INTERNAL', msg.message);
        break;
    }
  }

  /**
   * Records the real engine id for display (`engineJobId`). Events keep
   * the CLIENT job id: engine ids restart from `job-1` every time a
   * cancelled run forces a worker restart, so they are not unique over a
   * session and must never be keys. The client id (`wasm-N`) is
   * adapter-monotonic and unique — it is the identity; the engine id is
   * the provenance.
   */
  private noteEngineId(record: WorkerJobRecord, engineJobId: string | null): void {
    if (engineJobId !== null && record.engineJobId === null) {
      record.engineJobId = engineJobId;
    }
  }

  private emit(
    record: WorkerJobRecord,
    partial: Omit<EngineEvent, 'jobId' | 'seq' | 'timestampMs' | 'simulated'> & {
      jobId?: string;
      timestampMs?: number;
    },
  ): void {
    record.seq += 1;
    const event: EngineEvent = {
      jobId: partial.jobId ?? record.clientJobId,
      seq: record.seq,
      timestampMs: partial.timestampMs ?? Date.now(),
      kind: partial.kind,
      level: partial.level,
      phase: partial.phase,
      completed: partial.completed,
      total: partial.total,
      percentage: partial.percentage,
      message: partial.message,
      simulated: false,
    };
    record.events.push(event);
    for (const listener of record.listeners) {
      listener(event);
    }
  }

  private finishFromEnvelope(
    record: WorkerJobRecord,
    jobId: string,
    resultJson: string,
    outputs: ArrayBuffer[],
  ): void {
    let envelope: WorkerResultEnvelope;
    try {
      envelope = JSON.parse(resultJson) as WorkerResultEnvelope;
    } catch {
      this.sealFailed(record, jobId, 'INTERNAL', 'worker returned malformed result JSON');
      return;
    }
    this.noteEngineId(record, envelope.engine_job_id);
    const completedAt = new Date(envelope.completed_at_ms ?? Date.now()).toISOString();
    const startedAt =
      envelope.started_at_ms === undefined
        ? record.startedAt
        : new Date(envelope.started_at_ms).toISOString();
    const engineDurationMs = envelope.duration_ms ?? 0;
    const status =
      envelope.state === 'completed'
        ? 'completed'
        : envelope.state === 'cancelled'
          ? 'cancelled'
          : 'failed';

    if (status !== 'completed' || envelope.result === null) {
      const error = envelope.error;
      this.emit(record, {
        kind: 'lifecycle',
        level: status === 'cancelled' ? 'info' : 'error',
        message: status === 'cancelled' ? 'job cancelled' : 'job failed',
        jobId,
      });
      this.settle(record, {
        jobId,
        engineJobId: record.engineJobId,
        operation: record.operation,
        status,
        startedAt,
        completedAt,
        engineDurationMs,
        progress: envelope.progress ?? lastProgress(record),
        error:
          error === null
            ? { code: 'INTERNAL', message: 'worker returned no error detail' }
            : errorData(error.code, error.message, error.details),
        events: [...record.events],
        simulated: false,
      });
      return;
    }

    const refs = envelope.result.outputs;
    if (refs.length !== outputs.length) {
      this.sealFailed(
        record,
        jobId,
        'INTERNAL',
        `worker returned ${outputs.length} output buffer(s) for ${refs.length} output(s)`,
      );
      return;
    }
    const registered: OutputDocumentRef[] = refs.map((ref, index) => {
      const outputId = registerBytes(ref.name, new Uint8Array(outputs[index]));
      return {
        outputId,
        name: ref.name,
        byteLength: ref.byte_length,
        pageCount: ref.page_count,
      };
    });
    this.emit(record, {
      kind: 'lifecycle',
      level: 'info',
      message: 'job completed',
      jobId,
    });
    let summary;
    try {
      summary = translateSummary(record.operation, envelope.result.summary);
    } catch (error) {
      this.sealFailed(
        record,
        jobId,
        'INTERNAL',
        `worker returned an unrecognized summary shape (${error instanceof Error ? error.message : 'unknown'})`,
      );
      return;
    }
    this.settle(record, {
      jobId,
      engineJobId: record.engineJobId,
      operation: record.operation,
      status: 'completed',
      startedAt,
      completedAt,
      engineDurationMs,
      progress: envelope.progress ?? 1,
      result: { summary, outputs: registered },
      events: [...record.events],
      simulated: false,
    });
  }

  private sealCancelled(record: WorkerJobRecord, jobId: string): void {
    this.emit(record, {
      kind: 'lifecycle',
      level: 'info',
      message: 'job cancelled (worker terminated; engine duration unavailable)',
      jobId,
    });
    this.settle(record, {
      jobId,
      engineJobId: record.engineJobId,
      operation: record.operation,
      status: 'cancelled',
      startedAt: record.startedAt,
      completedAt: new Date().toISOString(),
      engineDurationMs: 0,
      progress: lastProgress(record),
      error: { code: 'CANCELLED', message: 'operation was cancelled' },
      events: [...record.events],
      simulated: false,
    });
  }

  private sealFailed(
    record: WorkerJobRecord,
    jobId: string,
    code: 'IO_ERROR' | 'INTERNAL',
    message: string,
  ): void {
    this.emit(record, {
      kind: 'lifecycle',
      level: 'error',
      message: 'job failed',
      jobId,
    });
    this.settle(record, {
      jobId,
      engineJobId: record.engineJobId,
      operation: record.operation,
      status: 'failed',
      startedAt: record.startedAt,
      completedAt: new Date().toISOString(),
      engineDurationMs: 0,
      progress: lastProgress(record),
      error: { code, message },
      events: [...record.events],
      simulated: false,
    });
  }

  private settle(record: WorkerJobRecord, execution: EngineExecution): void {
    if (record.settled) {
      return;
    }
    record.settled = true;
    // Condense the retained trail to its replay shape: live listeners
    // already saw full fidelity; what stays in memory (25-job window) and
    // what late subscribers replay is first/last-per-phase + terminal.
    // The execution snapshot shares the condensed array (same content the
    // seal sites just snapshotted).
    const replay = WasmWorkerEngineAdapter.retainFullEventTrail
      ? [...record.events]
      : condenseReplayTrail(record.events);
    record.events = replay;
    execution.events = replay;
    record.resolve(execution);
    this.pruneSettledJobs();
  }

  /** Drops the oldest settled records beyond the retention window. */
  private pruneSettledJobs(): void {
    let settledCount = 0;
    for (const record of this.jobs.values()) {
      if (record.settled) {
        settledCount += 1;
      }
    }
    if (settledCount <= WasmWorkerEngineAdapter.MAX_RETAINED_JOBS) {
      return;
    }
    for (const [jobId, record] of this.jobs) {
      if (settledCount <= WasmWorkerEngineAdapter.MAX_RETAINED_JOBS) {
        break;
      }
      if (record.settled) {
        // Late subscribers to recent jobs still replay; only the oldest
        // settled records (with their full event arrays) are dropped.
        this.jobs.delete(jobId);
        settledCount -= 1;
      }
    }
  }
}

/**
 * Condenses a full live event trail to its replay shape: every lifecycle
 * marker is kept (few per job, including the terminal one), plus the
 * first and last event of each progress/log phase group. Order is
 * preserved; the first and terminal events are always included.
 */
function condenseReplayTrail(events: EngineEvent[]): EngineEvent[] {
  if (events.length <= 2) {
    return [...events];
  }
  const firstIndexPerGroup = new Map<string, number>();
  const lastIndexPerGroup = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.kind === 'lifecycle') {
      return;
    }
    const key = `${event.kind}:${event.phase ?? ''}`;
    if (!firstIndexPerGroup.has(key)) {
      firstIndexPerGroup.set(key, index);
    }
    lastIndexPerGroup.set(key, index);
  });
  const keep = new Set<number>([0, events.length - 1]);
  for (const index of firstIndexPerGroup.values()) {
    keep.add(index);
  }
  for (const index of lastIndexPerGroup.values()) {
    keep.add(index);
  }
  return events.filter((_, index) => keep.has(index));
}

function lastProgress(record: WorkerJobRecord): number {
  for (let i = record.events.length - 1; i >= 0; i -= 1) {
    const percentage = record.events[i].percentage;
    if (percentage !== undefined) {
      return percentage;
    }
  }
  return 0;
}
