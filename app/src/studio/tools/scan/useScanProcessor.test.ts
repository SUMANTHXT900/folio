/**
 * Scan processor hook tests (FakeWorker — no WASM, no camera).
 *
 * Covers the review-QUEUE flow (2026-10-02 scanner UX restructure):
 * silent capture queuing with detect metadata (File handles + metadata
 * only — no output bytes), the quad-space contract (capture dims, never
 * the worker's warp-output dims), Use-crop rewrap commit semantics
 * (processed + retained original, photo fallback on failure), Use
 * original / Discard / drainQueue exit commits, preview-URL revocation
 * accounting, rapid captures queueing EVERY capture in order (never
 * latest-wins), stale-result discard after reset with queue
 * preservation across a keepQueue reset, live skip/latest semantics,
 * and worker termination on reset/unmount.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScanProcessor, type CropOutcome, type ScanCommit } from './useScanProcessor';
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
  postedOf(
    kind: string,
  ): Array<{ kind: string; jobId: string; mode: string; detectOnly: boolean }> {
    return this.posted.filter(
      (p): p is { kind: string; jobId: string; mode: string; detectOnly: boolean } =>
        typeof p === 'object' && p !== null && (p as { kind?: string }).kind === kind,
    );
  }
  processJob(): { jobId: string; mode: string; detectOnly: boolean } {
    const [found] = this.postedOf('process');
    if (found === undefined) throw new Error('no process posted');
    return { jobId: found.jobId, mode: found.mode, detectOnly: found.detectOnly };
  }
  lastProcessJob(): { jobId: string; mode: string; detectOnly: boolean } {
    const jobs = this.postedOf('process');
    const found = jobs[jobs.length - 1];
    if (found === undefined) throw new Error('no process posted');
    return { jobId: found.jobId, mode: found.mode, detectOnly: found.detectOnly };
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

function errorJson(): string {
  return JSON.stringify({
    status: 'error',
    code: 'scan-quad-refused',
    message: 'quad refused by glue',
  });
}

function detectedJson(confidence = 0.8): string {
  return JSON.stringify({
    status: 'detected',
    width: 640,
    height: 800,
    mode: 'original',
    // The WASM glue emits corner pairs as [x, y] arrays.
    corners: [
      [1, 1],
      [2, 1],
      [2, 2],
      [1, 2],
    ],
    confidence,
  });
}

function fatalJson(): string {
  return JSON.stringify({ code: 'init-failed', message: 'worker init failed' });
}

function captureFile(name = 'scan-001.jpg'): File {
  return new File(['frame-bytes'], name, { type: 'image/jpeg' });
}

const DIMS = { width: 640, height: 480 };
const QUAD = [
  { x: 10, y: 10 },
  { x: 630, y: 10 },
  { x: 630, y: 470 },
  { x: 10, y: 470 },
];

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
async function startCaptureAndReady(
  result: { current: ReturnType<typeof useScanProcessor> },
  worker: FakeWorker,
  file: File,
  dims = DIMS,
): Promise<void> {
  const before = worker.postedOf('process').length;
  act(() => {
    result.current.enqueueCapture(file, dims);
  });
  await act(async () => undefined);
  act(() => {
    worker.deliver({ protocol: 2, kind: 'ready' });
  });
  await waitFor(() => {
    expect(worker.postedOf('process').length).toBeGreaterThan(before);
  });
}

/** Queues one capture end-to-end and returns its entry. */
async function queueOne(
  result: { current: ReturnType<typeof useScanProcessor> },
  worker: FakeWorker,
  file: File = captureFile(),
  resultJson = processedJson(),
): Promise<ReturnType<typeof useScanProcessor>['queued'][number]> {
  await startCaptureAndReady(result, worker, file);
  const { jobId } = worker.processJob();
  act(() => {
    worker.deliver({
      protocol: 2,
      kind: 'result',
      jobId,
      resultJson,
      output: new Uint8Array([7, 7]).buffer,
    });
  });
  await waitFor(() => expect(result.current.queued).toHaveLength(1));
  return result.current.queued[0];
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useScanProcessor', () => {
  it('queues a capture with detect metadata and no pixels', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    await startCaptureAndReady(result, worker, captureFile());
    expect(result.current.processing).toBe(true);
    const job = worker.processJob();
    // Shutter path: full pipeline, never detect-only.
    expect(job.mode).toBe('original');
    expect(job.detectOnly).toBe(false);
    const { jobId } = job;
    act(() => {
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId,
        resultJson: processedJson(),
        output: new Uint8Array([7, 7]).buffer,
      });
    });
    await waitFor(() => expect(result.current.queued).toHaveLength(1));
    expect(result.current.processing).toBe(false);
    const entry = result.current.queued[0];
    expect(entry.original.name).toBe('scan-001.jpg');
    expect(entry.previewUrl).toBe('blob:scan-1');
    expect(entry.meta.status).toBe('processed');
    // Quad space is the CAPTURE pixel space (the caller's dims). The
    // worker envelope reports warp-OUTPUT dims (800×600 here) — those
    // must never leak into the quad coordinate space.
    expect(entry.meta.width).toBe(640);
    expect(entry.meta.height).toBe(480);
    expect(entry.meta.corners).toHaveLength(4);
    // Memory discipline: the queue holds handles + metadata only.
    expect(Object.keys(entry).sort()).toEqual(['id', 'meta', 'original', 'previewUrl']);
  });

  it('useCrop rewraps at full resolution and commits the processed page', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    const entry = await queueOne(result, worker);
    const box: { outcome: CropOutcome | null } = { outcome: null };
    let pending: Promise<CropOutcome | null> | null = null;
    act(() => {
      pending = result.current.useCrop(entry.id, QUAD);
    });
    await waitFor(() => expect(worker.postedOf('rewrap')).toHaveLength(1));
    const rewrapJob = worker.postedOf('rewrap')[0];
    await act(async () => {
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId: rewrapJob.jobId,
        resultJson: processedJson(),
        output: new Uint8Array([7, 7]).buffer,
      });
      box.outcome = await pending;
    });
    expect(box.outcome?.applied).toBe(true);
    expect(box.outcome?.commit.file.name).toBe('scan-001.jpg');
    expect(box.outcome?.commit.file.size).toBe(2);
    // Processed commits retain the pre-scan capture (scanStore rules).
    expect(box.outcome?.commit.original?.name).toBe('scan-001.jpg');
    // Advance: the entry is gone and its preview URL is revoked.
    expect(result.current.queued).toHaveLength(0);
    expect(revoked).toContain('blob:scan-1');
  });

  it('useCrop failure commits the photo and reports the crop as unapplied', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    const file = captureFile();
    const entry = await queueOne(result, worker, file);
    const box: { outcome: CropOutcome | null } = { outcome: null };
    let pending: Promise<CropOutcome | null> | null = null;
    act(() => {
      pending = result.current.useCrop(entry.id, QUAD);
    });
    await waitFor(() => expect(worker.postedOf('rewrap')).toHaveLength(1));
    const rewrapJob = worker.postedOf('rewrap')[0];
    await act(async () => {
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId: rewrapJob.jobId,
        resultJson: errorJson(),
      });
      box.outcome = await pending;
    });
    // Never a lost page: the capture commits as the photo.
    expect(box.outcome?.applied).toBe(false);
    expect(box.outcome?.commit.file).toBe(file);
    expect(box.outcome?.commit.original).toBeNull();
    expect(result.current.queued).toHaveLength(0);
    expect(revoked).toContain('blob:scan-1');
  });

  it('useOriginal commits the photo without a retained original', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    const file = captureFile();
    const entry = await queueOne(result, worker, file, fallbackJson());
    expect(entry.meta.status).toBe('original');
    const box: { commit: ScanCommit | null } = { commit: null };
    act(() => {
      box.commit = result.current.useOriginal(entry.id);
    });
    expect(box.commit?.file).toBe(file);
    expect(box.commit?.original).toBeNull();
    expect(box.commit?.name).toBe('scan-001.jpg');
    expect(result.current.queued).toHaveLength(0);
    expect(revoked).toContain('blob:scan-1');
  });

  it('discardEntry drops the capture and revokes its preview URL', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    const entry = await queueOne(result, worker);
    act(() => {
      result.current.discardEntry(entry.id);
    });
    expect(result.current.queued).toHaveLength(0);
    expect(revoked).toContain('blob:scan-1');
  });

  it('a commit followed by the exit drain never double-commits (same-tick ops)', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    const first = captureFile('scan-001.jpg');
    const second = captureFile('scan-002.jpg');
    await startCaptureAndReady(result, worker, first);
    await act(async () => undefined);
    act(() => {
      result.current.enqueueCapture(second, DIMS);
    });
    await waitFor(() => expect(worker.postedOf('process')).toHaveLength(2));
    const jobs = worker.postedOf('process');
    act(() => {
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId: jobs[0].jobId,
        resultJson: processedJson(),
        output: new Uint8Array([1]).buffer,
      });
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId: jobs[1].jobId,
        resultJson: processedJson(),
        output: new Uint8Array([2]).buffer,
      });
    });
    await waitFor(() => expect(result.current.queued).toHaveLength(2));
    // The real flow's last-page chain runs in ONE tick (no re-render
    // between the commit and the queue exit's drain). A render-lagged
    // ref would make the drain re-commit the just-committed entry —
    // the E2E-caught double page.
    const box: { commit: ScanCommit | null; drained: ScanCommit[] } = { commit: null, drained: [] };
    act(() => {
      box.commit = result.current.useOriginal(result.current.queued[1].id);
      box.drained = result.current.drainQueue();
    });
    expect(box.commit?.name).toBe('scan-002.jpg');
    expect(box.drained.map((c) => c.name)).toEqual(['scan-001.jpg']);
    expect(result.current.queued).toHaveLength(0);
  });

  it('drainQueue commits every unreviewed entry as an original, in order', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    const first = captureFile('scan-001.jpg');
    const second = captureFile('scan-002.jpg');
    await startCaptureAndReady(result, worker, first);
    await act(async () => undefined);
    act(() => {
      result.current.enqueueCapture(second, DIMS);
    });
    await waitFor(() => expect(worker.postedOf('process')).toHaveLength(2));
    const jobs = worker.postedOf('process');
    act(() => {
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId: jobs[0].jobId,
        resultJson: processedJson(),
        output: new Uint8Array([1]).buffer,
      });
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId: jobs[1].jobId,
        resultJson: fallbackJson(),
      });
    });
    await waitFor(() => expect(result.current.queued).toHaveLength(2));
    let commits: ScanCommit[] = [];
    act(() => {
      commits = result.current.drainQueue();
    });
    expect(commits.map((c) => c.name)).toEqual(['scan-001.jpg', 'scan-002.jpg']);
    expect(commits.every((c) => c.original === null)).toBe(true);
    expect(commits[0].file).toBe(first);
    expect(commits[1].file).toBe(second);
    expect(result.current.queued).toHaveLength(0);
    expect(revoked).toEqual(expect.arrayContaining(['blob:scan-1', 'blob:scan-2']));
  });

  it('rapid captures queue every capture in order (never latest-wins)', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    // Queue both captures; readiness arrives after both are registered.
    act(() => {
      result.current.enqueueCapture(captureFile('scan-001.jpg'), DIMS);
    });
    await act(async () => undefined);
    act(() => {
      result.current.enqueueCapture(captureFile('scan-002.jpg'), DIMS);
    });
    await act(async () => undefined);
    act(() => {
      worker.deliver({ protocol: 2, kind: 'ready' });
    });
    await waitFor(() => expect(worker.postedOf('process')).toHaveLength(2));
    const jobs = worker.postedOf('process');
    // Both resolve (out of order): BOTH must queue, in capture order.
    act(() => {
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId: jobs[1].jobId,
        resultJson: processedJson(),
        output: new Uint8Array([2]).buffer,
      });
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId: jobs[0].jobId,
        resultJson: processedJson(),
        output: new Uint8Array([1]).buffer,
      });
    });
    await waitFor(() => expect(result.current.queued).toHaveLength(2));
    expect(result.current.queued.map((e) => e.original.name)).toEqual([
      'scan-001.jpg',
      'scan-002.jpg',
    ]);
  });

  it('a worker failure still queues the capture as a croppable error entry', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    await startCaptureAndReady(result, worker, captureFile());
    const { jobId } = worker.processJob();
    act(() => {
      worker.deliver({ protocol: 2, kind: 'fatal', jobId, message: fatalJson() });
    });
    await waitFor(() => expect(result.current.queued).toHaveLength(1));
    const entry = result.current.queued[0];
    expect(entry.meta.status).toBe('error');
    expect(entry.meta.corners).toBeNull();
    // Error entries still carry the capture dims: the queue seeds the
    // 90% inset quad, so the photo is croppable all the same.
    expect(entry.meta.width).toBe(640);
    expect(entry.meta.height).toBe(480);
  });

  it('reset terminates the worker, drops the queue, and stale results never queue', async () => {
    const worker = new FakeWorker();
    const { result, unmount } = renderHook(() =>
      useScanProcessor(() => worker as unknown as Worker),
    );
    const entry = await queueOne(result, worker);
    await startCaptureAndReady(result, worker, captureFile('scan-002.jpg'));
    const { jobId } = worker.lastProcessJob();
    act(() => {
      result.current.reset();
    });
    expect(worker.terminated).toBe(true);
    expect(result.current.queued).toHaveLength(0);
    expect(revoked).toContain(entry.previewUrl);
    act(() => {
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId,
        resultJson: processedJson(),
        output: new Uint8Array([7]).buffer,
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.queued).toHaveLength(0);
    unmount();
  });

  it('reset({ keepQueue }) preserves queued captures across a camera switch', async () => {
    const worker = new FakeWorker();
    const { result, unmount } = renderHook(() =>
      useScanProcessor(() => worker as unknown as Worker),
    );
    const entry = await queueOne(result, worker);
    act(() => {
      result.current.reset({ keepQueue: true });
    });
    // Hardware restart: in-flight jobs die, queued shots survive.
    expect(worker.terminated).toBe(true);
    expect(result.current.queued).toHaveLength(1);
    expect(revoked).not.toContain(entry.previewUrl);
    unmount();
    // Unmount is a real exit: the surviving entry is revoked.
    expect(revoked).toContain(entry.previewUrl);
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
      worker.deliver({ protocol: 2, kind: 'ready' });
    });
    const jobs = worker.postedOf('process');
    expect(jobs).toHaveLength(1);
    // Live tick is deliberately detect-only: no warp, no encoded bytes.
    const live = jobs[0];
    expect(live.mode).toBe('original');
    expect(live.detectOnly).toBe(true);
    expect(result.current.liveDetected).toBe(false);
    act(() => {
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId: live.jobId,
        resultJson: detectedJson(0.9),
      });
    });
    await waitFor(() => expect(result.current.liveDetected).toBe(true));
  });

  it('warm boots the worker with a detect-only job and never touches queue state', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    act(() => {
      result.current.warm();
      result.current.warm(); // Second call in the same session: no-op.
    });
    await act(async () => undefined);
    act(() => {
      worker.deliver({ protocol: 2, kind: 'ready' });
    });
    await waitFor(() => expect(worker.postedOf('process')).toHaveLength(1));
    // Warmup is guidance-shaped: detect-only, never a shutter job.
    const warmJob = worker.processJob();
    expect(warmJob.mode).toBe('original');
    expect(warmJob.detectOnly).toBe(true);
    expect(result.current.processing).toBe(false);
    // The warmup result is discarded: no queue entry, no detection pill.
    act(() => {
      worker.deliver({
        protocol: 2,
        kind: 'result',
        jobId: warmJob.jobId,
        resultJson: detectedJson(0.9),
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.queued).toHaveLength(0);
    expect(result.current.liveDetected).toBe(false);
    expect(result.current.processing).toBe(false);
  });

  it('warm after reset starts a new session warmup and old results stay dropped', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    act(() => {
      result.current.warm();
    });
    await act(async () => undefined);
    act(() => {
      worker.deliver({ protocol: 2, kind: 'ready' });
    });
    await waitFor(() => expect(worker.postedOf('process')).toHaveLength(1));
    act(() => {
      result.current.reset();
    });
    expect(worker.terminated).toBe(true);
    // A new session warms again (one shot per generation).
    act(() => {
      result.current.warm();
    });
    expect(result.current.queued).toHaveLength(0);
  });
});
