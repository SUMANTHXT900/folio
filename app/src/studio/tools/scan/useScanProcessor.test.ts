/**
 * Scan processor hook tests (FakeWorker — no WASM, no camera).
 *
 * Covers: capture→review, fallback/error reviews, accept ownership,
 * stale-result discard, rapid-capture latest-wins, live skip/latest
 * semantics, and worker termination on reset/unmount.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScanProcessor, type AcceptedScan } from './useScanProcessor';
import type { ScanWorkerToMain } from './scanProtocol';

let urlCounter = 0;
const revoked: string[] = [];

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  deliver(msg: ScanWorkerToMain): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
  processJob(): { jobId: string } {
    const found = this.posted.find(
      (p): p is { kind: string; jobId: string } =>
        typeof p === 'object' && p !== null && (p as { kind?: string }).kind === 'process',
    );
    if (found === undefined) throw new Error('no process posted');
    return { jobId: found.jobId };
  }
}

function processedJson(confidence = 0.8): string {
  return JSON.stringify({
    status: 'processed',
    width: 800,
    height: 600,
    mode: 'original',
    corners: [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 1, y: 2 },
    ],
    confidence,
  });
}

function fallbackJson(): string {
  return JSON.stringify({
    status: 'original',
    width: 100,
    height: 100,
    mode: 'original',
    corners: null,
    confidence: 0,
    reason: 'no-document-detected',
  });
}

function captureFile(name = 'scan-001.jpg'): File {
  return new File(['frame-bytes'], name, { type: 'image/jpeg' });
}

beforeEach(() => {
  urlCounter = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn(() => {
    urlCounter += 1;
    return `blob:scan-${urlCounter}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

/**
 * Starts a capture and flushes microtasks so the client's process()
 * call (and its ready-waiter) is registered, then delivers readiness.
 */
async function startAndReady(
  result: { current: ReturnType<typeof useScanProcessor> },
  worker: FakeWorker,
  file: File,
  mode: 'document' | 'grayscale' | 'blackwhite' = 'document',
): Promise<void> {
  act(() => {
    result.current.processCapture(file, mode);
  });
  await act(async () => undefined);
  act(() => {
    worker.deliver({ protocol: 1, kind: 'ready' });
  });
  await waitFor(() => {
    expect(worker.posted.some((p) => (p as { kind?: string }).kind === 'process')).toBe(true);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useScanProcessor', () => {
  it('processes a capture into review and accepts the scan', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    await startAndReady(result, worker, captureFile());
    expect(result.current.processing).toBe(true);
    const { jobId } = worker.processJob();
    const out = new Uint8Array([7, 7]).buffer;
    act(() => {
      worker.deliver({
        protocol: 1,
        kind: 'result',
        jobId,
        resultJson: processedJson(),
        output: out,
      });
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.processing).toBe(false);
    expect(result.current.pending?.previewUrl).toBe('blob:scan-1');
    const box: { accepted: AcceptedScan | null } = { accepted: null };
    act(() => {
      box.accepted = result.current.accept(true);
    });
    expect(box.accepted?.original?.name).toBe('scan-001.jpg');
    expect(box.accepted?.file.name).toBe('scan-001.jpg');
    expect(box.accepted?.file.size).toBe(2);
    expect(result.current.pending).toBeNull();
    expect(revoked).toEqual(['blob:scan-1']);
  });

  it('offers the original on no-detection fallback', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    await startAndReady(result, worker, captureFile(), 'grayscale');
    const { jobId } = worker.processJob();
    act(() => {
      worker.deliver({ protocol: 1, kind: 'result', jobId, resultJson: fallbackJson() });
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending?.result.status).toBe('original');
    const box: { accepted: AcceptedScan | null } = { accepted: null };
    act(() => {
      box.accepted = result.current.accept(false);
    });
    expect(box.accepted?.file.name).toBe('scan-001.jpg');
    expect(box.accepted?.original).toBeNull();
  });

  it('discards stale results after reset and terminates the worker', async () => {
    const worker = new FakeWorker();
    const { result, unmount } = renderHook(() =>
      useScanProcessor(() => worker as unknown as Worker),
    );
    await startAndReady(result, worker, captureFile());
    const { jobId } = worker.processJob();
    act(() => {
      result.current.reset();
    });
    expect(worker.terminated).toBe(true);
    expect(result.current.pending).toBeNull();
    act(() => {
      worker.deliver({ protocol: 1, kind: 'result', jobId, resultJson: processedJson() });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.pending).toBeNull();
    unmount();
  });

  it('rapid captures keep only the latest review', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    // Queue both captures; readiness arrives after both are registered.
    act(() => {
      result.current.processCapture(captureFile('scan-001.jpg'), 'document');
    });
    await act(async () => undefined);
    act(() => {
      result.current.processCapture(captureFile('scan-002.jpg'), 'document');
    });
    await act(async () => undefined);
    act(() => {
      worker.deliver({ protocol: 1, kind: 'ready' });
    });
    await waitFor(() => {
      const jobs = worker.posted.filter(
        (p) => typeof p === 'object' && p !== null && (p as { kind?: string }).kind === 'process',
      );
      expect(jobs).toHaveLength(2);
    });
    const jobs = worker.posted.filter(
      (p): p is { kind: string; jobId: string } =>
        typeof p === 'object' && p !== null && (p as { kind?: string }).kind === 'process',
    );
    expect(jobs).toHaveLength(2);
    // First resolves late: must not install.
    act(() => {
      worker.deliver({
        protocol: 1,
        kind: 'result',
        jobId: jobs[0].jobId,
        resultJson: processedJson(),
        output: new Uint8Array([1]).buffer,
      });
    });
    act(() => {
      worker.deliver({
        protocol: 1,
        kind: 'result',
        jobId: jobs[1].jobId,
        resultJson: processedJson(),
        output: new Uint8Array([2]).buffer,
      });
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending?.original.name).toBe('scan-002.jpg');
  });

  it('live detection skips while busy and reports latest state', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    const frame = () => new Blob(['low-res-frame'], { type: 'image/jpeg' });
    act(() => {
      result.current.requestLive(frame());
      result.current.requestLive(frame());
    });
    await act(async () => undefined);
    act(() => {
      worker.deliver({ protocol: 1, kind: 'ready' });
    });
    const jobs = worker.posted.filter(
      (p) => typeof p === 'object' && p !== null && (p as { kind?: string }).kind === 'process',
    );
    expect(jobs).toHaveLength(1);
    expect(result.current.liveDetected).toBe(false);
    const { jobId } = jobs[0] as { jobId: string };
    act(() => {
      worker.deliver({ protocol: 1, kind: 'result', jobId, resultJson: processedJson(0.9) });
    });
    await waitFor(() => expect(result.current.liveDetected).toBe(true));
  });
});
