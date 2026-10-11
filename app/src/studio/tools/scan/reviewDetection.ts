/**
 * Deferred review-time detection queue (D47, P3 shape mirroring
 * `imageSharding.ts`).
 *
 * Shutter stays queue-only (no per-capture `detect()` on the main thread);
 * detection runs later over the queued pages across K parallel lanes
 * (`resolveDetectionWorkerCount` in `detectorPolicy.ts` picks K). This runner
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
 *
 * No scanic imports here: the per-item `process` callback is injected, so
 * unit tests run this queue without the ML stack. No DOM, no React.
 */

function cancelledError(): Error & { code: string } {
  const error = new Error('Review detection cancelled.') as Error & { code: string };
  error.code = 'CANCELLED';
  return error;
}

/**
 * Run `process` over every item across `workerCount` parallel lanes.
 * Lane `w` owns indices `w, w + laneCount, w + 2 * laneCount, …` (stride
 * slicing: contiguous coverage, order-independent completion).
 */
export async function runReviewDetectionQueue<T>(
  items: T[],
  opts: {
    workerCount: number;
    process: (item: T, workerIndex: number) => Promise<void>;
    onProgress?: (done: number, total: number) => void;
    isCancelled?: () => boolean;
  },
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
      await opts.process(items[i] as T, workerIndex);
      done += 1;
      opts.onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: laneCount }, (_, index) => runLane(index)));
}
