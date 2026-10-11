// @vitest-environment node
/**
 * `runReviewDetectionQueue` tests (D47 deferred review-time detection):
 * honest progress counting, parallel lane use, cooperative cancellation,
 * and fail-honest error propagation. The per-item `process` callback is
 * injected, so no scanic/ML stack is involved.
 */
import { describe, expect, it, vi } from 'vitest';
import { createReviewSpanCollector, runReviewDetectionQueue } from './reviewDetection';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('runReviewDetectionQueue', () => {
  it('completes every item and counts progress honestly to the total', async () => {
    const items = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    const progress: Array<[number, number]> = [];
    await runReviewDetectionQueue(items, {
      workerCount: 2,
      process: async (item) => {
        seen.push(item);
      },
      onProgress: (done, total) => {
        progress.push([done, total]);
      },
    });
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
    expect(progress).toHaveLength(items.length);
    expect(progress.map(([done]) => done).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    for (const [, total] of progress) expect(total).toBe(items.length);
    expect(progress[progress.length - 1]).toEqual([items.length, items.length]);
  });

  it('uses parallel lanes across workers', async () => {
    const items = [1, 2, 3, 4, 5, 6];
    let active = 0;
    let maxActive = 0;
    const lanes = new Set<number>();
    await runReviewDetectionQueue(items, {
      workerCount: 3,
      process: async (item, workerIndex) => {
        lanes.add(workerIndex);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active -= 1;
        expect(item).toBeGreaterThan(0);
      },
    });
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBe(3);
    expect([...lanes].sort()).toEqual([0, 1, 2]);
  });

  it('stops scheduling and rejects CANCELLED once cancelled', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const processed: number[] = [];
    let cancelled = false;
    const error = await runReviewDetectionQueue(items, {
      workerCount: 1,
      process: async (item) => {
        processed.push(item);
        if (processed.length >= 2) cancelled = true;
      },
      isCancelled: () => cancelled,
    }).then(
      () => null,
      (failure) => failure as Error & { code?: string },
    );
    expect(error).not.toBeNull();
    expect((error as Error & { code?: string }).code).toBe('CANCELLED');
    expect(processed).toEqual([1, 2]);
  });

  it('rejects immediately without processing when already cancelled', async () => {
    const process = vi.fn(async () => undefined);
    await expect(
      runReviewDetectionQueue([1, 2, 3], {
        workerCount: 2,
        process,
        isCancelled: () => true,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(process).not.toHaveBeenCalled();
  });

  it('propagates the first error without retrying the failed item', async () => {
    const items = [1, 2, 3];
    const calls = new Map<number, number>();
    await expect(
      runReviewDetectionQueue(items, {
        workerCount: 1,
        process: async (item) => {
          calls.set(item, (calls.get(item) ?? 0) + 1);
          if (item === 2) throw new Error('detect boom');
        },
      }),
    ).rejects.toThrow('detect boom');
    expect(calls.get(1)).toBe(1);
    expect(calls.get(2)).toBe(1);
    expect(calls.has(3)).toBe(false);
  });

  it('resolves immediately for an empty queue', async () => {
    const process = vi.fn(async () => undefined);
    const onProgress = vi.fn();
    await runReviewDetectionQueue([], { workerCount: 3, process, onProgress });
    expect(process).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('runReviewDetectionQueue item spans (measure-only)', () => {
  it('reports one span per started item with lane + non-negative wall time', async () => {
    const collector = createReviewSpanCollector<number>();
    await runReviewDetectionQueue([1, 2, 3, 4], {
      workerCount: 2,
      process: async () => {
        await delay(5);
      },
      onItemSpan: collector.onItemSpan,
    });
    expect(collector.spans).toHaveLength(4);
    expect([...collector.spans.map((span) => span.item)].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4,
    ]);
    for (const span of collector.spans) {
      expect(span.workerIndex).toBeGreaterThanOrEqual(0);
      expect(span.workerIndex).toBeLessThan(2);
      expect(span.spanMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports spans for failed items too (measurement covers the failure)', async () => {
    const collector = createReviewSpanCollector<number>();
    await expect(
      runReviewDetectionQueue([1, 2], {
        workerCount: 1,
        process: async (item) => {
          if (item === 2) throw new Error('detect boom');
        },
        onItemSpan: collector.onItemSpan,
      }),
    ).rejects.toThrow('detect boom');
    // Lane is serial: item 1 settled (span), item 2 started and failed (span).
    expect(collector.spans.map((span) => span.item)).toEqual([1, 2]);
  });

  it('reports no spans for items never started (already cancelled)', async () => {
    const collector = createReviewSpanCollector<number>();
    const process = vi.fn(async () => undefined);
    await expect(
      runReviewDetectionQueue([1, 2, 3], {
        workerCount: 2,
        process,
        isCancelled: () => true,
        onItemSpan: collector.onItemSpan,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(collector.spans).toHaveLength(0);
  });

  it('works without onItemSpan (additive opt, existing callers untouched)', async () => {
    const seen: number[] = [];
    await runReviewDetectionQueue([1, 2], {
      workerCount: 2,
      process: async (item) => {
        seen.push(item);
      },
    });
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
