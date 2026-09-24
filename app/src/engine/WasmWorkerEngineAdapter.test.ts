/**
 * `WasmWorkerEngineAdapter` unit tests (offline, fake worker).
 *
 * A scripted `FakeWorker` stands in for `engine.worker.ts` + WASM: it
 * captures `postMessage` calls and lets each test deliver `ready`,
 * `event`, `result`, and `fatal` messages on demand. This verifies the
 * adapter's protocol handling — readiness handshake, event routing and
 * replay, engine-id adoption, summary translation, binary output
 * registration, structured failures, and terminate-based cancellation —
 * without a browser, WASM, or server. The REAL worker+WASM path is
 * covered by headless-Chrome end-to-end tests (Lesson 10 acceptance).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { WasmWorkerEngineAdapter } from './WasmWorkerEngineAdapter';
import { __clearBinaryStore, getBytes } from './binaryStore';
import type { EngineRequest } from '../types/engine';
import type { WorkerToMain } from './workerProtocol';

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  private readyListeners: Array<(event: MessageEvent) => void> = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') {
      this.readyListeners.push(listener);
    }
  }

  /** Harness: deliver a worker→main message through both channels. */
  deliver(msg: WorkerToMain): void {
    const event = { data: msg } as MessageEvent;
    if (msg.kind === 'ready') {
      const listeners = this.readyListeners;
      this.readyListeners = [];
      for (const listener of listeners) {
        listener(event);
      }
    }
    this.onmessage?.(event);
  }

  executePosted(): { clientJobId: string; operation: string } {
    const message = this.posted.find(
      (item): item is { kind: string; clientJobId: string; operation: string } =>
        typeof item === 'object' && item !== null && 'kind' in item && item.kind === 'execute',
    );
    if (message === undefined) {
      throw new Error('no execute message posted');
    }
    return message;
  }
}

function makeAdapter(): { adapter: WasmWorkerEngineAdapter; worker: FakeWorker } {
  const worker = new FakeWorker();
  const adapter = new WasmWorkerEngineAdapter(() => worker as unknown as Worker);
  return { adapter, worker };
}

function inspectRequest(): EngineRequest {
  return {
    operation: 'pdf.inspect',
    inputs: [{ name: 'doc.pdf', bytes: new Uint8Array([1, 2, 3]) }],
    options: { level: 'basic' },
  };
}

function completedEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    engine_job_id: 'job-7',
    operation: 'pdf.inspect',
    state: 'completed',
    started_at_ms: 1000,
    completed_at_ms: 1005,
    duration_ms: 4.5,
    progress: 1.0,
    result: {
      summary: {
        page_count: 2,
        pdf_version: '1.7',
        encrypted: false,
        metadata: { title: null, author: null, producer: null },
        pages: null,
      },
      outputs: [],
    },
    error: null,
    event_count: 3,
    ...overrides,
  });
}

function progressEvent(percentage: number): WorkerToMain {
  return {
    protocol: 1,
    kind: 'event',
    clientJobId: 'wasm-1',
    event: {
      timestamp_ms: 1001,
      kind: 'progress',
      phase: 'inspecting',
      completed: 1,
      total: 2,
      percentage,
      message: 'page 1 of 2',
      engine_job_id: 'job-7',
    },
  };
}

describe('WasmWorkerEngineAdapter', () => {
  beforeEach(() => {
    __clearBinaryStore();
  });

  it('reports its kind and non-simulated flavor', () => {
    const { adapter } = makeAdapter();
    expect(adapter.kind).toBe('wasm-worker');
    expect(adapter.simulated).toBe(false);
  });

  it('completes an inspect with real engine id, duration, and summary', async () => {
    const { adapter, worker } = makeAdapter();
    const seen: string[] = [];
    const { jobId, done } = adapter.execute(inspectRequest());
    adapter.subscribe(jobId, (event) => {
      seen.push(`${event.kind}:${event.message ?? ''}`);
    });
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    worker.deliver(progressEvent(0.5));
    worker.deliver({
      protocol: 1,
      kind: 'result',
      clientJobId: jobId,
      resultJson: completedEnvelope(),
      outputs: [],
    });
    const finished = await done;
    expect(finished.status).toBe('completed');
    // Client id is the stable identity; the real engine id is provenance.
    expect(finished.jobId).toBe('wasm-1');
    expect(finished.engineJobId).toBe('job-7');
    expect(finished.engineDurationMs).toBe(4.5);
    expect(finished.result?.summary).toMatchObject({ pageCount: 2, pdfVersion: '1.7' });
    expect(finished.simulated).toBe(false);
    expect(seen).toContain('lifecycle:job started');
    expect(seen.some((entry) => entry.startsWith('progress:'))).toBe(true);
    // Events are keyed by the unique client id (engine ids may repeat
    // across worker restarts, so they must never be keys).
    expect(
      finished.events.every((event) => event.jobId === 'wasm-1' || event.client === true),
    ).toBe(true);
  });

  it('registers transferred output buffers in the binary store', async () => {
    const { adapter, worker } = makeAdapter();
    const { jobId, done } = adapter.execute({
      operation: 'pdf.extract_pages',
      inputs: [{ name: 'doc.pdf', bytes: new Uint8Array([9, 9, 9]) }],
      options: { pages: [1] },
    });
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    worker.deliver({
      protocol: 1,
      kind: 'result',
      clientJobId: jobId,
      resultJson: JSON.stringify({
        engine_job_id: 'job-9',
        operation: 'pdf.extract_pages',
        state: 'completed',
        duration_ms: 2,
        progress: 1,
        result: {
          summary: { page_count: 1 },
          outputs: [{ index: 0, name: 'doc-extracted.pdf', byte_length: 4, page_count: 1 }],
        },
        error: null,
        event_count: 1,
      }),
      outputs: [pdfBytes.buffer as ArrayBuffer],
    });
    const finished = await done;
    expect(finished.status).toBe('completed');
    expect(finished.result?.outputs).toHaveLength(1);
    const output = finished.result?.outputs[0];
    expect(output?.pageCount).toBe(1);
    expect(getBytes(output?.outputId ?? ''))?.toEqual(pdfBytes);
  });

  it('surfaces structured engine failures with code and details', async () => {
    const { adapter, worker } = makeAdapter();
    const { jobId, done } = adapter.execute(inspectRequest());
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    worker.deliver({
      protocol: 1,
      kind: 'result',
      clientJobId: jobId,
      resultJson: JSON.stringify({
        engine_job_id: 'job-11',
        operation: 'pdf.inspect',
        state: 'failed',
        duration_ms: 1.5,
        progress: 0.2,
        result: null,
        error: {
          code: 'PAGE_OUT_OF_RANGE',
          message: 'selected page 999999 is outside the document',
          details: 'page_count=2',
        },
        event_count: 2,
      }),
      outputs: [],
    });
    const finished = await done;
    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('PAGE_OUT_OF_RANGE');
    expect(finished.error?.details).toBe('page_count=2');
    expect(finished.engineDurationMs).toBe(1.5);
    expect(finished.result).toBeUndefined();
  });

  it('turns worker fatals into INTERNAL failures, never hangs', async () => {
    const { adapter, worker } = makeAdapter();
    const { jobId, done } = adapter.execute(inspectRequest());
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    worker.deliver({
      protocol: 1,
      kind: 'fatal',
      clientJobId: jobId,
      message: 'WASM panic: something broke',
    });
    const finished = await done;
    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('INTERNAL');
    expect(finished.error?.message).toContain('WASM panic');
  });

  it('cancels by terminating the worker and sealing CANCELLED', async () => {
    const { adapter, worker } = makeAdapter();
    const { jobId, done } = adapter.execute(inspectRequest());
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    await adapter.cancel(jobId);
    const finished = await done;
    expect(worker.terminated).toBe(true);
    expect(finished.status).toBe('cancelled');
    expect(finished.error?.code).toBe('CANCELLED');
    expect(finished.engineDurationMs).toBe(0);
    expect(
      finished.events.some((event) => event.message?.includes('worker terminated') === true),
    ).toBe(true);
  });

  it('recovers after a cancel: the next execute boots a fresh worker', async () => {
    const workers: FakeWorker[] = [];
    const adapter = new WasmWorkerEngineAdapter(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const first = adapter.execute(inspectRequest());
    workers[0].deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    await adapter.cancel(first.jobId);
    await first.done;
    expect(workers).toHaveLength(1);

    const second = adapter.execute(inspectRequest());
    expect(workers).toHaveLength(2);
    workers[1].deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    workers[1].deliver({
      protocol: 1,
      kind: 'result',
      clientJobId: second.jobId,
      resultJson: completedEnvelope(),
      outputs: [],
    });
    const finished = await second.done;
    expect(finished.status).toBe('completed');
  });

  it('rejects malformed result JSON as INTERNAL, not as engine data', async () => {
    const { adapter, worker } = makeAdapter();
    const { jobId, done } = adapter.execute(inspectRequest());
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    worker.deliver({
      protocol: 1,
      kind: 'result',
      clientJobId: jobId,
      resultJson: 'not json{',
      outputs: [],
    });
    const finished = await done;
    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('INTERNAL');
  });

  it('ignores messages for unknown jobs', async () => {
    const { adapter, worker } = makeAdapter();
    const { jobId, done } = adapter.execute(inspectRequest());
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    worker.deliver(progressEvent(0.5));
    worker.deliver({
      protocol: 1,
      kind: 'event',
      clientJobId: 'wasm-999',
      event: {
        timestamp_ms: 1,
        kind: 'log',
        level: 'info',
        message: 'ghost',
      },
    });
    worker.deliver({
      protocol: 1,
      kind: 'result',
      clientJobId: jobId,
      resultJson: completedEnvelope(),
      outputs: [],
    });
    const finished = await done;
    expect(finished.status).toBe('completed');
    expect(finished.events.some((event) => event.message === 'ghost')).toBe(false);
  });

  it('sends images_to_pdf options with page size and background', async () => {
    const { adapter, worker } = makeAdapter();
    adapter.execute({
      operation: 'pdf.images_to_pdf',
      inputs: [
        { name: 'a.png', bytes: new Uint8Array([1, 2, 3, 4]) },
        { name: 'b.jpg', bytes: new Uint8Array([5, 6, 7, 8]) },
      ],
      options: { pageSize: 'standard', backgroundRgb: [255, 255, 255] },
    });
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    const raw = worker.posted[0] as {
      operation: string;
      options: Record<string, unknown>;
      inputs: unknown[];
    };
    expect(raw.operation).toBe('pdf.images_to_pdf');
    expect(raw.options).toMatchObject({ page_size: 'standard', background_rgb: [255, 255, 255] });
    expect(raw.inputs).toHaveLength(2);
  });

  it('translates an images_to_pdf counts summary', async () => {
    const { adapter, worker } = makeAdapter();
    const { jobId, done } = adapter.execute({
      operation: 'pdf.images_to_pdf',
      inputs: [{ name: 'a.png', bytes: new Uint8Array([1, 2, 3, 4]) }],
      options: { pageSize: 'fit', backgroundRgb: [255, 255, 255] },
    });
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    worker.deliver({
      protocol: 1,
      kind: 'result',
      clientJobId: jobId,
      resultJson: JSON.stringify({
        engine_job_id: 'job-21',
        operation: 'pdf.images_to_pdf',
        state: 'completed',
        duration_ms: 3,
        progress: 1,
        result: {
          summary: { page_count: 1, image_count: 1 },
          outputs: [{ index: 0, name: 'images.pdf', byte_length: 8, page_count: 1 }],
        },
        error: null,
        event_count: 1,
      }),
      outputs: [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer as ArrayBuffer],
    });
    const finished = await done;
    expect(finished.status).toBe('completed');
    expect(finished.result?.summary).toMatchObject({ pageCount: 1 });
  });

  it('transfers input bytes to the worker without retaining them', async () => {
    const { adapter, worker } = makeAdapter();
    const { jobId } = adapter.execute(inspectRequest());
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    const posted = worker.executePosted();
    expect(posted.clientJobId).toBe(jobId);
    expect(posted.operation).toBe('pdf.inspect');
    // The execute message carries transferable buffers, not JSON binary.
    const raw = worker.posted[0] as { inputs: Array<{ buffer: ArrayBuffer }> };
    expect(raw.inputs[0].buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('moves staged transfer inputs without copying', async () => {
    const { adapter, worker } = makeAdapter();
    const bytes = new Uint8Array([9, 8, 7, 6]);
    adapter.execute({
      operation: 'pdf.images_to_pdf',
      inputs: [{ name: 'a.png', bytes, transfer: true }],
      options: { pageSize: 'fit', backgroundRgb: [255, 255, 255] },
    });
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    const raw = worker.posted[0] as { inputs: Array<{ buffer: ArrayBuffer }> };
    // Same buffer object moved across — zero-copy for staged inputs.
    expect(raw.inputs[0].buffer).toBe(bytes.buffer);
  });

  it('copies rendering-backed inputs and views to protect other owners', async () => {
    const { adapter, worker } = makeAdapter();
    const shared = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = new Uint8Array(shared.buffer, 2, 2);
    adapter.execute({
      operation: 'pdf.images_to_pdf',
      inputs: [
        { name: 'shared.pdf', bytes: shared },
        { name: 'view.png', bytes: view, transfer: true },
      ],
      options: { pageSize: 'fit', backgroundRgb: [255, 255, 255] },
    });
    worker.deliver({ protocol: 1, kind: 'ready' });
    await Promise.resolve();
    const raw = worker.posted[0] as { inputs: Array<{ buffer: ArrayBuffer }> };
    // Unflagged input: copied, original intact.
    expect(raw.inputs[0].buffer).not.toBe(shared.buffer);
    expect(new Uint8Array(raw.inputs[0].buffer)).toEqual(shared);
    expect(shared).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    // Flagged but non-exact view: copied exact range, source intact.
    expect(new Uint8Array(raw.inputs[1].buffer)).toEqual(new Uint8Array([3, 4]));
    expect(view).toEqual(new Uint8Array([3, 4]));
  });

  it('bounds retained settled-job records (Lesson 14 large-file safety)', async () => {
    const { adapter, worker } = makeAdapter();
    const jobIds: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const { jobId, done } = adapter.execute(inspectRequest());
      jobIds.push(jobId);
      worker.deliver({ protocol: 1, kind: 'ready' });
      await Promise.resolve();
      worker.deliver({
        protocol: 1,
        kind: 'result',
        clientJobId: jobId,
        resultJson: completedEnvelope(),
        outputs: [],
      });
      await done;
    }
    // The oldest settled records (with their full event arrays) are
    // pruned: a late subscriber to wasm-1 replays nothing…
    const stale: string[] = [];
    adapter.subscribe(jobIds[0], (event) => {
      stale.push(event.message ?? '');
    });
    expect(stale).toHaveLength(0);
    // …while recent jobs still replay for late subscribers.
    const recent: string[] = [];
    adapter.subscribe(jobIds[jobIds.length - 1], (event) => {
      recent.push(event.message ?? '');
    });
    expect(recent.length).toBeGreaterThan(0);
  });
});
