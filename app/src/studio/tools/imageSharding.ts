/**
 * Worker-level parallelism for Images → PDF (PERFORMANCE.md P3 item 13).
 *
 * Large image batches shard across K parallel `pdf.images_to_pdf` jobs —
 * one `runStudioOperation` call per shard, no orchestration changes — then
 * an ordered `pdf.merge` of the sub-PDFs through temp studio docs (the
 * RotateTool `openStudioBytes`/`closeStudioDoc` pattern). Small batches
 * keep the existing single-worker path byte-for-byte.
 *
 * Design constants (see PERFORMANCE.md P3 + risks):
 * - `SHARD_THRESHOLD_PAGES` (8): below this, transfer + merge overhead
 *   wins, so the single-worker engine call is used unchanged.
 * - K is device-aware: `navigator.hardwareConcurrency >= 8` → 3 workers,
 *   otherwise 2; unknown → 2. Clamped to 2..3 (`MIN_SHARD_WORKERS` /
 *   `MAX_SHARD_WORKERS`), and never more than one shard per page.
 * - `MAX_SHARD_IN_FLIGHT_BYTES`: memory bound (P3 risk: sharding
 *   multiplies resident WASM memory by K). The sharded path holds every
 *   shard's inputs in flight at once — one WASM intake copy per
 *   concurrent job (post-P0 glue) plus one sub-PDF output per shard until
 *   the merge — so peak ≈ 2× the staged total on top of the store copies
 *   the caller already holds. Batches over the cap stay single-worker:
 *   slower, but bounded.
 *
 * Semantics preserved:
 * - Page order = collection order across shards (contiguous index ranges,
 *   merge inputs in shard order).
 * - Progress is aggregated honestly: 90% weighted across shards by page
 *   count (engine labels intact, prefixed with the shard index), 10% for
 *   the ordered merge. Fractions never exceed 1 and never claim work
 *   that has not reported.
 * - Cancellation cancels every in-flight shard job plus the merge job;
 *   a cancel that lands between phases still fails the build.
 * - Any shard or merge failure fails the operation honestly. There is
 *   deliberately NO silent fallback to the single-worker path: a fallback
 *   would re-run the full batch after K partial runs, doubling the
 *   worst-case time while hiding the failure. The error propagates with
 *   its engine code intact.
 *
 * Output equivalence: the merge concatenates the sub-PDFs in shard order
 * (engine-tested `pdf.merge` semantics); page order/count is asserted at
 * this layer's seams in `imageSharding.test.ts`. Byte-identity of pixels
 * is engine-guaranteed, not this layer's claim.
 *
 * Binary ownership (D5): staged input ids stay caller-owned — this module
 * never stages or releases them. Temp merge docs are opened here and
 * closed in a `finally`, mirroring RotateTool.
 */

import {
  closeStudioDoc,
  openStudioBytes,
  runStudioOperation,
  type StudioJob,
  type StudioProgress,
  type StudioResult,
} from '../services/folio';

/** Batches below this page count keep the single-worker path. */
export const SHARD_THRESHOLD_PAGES = 8;

/** Shard-worker floor/ceiling: K = clamp(2..3), device-aware. */
export const MIN_SHARD_WORKERS = 2;
export const MAX_SHARD_WORKERS = 3;

/** `hardwareConcurrency` at or above this selects 3 shard workers. */
export const MANY_CORE_THRESHOLD = 8;

/**
 * Memory bound for the sharded path: total staged input bytes allowed in
 * flight across all concurrent shard jobs. See the module doc for the
 * peak arithmetic. Conservative on purpose (P3 risk).
 */
export const MAX_SHARD_IN_FLIGHT_BYTES = 256 * 1024 * 1024;

/** Share of overall progress attributed to the shard phase (rest: merge). */
export const SHARD_PHASE_WEIGHT = 0.9;

export interface ShardedImagesInput {
  /** Staged image ids in collection (= PDF page) order. Caller-owned. */
  stagedIds: string[];
  /** Staged byte lengths, same order (memory gate + progress weights). */
  stagedSizes: number[];
  pageSize: 'fit' | 'standard';
  /**
   * Test/SSR override for `navigator.hardwareConcurrency`. Defaults to
   * the live value when available.
   */
  hardwareConcurrency?: number;
  onProgress?: (progress: StudioProgress) => void;
}

export interface ShardDeps {
  runOperation: typeof runStudioOperation;
  openBytes: typeof openStudioBytes;
  closeDoc: typeof closeStudioDoc;
}

const defaultDeps: ShardDeps = {
  runOperation: runStudioOperation,
  openBytes: openStudioBytes,
  closeDoc: closeStudioDoc,
};

function readHardwareConcurrency(): number | undefined {
  try {
    const value = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pure policy: how many `images_to_pdf` shard jobs for this batch.
 * Returns 1 for the single-worker path. Exported for unit tests.
 */
export function resolveShardCount(
  pageCount: number,
  options?: { hardwareConcurrency?: number; totalBytes?: number },
): number {
  if (pageCount < SHARD_THRESHOLD_PAGES) return 1;
  if (options?.totalBytes !== undefined && options.totalBytes > MAX_SHARD_IN_FLIGHT_BYTES) {
    return 1;
  }
  const concurrency = options?.hardwareConcurrency ?? readHardwareConcurrency();
  const deviceWorkers =
    concurrency !== undefined && concurrency >= MANY_CORE_THRESHOLD
      ? MAX_SHARD_WORKERS
      : MIN_SHARD_WORKERS;
  return Math.max(1, Math.min(deviceWorkers, pageCount));
}

/**
 * Pure plan: contiguous collection-order index ranges, one per shard.
 * Every index appears exactly once, in order. Exported for unit tests.
 */
export function planShards(pageCount: number, shardCount: number): number[][] {
  const shards: number[][] = [];
  if (pageCount <= 0 || shardCount <= 0) return shards;
  const k = Math.min(shardCount, pageCount);
  const base = Math.floor(pageCount / k);
  const remainder = pageCount % k;
  let start = 0;
  for (let i = 0; i < k; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    shards.push(Array.from({ length: size }, (_, j) => start + j));
    start += size;
  }
  return shards;
}

/** Sum of staged bytes currently in flight (memory-gate input). */
export function estimateInFlightBytes(stagedSizes: readonly number[]): number {
  return stagedSizes.reduce((sum, size) => sum + Math.max(0, size), 0);
}

function cancelledError(): Error & { code: string } {
  const error = new Error('Image build cancelled.') as Error & { code: string };
  error.code = 'CANCELLED';
  return error;
}

function imagesToPdfOptions(pageSize: 'fit' | 'standard'): {
  pageSize: 'fit' | 'standard';
  backgroundRgb: [number, number, number];
} {
  return { pageSize, backgroundRgb: [255, 255, 255] };
}

/**
 * Builds the images PDF, sharded when the batch earns it. Returns a
 * `StudioJob` so callers keep the standard `jobRef`/`onCancel` pattern.
 * Single-worker batches make exactly the historical engine call.
 */
export function buildImagesPdf(
  input: ShardedImagesInput,
  deps: ShardDeps = defaultDeps,
): StudioJob {
  const active = new Set<StudioJob>();
  let mergeJob: StudioJob | null = null;
  let cancelled = false;

  const onProgress = input.onProgress;
  const pageCount = input.stagedIds.length;

  const done = (async (): Promise<StudioResult> => {
    const shardCount = resolveShardCount(pageCount, {
      hardwareConcurrency: input.hardwareConcurrency,
      totalBytes: estimateInFlightBytes(input.stagedSizes),
    });

    if (shardCount <= 1) {
      // Historical single-worker path, unchanged: same operation, same
      // ids, same options, same progress passthrough.
      const job = deps.runOperation(
        'pdf.images_to_pdf',
        input.stagedIds,
        imagesToPdfOptions(input.pageSize),
        onProgress !== undefined ? { onProgress } : undefined,
      );
      active.add(job);
      try {
        return await job.done;
      } finally {
        active.delete(job);
      }
    }

    const plans = planShards(pageCount, shardCount);
    const totalPages = pageCount;
    const fractions = new Array<number>(plans.length).fill(0);
    let totalDurationMs = 0;
    const reportShards = (): void => {
      if (onProgress === undefined) return;
      let weighted = 0;
      for (let i = 0; i < plans.length; i += 1) {
        weighted += (plans[i].length / totalPages) * fractions[i];
      }
      onProgress({ fraction: SHARD_PHASE_WEIGHT * weighted, label: 'Building pages…' });
    };

    const runShard = async (shardIndex: number, indices: number[]): Promise<StudioResult> => {
      const job = deps.runOperation(
        'pdf.images_to_pdf',
        indices.map((i) => input.stagedIds[i]),
        imagesToPdfOptions(input.pageSize),
        onProgress !== undefined
          ? {
              onProgress: (p) => {
                fractions[shardIndex] = p.fraction ?? 0;
                let weighted = 0;
                for (let i = 0; i < plans.length; i += 1) {
                  weighted += (plans[i].length / totalPages) * fractions[i];
                }
                onProgress({
                  fraction: SHARD_PHASE_WEIGHT * weighted,
                  label: `Shard ${shardIndex + 1} of ${plans.length} — ${p.label}`,
                });
              },
            }
          : undefined,
      );
      active.add(job);
      try {
        return await job.done;
      } finally {
        active.delete(job);
      }
    };

    // All shards in flight at once (that is the parallelism). Any
    // rejection fails the build: remaining shards are cancelled below
    // and the error propagates — no silent single-worker retry (see
    // module doc: a retry would double worst-case time).
    let shardResults: StudioResult[];
    try {
      shardResults = await Promise.all(plans.map((indices, i) => runShard(i, indices)));
    } catch (error) {
      for (const job of active) {
        await job.cancel().catch(() => undefined);
      }
      throw error;
    }
    for (const result of shardResults) {
      totalDurationMs += result.durationMs;
    }
    reportShards();

    if (cancelled) throw cancelledError();

    // Ordered merge through temp studio docs (RotateTool pattern).
    const tempIds: string[] = [];
    try {
      for (let i = 0; i < shardResults.length; i += 1) {
        if (cancelled) throw cancelledError();
        const first = shardResults[i].outputs[0];
        if (first === undefined) {
          throw new Error(`Shard ${i + 1} of ${shardResults.length} produced no output.`);
        }
        const temp = await deps.openBytes(
          `images (shard ${i + 1} of ${shardResults.length})`,
          first.bytes,
        );
        tempIds.push(temp.id);
      }
      if (cancelled) throw cancelledError();
      const job = deps.runOperation(
        'pdf.merge',
        tempIds,
        {},
        onProgress !== undefined
          ? {
              onProgress: (p) => {
                onProgress({
                  fraction: SHARD_PHASE_WEIGHT + (1 - SHARD_PHASE_WEIGHT) * (p.fraction ?? 0),
                  label: `Merging ${tempIds.length} parts — ${p.label}`,
                });
              },
            }
          : undefined,
      );
      mergeJob = job;
      active.add(job);
      try {
        const merged = await job.done;
        return { ...merged, durationMs: totalDurationMs + merged.durationMs };
      } finally {
        active.delete(job);
        mergeJob = null;
      }
    } finally {
      for (const id of tempIds) {
        await deps.closeDoc(id).catch(() => undefined);
      }
    }
  })();

  return {
    done,
    cancel: async () => {
      cancelled = true;
      const jobs = [...active];
      if (mergeJob !== null && !jobs.includes(mergeJob)) jobs.push(mergeJob);
      await Promise.all(jobs.map((job) => job.cancel().catch(() => undefined)));
    },
  };
}
