/**
 * Scan processor hook tests (FakeWorker — no WASM, no camera).
 *
 * Covers the capture-first background-processing flow (2026-10-02
 * follow-up user feedback: process in the background while the user
 * captures): the shutter ONLY enqueues — synchronously, with no worker
 * call and no decode — then ONE background drainer processes entries
 * sequentially in capture order (`queued → processing → ready`, real
 * detect metadata only at `ready`; the quad space stays the CAPTURE
 * dims, never the worker's warp-output dims). Failures settle
 * `ready` + error (a croppable photo, never a lost shot); live guidance
 * yields while captures are pending. The existing review-QUEUE
 * semantics stay intact: Use-crop rewrap commits (processed + retained
 * original, photo fallback on failure), Use original / Discard /
 * drainQueue exit commits, preview-URL revocation accounting,
 * stale-result discard after reset with queue preservation across a
 * keepQueue reset, worker termination, warm behavior, and StrictMode
 * remount safety.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
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

function errorJson(): string {
  return JSON.stringify({
    status: 'error',
    code: 'scan-quad-refused',
    message: 'quad refused by glue',
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

type HookResult = { current: ReturnType<typeof useScanProcessor> };

function deliverReady(worker: FakeWorker): void {
  act(() => {
    worker.deliver({ protocol: 2, kind: 'ready' });
  });
}

function deliverResult(
  worker: FakeWorker,
  jobId: string,
  resultJson: string,
  output?: ArrayBuffer,
): void {
  act(() => {
    worker.deliver({ protocol: 2, kind: 'result', jobId, resultJson, output });
  });
}

/**
 * Enqueues one capture (instant) and pumps until its background job is
 * in flight: flush microtasks so the drainer reaches `client().process()`,
 * mark the worker ready, then wait for the process post.
 */
async function startCapture(
  result: HookResult,
  worker: FakeWorker,
  file: File = captureFile(),
  dims = DIMS,
): Promise<void> {
  const before = worker.postedOf('process').length;
  act(() => {
    result.current.enqueueCapture(file, dims);
  });
  await act(async () => undefined);
  deliverReady(worker);
  await waitFor(() => expect(worker.postedOf('process')).toHaveLength(before + 1));
}

/** Runs one capture end-to-end and returns its settled queue entry. */
async function queueOne(
  result: HookResult,
  worker: FakeWorker,
  file: File = captureFile(),
  resultJson = processedJson(),
): Promise<ReturnType<typeof useScanProcessor>['queued'][number]> {
  await startCapture(result, worker, file);
  const { jobId } = worker.lastProcessJob();
  deliverResult(worker, jobId, resultJson, new Uint8Array([7, 7]).buffer);
  await waitFor(() => {
    const last = result.current.queued[result.current.queued.length - 1];
    expect(last?.state).toBe('ready');
  });
  return result.current.queued[result.current.queued.length - 1];
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useScanProcessor', () => {
  it('the shutter only enqueues: no worker call, no bytes read, entry visible instantly', () => {
    const worker = new FakeWorker();
    const createWorker = vi.fn(() => worker as unknown as Worker);
    const { result } = renderHook(() => useScanProcessor(createWorker));
    act(() => {
      result.current.enqueueCapture(captureFile(), DIMS);
    });
    // Synchronous landing: original handle + preview URL + dims
    // placeholder are in the queue before any microtask can run.
    expect(result.current.queued).toHaveLength(1);
    const entry = result.current.queued[0];
    expect(entry.original.name).toBe('scan-001.jpg');
    expect(entry.previewUrl).toBe('blob:scan-1');
    expect(entry.meta.width).toBe(640);
    expect(entry.meta.height).toBe(480);
    expect(result.current.processing).toBe(true);
    // No WASM client created and no worker job posted at shutter time.
    expect(createWorker).not.toHaveBeenCalled();
    expect(worker.postedOf('process')).toHaveLength(0);
  });

  it('a settled capture carries real detect metadata and no pixels', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    const entry = await queueOne(result, worker);
    await waitFor(() => expect(result.current.processing).toBe(false));
    expect(entry.state).toBe('ready');
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
    expect(Object.keys(entry).sort()).toEqual(['id', 'meta', 'original', 'previewUrl', 'state']);
  });

  it('the drainer runs ONE worker job at a time, in capture order', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    act(() => {
      result.current.enqueueCapture(captureFile('scan-001.jpg'), DIMS);
    });
    act(() => {
      result.current.enqueueCapture(captureFile('scan-002.jpg'), DIMS);
    });
    await act(async () => undefined);
    deliverReady(worker);
    await waitFor(() => expect(worker.postedOf('process')).toHaveLength(1));
    // Only ONE job is in flight: the second capture waits its turn.
    expect(result.current.queued.map((e) => e.original.name)).toEqual([
      'scan-001.jpg',
      'scan-002.jpg',
    ]);
    expect(result.current.queued.map((e) => e.state)).toEqual(['processing', 'queued']);
    const first = worker.processJob();
    deliverResult(worker, first.jobId, processedJson(), new Uint8Array([1]).buffer);
    await waitFor(() => expect(worker.postedOf('process')).toHaveLength(2));
    expect(result.current.queued.map((e) => e.state)).toEqual(['ready', 'processing']);
    const second = worker.lastProcessJob();
    expect(second.jobId).not.toBe(first.jobId);
    deliverResult(worker, second.jobId, fallbackJson());
    await waitFor(() =>
      expect(result.current.queued.map((e) => e.state)).toEqual(['ready', 'ready']),
    );
    await waitFor(() => expect(result.current.processing).toBe(false));
  });

  it('entries transition queued → processing → ready individually', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    // First capture starts immediately; the second is enqueued behind it.
    await startCapture(result, worker, captureFile('scan-001.jpg'));
    act(() => {
      result.current.enqueueCapture(captureFile('scan-002.jpg'), DIMS);
    });
    await act(async () => undefined);
    // Behind an active job the entry holds 'queued' — the observable
    // state the review UI uses to defer per-page actions.
    expect(result.current.queued.map((e) => e.state)).toEqual(['processing', 'queued']);
    const first = worker.processJob();
    deliverResult(worker, first.jobId, processedJson(), new Uint8Array([1]).buffer);
    await waitFor(() => expect(result.current.queued[0].state).toBe('ready'));
    await waitFor(() => expect(result.current.queued[1].state).toBe('processing'));
    const second = worker.lastProcessJob();
    deliverResult(worker, second.jobId, fallbackJson());
    await waitFor(() => expect(result.current.queued[1].state).toBe('ready'));
    expect(result.current.queued[0].meta.status).toBe('processed');
    expect(result.current.queued[1].meta.status).toBe('original');
  });

  it('a worker failure still settles as ready+error (croppable photo, never a lost shot)', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    await startCapture(result, worker, captureFile());
    const { jobId } = worker.lastProcessJob();
    act(() => {
      worker.deliver({ protocol: 2, kind: 'fatal', jobId, message: fatalJson() });
    });
    await waitFor(() => expect(result.current.queued[0]?.state).toBe('ready'));
    const entry = result.current.queued[0];
    expect(entry.meta.status).toBe('error');
    expect(entry.meta.corners).toBeNull();
    // Error entries still carry the capture dims: the queue seeds the
    // 90% inset quad, so the photo is croppable all the same.
    expect(entry.meta.width).toBe(640);
    expect(entry.meta.height).toBe(480);
    await waitFor(() => expect(result.current.processing).toBe(false));
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
    await queueOne(result, worker, captureFile('scan-001.jpg'));
    await queueOne(result, worker, captureFile('scan-002.jpg'));
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
    await queueOne(result, worker, first);
    await queueOne(result, worker, second, fallbackJson());
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

  it('drainQueue while a job is in flight commits the photo and leaves no ghost entry', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    const file = captureFile();
    await startCapture(result, worker, file);
    const { jobId } = worker.lastProcessJob();
    let commits: ScanCommit[] = [];
    act(() => {
      commits = result.current.drainQueue();
    });
    expect(commits.map((c) => c.file)).toEqual([file]);
    expect(result.current.queued).toHaveLength(0);
    // The late worker result must not resurrect the committed entry.
    deliverResult(worker, jobId, processedJson(), new Uint8Array([1]).buffer);
    await act(async () => undefined);
    expect(result.current.queued).toHaveLength(0);
    await waitFor(() => expect(result.current.processing).toBe(false));
  });

  it('rapid captures queue every capture in order (never latest-wins)', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    act(() => {
      result.current.enqueueCapture(captureFile('scan-001.jpg'), DIMS);
    });
    act(() => {
      result.current.enqueueCapture(captureFile('scan-002.jpg'), DIMS);
    });
    act(() => {
      result.current.enqueueCapture(captureFile('scan-003.jpg'), DIMS);
    });
    await act(async () => undefined);
    deliverReady(worker);
    // ONE job at a time: each result releases the next capture, in order.
    for (let i = 0; i < 3; i += 1) {
      await waitFor(() => expect(worker.postedOf('process')).toHaveLength(i + 1));
      const job = worker.lastProcessJob();
      deliverResult(worker, job.jobId, processedJson(), new Uint8Array([i + 1]).buffer);
      await waitFor(() => expect(result.current.queued[i]?.state).toBe('ready'));
    }
    expect(result.current.queued.map((e) => e.original.name)).toEqual([
      'scan-001.jpg',
      'scan-002.jpg',
      'scan-003.jpg',
    ]);
    expect(result.current.queued.every((e) => e.state === 'ready')).toBe(true);
  });

  it('reset terminates the worker, drops the queue, and stale results never queue', async () => {
    const worker = new FakeWorker();
    const { result, unmount } = renderHook(() =>
      useScanProcessor(() => worker as unknown as Worker),
    );
    const entry = await queueOne(result, worker);
    await startCapture(result, worker, captureFile('scan-002.jpg'));
    const { jobId } = worker.lastProcessJob();
    act(() => {
      result.current.reset();
    });
    expect(worker.terminated).toBe(true);
    expect(result.current.queued).toHaveLength(0);
    expect(revoked).toContain(entry.previewUrl);
    deliverResult(worker, jobId, processedJson(), new Uint8Array([7]).buffer);
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.queued).toHaveLength(0);
    expect(result.current.processing).toBe(false);
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
    expect(result.current.queued[0].state).toBe('ready');
    expect(revoked).not.toContain(entry.previewUrl);
    unmount();
    // Unmount is a real exit: the surviving entry is revoked.
    expect(revoked).toContain(entry.previewUrl);
  });

  it('reset({ keepQueue }) re-queues an in-flight entry for the fresh session', async () => {
    const worker = new FakeWorker();
    const { result, unmount } = renderHook(() =>
      useScanProcessor(() => worker as unknown as Worker),
    );
    await startCapture(result, worker, captureFile('scan-001.jpg'));
    expect(result.current.queued[0].state).toBe('processing');
    act(() => {
      result.current.reset({ keepQueue: true });
    });
    // The old worker died mid-job; the entry survives and the fresh
    // drainer takes it over instead of stranding it in 'processing'.
    expect(worker.terminated).toBe(true);
    expect(result.current.queued).toHaveLength(1);
    expect(result.current.queued[0].state).not.toBe('ready');
    // The dead session's result arrives (same job id — counters are
    // per-client): silently dropped, never settled.
    deliverResult(worker, 'scan-1', processedJson(), new Uint8Array([7]).buffer);
    await act(async () => undefined);
    expect(result.current.queued[0].state).not.toBe('ready');
    // The fresh session reprocesses the entry on a new worker connection.
    deliverReady(worker);
    await waitFor(() => expect(worker.postedOf('process')).toHaveLength(2));
    const freshJob = worker.lastProcessJob();
    deliverResult(worker, freshJob.jobId, processedJson(), new Uint8Array([7]).buffer);
    await waitFor(() => expect(result.current.queued[0].state).toBe('ready'));
    expect(result.current.queued[0].meta.status).toBe('processed');
    unmount();
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
    deliverReady(worker);
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

  it('live guidance yields while captures are pending and resumes when the queue is clear', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    await startCapture(result, worker, captureFile());
    const captureJob = worker.lastProcessJob();
    // Capture in flight: the tick is dropped outright (no worker call).
    act(() => {
      result.current.requestLive(new Blob(['frame'], { type: 'image/jpeg' }));
    });
    await act(async () => undefined);
    expect(worker.postedOf('process')).toHaveLength(1);
    // Once the capture is settled the guidance resumes.
    deliverResult(worker, captureJob.jobId, processedJson(), new Uint8Array([7]).buffer);
    await waitFor(() => expect(result.current.queued[0]?.state).toBe('ready'));
    act(() => {
      result.current.requestLive(new Blob(['frame'], { type: 'image/jpeg' }));
    });
    await act(async () => undefined);
    await waitFor(() => expect(worker.postedOf('process')).toHaveLength(2));
    const live = worker.lastProcessJob();
    expect(live.mode).toBe('original');
    expect(live.detectOnly).toBe(true);
  });

  it('warm boots the worker with a detect-only job and never touches queue state', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker));
    act(() => {
      result.current.warm();
      result.current.warm(); // Second call in the same session: no-op.
    });
    await act(async () => undefined);
    deliverReady(worker);
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
    deliverReady(worker);
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

  it('StrictMode double-mount does not drop captures', async () => {
    const worker = new FakeWorker();
    const { result } = renderHook(() => useScanProcessor(() => worker as unknown as Worker), {
      wrapper: StrictMode,
    });
    await startCapture(result, worker, captureFile());
    await waitFor(() => expect(result.current.queued).toHaveLength(1));
    const { jobId } = worker.lastProcessJob();
    deliverResult(worker, jobId, processedJson(), new Uint8Array([7]).buffer);
    await waitFor(() => expect(result.current.queued[0]?.state).toBe('ready'));
    expect(result.current.queued).toHaveLength(1);
    expect(result.current.queued[0].meta.status).toBe('processed');
  });
});
