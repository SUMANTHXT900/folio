/**
 * ScanWorkerClient tests (offline, FakeWorker — no WASM, no camera).
 *
 * Covers: processed/fallback/error result mapping, input transfer,
 * stale-result discard after termination, restart transparency, init
 * failure, and worker-fatal poisoning. The REAL worker+WASM path is
 * covered by the M2 round-trip benchmark harness, never mocked here.
 */
import { describe, expect, it } from 'vitest';
import { ScanWorkerClient } from './scanWorkerClient';
import type { ScanWorkerToMain } from './scanProtocol';

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: Array<{ message: unknown; transfer?: unknown }> = [];
  terminated = false;

  postMessage(message: unknown, transfer?: unknown): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  deliver(msg: ScanWorkerToMain): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }

  lastProcess(): { jobId: string; mode: string; buffer: ArrayBuffer } {
    const found = this.posted.find(
      (
        p,
      ): p is {
        message: { kind: string; jobId: string; mode: string; buffer: ArrayBuffer };
        transfer?: unknown;
      } =>
        typeof p.message === 'object' &&
        p.message !== null &&
        (p.message as { kind?: string }).kind === 'process',
    );
    if (found === undefined) throw new Error('no process message posted');
    return {
      jobId: found.message.jobId,
      mode: found.message.mode,
      buffer: found.message.buffer,
    };
  }
}

function processedJson(): string {
  return JSON.stringify({
    status: 'processed',
    width: 800,
    height: 600,
    mode: 'original',
    corners: [
      { x: 10, y: 10 },
      { x: 790, y: 10 },
      { x: 790, y: 590 },
      { x: 10, y: 590 },
    ],
    confidence: 0.82,
  });
}

describe('ScanWorkerClient', () => {
  it('maps a processed result with transferred output bytes', async () => {
    const worker = new FakeWorker();
    const client = new ScanWorkerClient(() => worker as unknown as Worker);
    const done = client.process(new Uint8Array([1, 2, 3]), 'original');
    worker.deliver({ protocol: 1, kind: 'ready' });
    const req = worker.lastProcess();
    expect(req.mode).toBe('original');
    expect(new Uint8Array(req.buffer)).toEqual(new Uint8Array([1, 2, 3]));
    const out = new Uint8Array([9, 9]).buffer;
    worker.deliver({
      protocol: 1,
      kind: 'result',
      jobId: req.jobId,
      resultJson: processedJson(),
      output: out,
    });
    const result = await done;
    expect(result.status).toBe('processed');
    expect(result.bytes !== null && Array.from(result.bytes)).toEqual([9, 9]);
    expect(result.corners).toHaveLength(4);
    expect(result.confidence).toBeCloseTo(0.82);
    expect(result.wallMs).toBeGreaterThanOrEqual(0);
  });

  it('maps fallback distinctly from errors', async () => {
    const worker = new FakeWorker();
    const client = new ScanWorkerClient(() => worker as unknown as Worker);
    const done = client.process(new Uint8Array([4]), 'grayscale');
    worker.deliver({ protocol: 1, kind: 'ready' });
    const req = worker.lastProcess();
    worker.deliver({
      protocol: 1,
      kind: 'result',
      jobId: req.jobId,
      resultJson: JSON.stringify({
        status: 'original',
        width: 100,
        height: 100,
        mode: 'grayscale',
        corners: null,
        confidence: 0,
        reason: 'no-document-detected',
      }),
    });
    const result = await done;
    expect(result.status).toBe('original');
    expect(result.reason).toBe('no-document-detected');
    expect(result.bytes).toBeNull();
  });

  it('maps glue errors with codes', async () => {
    const worker = new FakeWorker();
    const client = new ScanWorkerClient(() => worker as unknown as Worker);
    const done = client.process(new Uint8Array([5]), 'blackwhite');
    worker.deliver({ protocol: 1, kind: 'ready' });
    const req = worker.lastProcess();
    worker.deliver({
      protocol: 1,
      kind: 'result',
      jobId: req.jobId,
      resultJson: JSON.stringify({ status: 'error', code: 'decode-failed', message: 'bad bytes' }),
    });
    const result = await done;
    expect(result.status).toBe('error');
    expect(result.code).toBe('decode-failed');
  });

  it('discards stale results after termination and restarts transparently', async () => {
    let worker = new FakeWorker();
    const factories: FakeWorker[] = [worker];
    const client = new ScanWorkerClient(() => {
      const current = factories[factories.length - 1];
      return current as unknown as Worker;
    });
    const first = client.process(new Uint8Array([1]), 'original');
    worker.deliver({ protocol: 1, kind: 'ready' });
    const req = worker.lastProcess();
    client.terminate();
    await expect(first).rejects.toMatchObject({ code: 'SCAN_CANCELLED' });
    // Late result for the dead epoch: must not throw, must not resolve.
    worker.deliver({
      protocol: 1,
      kind: 'result',
      jobId: req.jobId,
      resultJson: processedJson(),
    });
    // Next job recreates the worker and works.
    worker = new FakeWorker();
    factories.push(worker);
    const second = client.process(new Uint8Array([2]), 'original');
    worker.deliver({ protocol: 1, kind: 'ready' });
    const req2 = worker.lastProcess();
    worker.deliver({
      protocol: 1,
      kind: 'result',
      jobId: req2.jobId,
      resultJson: processedJson(),
      output: new Uint8Array([7]).buffer,
    });
    const result = await second;
    expect(result.status).toBe('processed');
  });

  it('surfaces init failure without hanging', async () => {
    const worker = new FakeWorker();
    const client = new ScanWorkerClient(() => worker as unknown as Worker);
    const done = client.process(new Uint8Array([1]), 'original');
    worker.deliver({ protocol: 1, kind: 'fatal', jobId: null, message: 'wasm exploded' });
    const result = await done;
    expect(result.status).toBe('error');
    expect(result.code).toBe('worker-fatal');
    expect(result.message).toContain('wasm exploded');
  });

  it('ignores malformed worker messages', async () => {
    const worker = new FakeWorker();
    const client = new ScanWorkerClient(() => worker as unknown as Worker);
    const done = client.process(new Uint8Array([1]), 'original');
    worker.deliver({ protocol: 1, kind: 'ready' });
    worker.deliver({ protocol: 999, kind: 'ready' } as unknown as ScanWorkerToMain);
    worker.deliver(null as unknown as ScanWorkerToMain);
    const req = worker.lastProcess();
    worker.deliver({
      protocol: 1,
      kind: 'result',
      jobId: req.jobId,
      resultJson: processedJson(),
      output: new Uint8Array([1]).buffer,
    });
    const result = await done;
    expect(result.status).toBe('processed');
  });
});
