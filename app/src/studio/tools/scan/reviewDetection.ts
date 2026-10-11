/**
 * Deferred review-time detection queue (D47, P3 shape mirroring
 * `imageSharding.ts`).
 *
 * Shutter stays queue-only (no per-capture `detect()` on the main thread);
 * detection runs later over the queued pages across K parallel lanes
 * (`resolveDetectionWorkerCount` in `detectorPolicy.ts` picks K — callers
 * pass the PENDING count, not the total). This runner
 * is the lane fan-out: `Promise.all` over stride-sliced lane loops, so every
 * item is processed exactly once and progress counts honestly toward the
 * total regardless of completion order.
 *
 * Semantics (same honesty rules as the P3 sharded build):
 * - Fail-honestly: the first error rejects the run with its code intact.
 *   There is deliberately NO silent retry or fallback.
 * - Cancellation is cooperative: `isCancelled` is checked before each item;
 *   a cancel stops scheduling new items and rejects with a `CANCELLED` code.
 * - `onProgress(done, total)` fires honestly after each completed item.
 * - `onItemSpan` (additive, 2026-10-11) reports a per-item wall span for
 *   measure-before-optimize aggregation — log/collect only, never behavior.
 *
 * No scanic imports here: the per-item `process` callback is injected, so
 * unit tests run this queue without the ML stack. No DOM, no React.
 */

/** Per-item wall span for one `process` call (measure-only, dev-visible). */
export interface ReviewDetectionSpan<T> {
  /** The queued item that was processed. */
  item: T;
  /** Stride-lane index that processed it (`0..laneCount-1`). */
  workerIndex: number;
  /** Wall time around `process` in ms (monotonic where available). */
  spanMs: number;
}

/** Options for `runReviewDetectionQueue` (signature frozen — additive only). */
export interface ReviewDetectionQueueOptions<T> {
  workerCount: number;
  process: (item: T, workerIndex: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
  /**
   * Fires after every STARTED item settles (success or failure) with its
   * wall span. Items never started (cancelled before scheduling) report no
   * span. Collect-only — throwing here is caller error, not queue behavior.
   */
  onItemSpan?: (span: ReviewDetectionSpan<T>) => void;
}

function cancelledError(): Error & { code: string } {
  const error = new Error('Review detection cancelled.') as Error & { code: string };
  error.code = 'CANCELLED';
  return error;
}

function nowMs(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {
    // Non-DOM runtimes without performance: fall through to Date.
  }
  return Date.now();
}

/**
 * Run `process` over every item across `workerCount` parallel lanes.
 * Lane `w` owns indices `w, w + laneCount, w + 2 * laneCount, …` (stride
 * slicing: contiguous coverage, order-independent completion).
 */
export async function runReviewDetectionQueue<T>(
  items: T[],
  opts: ReviewDetectionQueueOptions<T>,
): Promise<void> {
  const total = items.length;
  if (total === 0) return;
  const requested = Math.floor(opts.workerCount);
  const laneCount = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 1, total));
  if (opts.isCancelled?.()) throw cancelledError();
  let done = 0;
  const runLane = async (workerIndex: number): Promise<void> => {
    for (let i = workerIndex; i < items.length; i += laneCount) {
      if (opts.isCancelled?.()) throw cancelledError();
      const item = items[i] as T;
      const start = nowMs();
      try {
        await opts.process(item, workerIndex);
      } finally {
        opts.onItemSpan?.({ item, workerIndex, spanMs: nowMs() - start });
      }
      done += 1;
      opts.onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: laneCount }, (_, index) => runLane(index)));
}

/**
 * Trivial span aggregator for `onItemSpan`: `collector.spans` collects one
 * entry per started item in settle order. The review (VF) lane attaches
 * `collector.onItemSpan` to the queue opts and reads `collector.spans`
 * after the drain for dev-visible per-item timings.
 */
export function createReviewSpanCollector<T>(): {
  spans: ReviewDetectionSpan<T>[];
  onItemSpan: (span: ReviewDetectionSpan<T>) => void;
} {
  const spans: ReviewDetectionSpan<T>[] = [];
  return {
    spans,
    onItemSpan: (span: ReviewDetectionSpan<T>): void => {
      spans.push(span);
    },
  };
}
