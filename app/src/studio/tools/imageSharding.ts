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
  type StudioPerfMark,
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
 *
 * The gate compares TWO estimates against this cap (P3 item 7): staged
 * input bytes AND estimated sub-PDF output bytes (below). Inputs alone
 * understate the peak: every shard's output is held until the ordered
 * merge, so resident ≈ inputs + outputs on top of the store copies the
 * caller already holds. Batches over either estimate stay single-worker:
 * slower, but bounded.
 */
export const MAX_SHARD_IN_FLIGHT_BYTES = 256 * 1024 * 1024;

/**
 * Estimated PDF container overhead on JPEG passthrough bytes (P3 item 7).
 * The engine embeds baseline orientation-1 JPEGs byte-identical
 * (passthrough, `images_to_pdf/mod.rs`), so sub-PDF output ≈ input plus
 * per-page dictionary overhead. ESTIMATE, not measured: 5% covers the
 * container with headroom; non-passthrough JPEGs re-encode at q82 and
 * come out SMALLER, so this overstates them (safe direction).
 */
export const SHARD_JPEG_OUTPUT_FACTOR = 1.05;

/**
 * Conservative output factor for PNG/unknown inputs with unknown dims
 * (P3 item 7). The engine embeds PNGs as uncompressed raw RGB, and the
 * in-tree observation (5-2) is ~8× versus JPEG bytes. ESTIMATE, not
 * measured — deliberately pessimistic so unknown-dim batches gate early
 * instead of counting 0.
 */
export const SHARD_UNKNOWN_OUTPUT_FACTOR = 8;

/**
 * Raw-RGB bytes per pixel for the PNG embed path (P3 item 7). GROUNDED in
 * the engine contract (`images_to_pdf/mod.rs`: PNGs keep lossless raw
 * RGB): a PNG with known dims can never exceed w×h×3 output bytes, so
 * known dims always beat the conservative byte factor above.
 */
export const SHARD_RAW_RGB_BYTES_PER_PIXEL = 3;

/**
 * Decode-cost bound for the sharded path (5-3): total pixels allowed
 * across the batch before sharding is capped to K=1. Bytes understate
 * decode cost ~18× for JPEG (a 2 MB phone photo decodes to ~36 MB of
 * RGB), so large-but-compact batches must not fan out across K
 * concurrent WASM decodes. Calibrated against the normalization caps:
 * import/scan outputs are clamped to a 2500px long edge (~4.7 MP each),
 * so an 8-page normalized batch peaks at ~37 MP and still shards;
 * batches with full-resolution pages (e.g. rotated originals, which
 * bypass import normalization) trip this gate and stay single-worker.
 */
export const MAX_SHARD_PIXELS = 48_000_000;

/** Share of overall progress attributed to the shard phase (rest: merge). */
export const SHARD_PHASE_WEIGHT = 0.9;

/**
 * Image kind for the output-byte estimate (P3 item 7). `'unknown'` is the
 * conservative default: raw-RGB-scale output is assumed, never zero.
 */
export type StagedImageKind = 'jpeg' | 'png' | 'unknown';

/**
 * Pure classifier: MIME first, extension fallback, else `'unknown'`.
 * Exported for unit tests and for callers threading staged kinds.
 */
export function classifyStagedKind(input: { name?: string; mime?: string }): StagedImageKind {
  const mime = (input.mime ?? '').toLowerCase().trim();
  if (mime === 'image/jpeg') return 'jpeg';
  if (mime === 'image/png') return 'png';
  const name = (input.name ?? '').toLowerCase();
  if (/\.jpe?g$/.test(name)) return 'jpeg';
  if (/\.png$/.test(name)) return 'png';
  return 'unknown';
}

/**
 * Estimated sub-PDF output bytes held across shards until the ordered
 * merge (P3 item 7 gate input). Per image, same order as `stagedSizes`:
 * - `'jpeg'`: input × `SHARD_JPEG_OUTPUT_FACTOR` (passthrough + overhead).
 * - `'png'`/`'unknown'` with known dims: pixels × 3 (raw-RGB bound —
 *   grounded, never estimated).
 * - `'png'`/`'unknown'` with unknown dims: input ×
 *   `SHARD_UNKNOWN_OUTPUT_FACTOR` (conservative — replaces the old 0).
 *
 * Exported for unit tests.
 */
export function estimateShardOutputBytes(
  stagedSizes: readonly number[],
  kinds?: readonly StagedImageKind[],
  stagedPixels?: readonly number[],
): number {
  let total = 0;
  for (let i = 0; i < stagedSizes.length; i += 1) {
    const size = Math.max(0, stagedSizes[i] ?? 0);
    const kind = kinds?.[i] ?? 'unknown';
    const pixels = Math.max(0, stagedPixels?.[i] ?? 0);
    if (kind === 'jpeg') {
      total += Math.ceil(size * SHARD_JPEG_OUTPUT_FACTOR);
    } else if (pixels > 0) {
      total += pixels * SHARD_RAW_RGB_BYTES_PER_PIXEL;
    } else {
      total += Math.ceil(size * SHARD_UNKNOWN_OUTPUT_FACTOR);
    }
  }
  return total;
}

export interface ShardedImagesInput {
  /** Staged image ids in collection (= PDF page) order. Caller-owned. */
  stagedIds: string[];
  /** Staged byte lengths, same order (memory gate + progress weights). */
  stagedSizes: number[];
  /**
   * Image kind per staged image, same order (P3 item 7 output gate).
   * JPEGs embed near-passthrough; PNGs embed as raw RGB (~w×h×3). Absent
   * entries (or a wholly absent array) count as `'unknown'` and take the
   * conservative factor — unknown batches gate early instead of counting 0.
   */
  stagedKinds?: StagedImageKind[];
  /**
   * Decode cost per staged image (w×h, known at prepare time), same
   * order (5-3 pixel gate). Optional: batches without it keep the
   * historical byte-only gate byte-for-byte.
   */
  stagedPixels?: number[];
  /**
   * Retained scan originals still resident with the collection (5-3):
   * pre-scan captures kept for Use-original provenance occupy tab
   * memory alongside the build, so they join the pixel estimate.
   * Caller-supplied (the store lives with the page collection);
   * absent entries simply do not count.
   */
  retainedPixels?: number[];
  pageSize: 'fit' | 'standard';
  /**
   * Staging-phase abort: the same `AbortController` that cancels
   * `stageImagePages` is forwarded here so one Cancel aborts the whole
   * build (staging loop + shard jobs + merge). Checked at phase
   * boundaries and wired to cancel in-flight jobs via listener.
   */
  signal?: AbortSignal;
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
 *
 * Gate order is deliberate (M5): the page-count check runs first so
 * small batches keep the single-worker path byte-for-byte, then the
 * pre-stage byte cap, then the estimated-output cap (P3 item 7: inputs +
 * outputs are both resident until the merge), then the decode-cost pixel
 * cap (5-3). Callers
 * SHOULD evaluate this policy on pre-stage sums (Σ `file.size` +
 * Σ known w×h, retained originals included) BEFORE the prepare loop
 * materializes staged bytes: an early single-path decision skips
 * staging K-way fan-out inputs that the gate would reject afterwards
 * anyway. Evaluating it again post-stage on staged sizes is harmless
 * (same answer, same small-batch behavior).
 */
export function resolveShardCount(
  pageCount: number,
  options?: {
    hardwareConcurrency?: number;
    totalBytes?: number;
    totalPixels?: number;
    /**
     * Estimated sub-PDF output bytes (`estimateShardOutputBytes`, P3 item
     * 7). Absent keeps the historical input+pixel gates byte-for-byte.
     */
    totalOutputBytes?: number;
  },
): number {
  if (pageCount < SHARD_THRESHOLD_PAGES) return 1;
  if (options?.totalBytes !== undefined && options.totalBytes > MAX_SHARD_IN_FLIGHT_BYTES) {
    return 1;
  }
  if (
    options?.totalOutputBytes !== undefined &&
    options.totalOutputBytes > MAX_SHARD_IN_FLIGHT_BYTES
  ) {
    return 1;
  }
  if (options?.totalPixels !== undefined && options.totalPixels > MAX_SHARD_PIXELS) {
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

/**
 * Sum of decode cost (pixels) across staged images plus retained scan
 * originals (5-3 pixel-gate input). Retained originals are compressed
 * handles, not decoded bitmaps, so they stand in for latent tab memory
 * held alongside the build — deliberately conservative. Missing pixel
 * entries (batches prepared before dims were plumbed) count as zero:
 * the byte gate below still bounds those batches exactly as before.
 */
export function estimatePixelCost(
  stagedPixels: readonly number[] | undefined,
  retainedPixels: readonly number[] | undefined,
): number {
  const sum = (sizes: readonly number[] | undefined): number =>
    sizes === undefined ? 0 : sizes.reduce((total, pixels) => total + Math.max(0, pixels), 0);
  return sum(stagedPixels) + sum(retainedPixels);
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
    const isAborted = (): boolean => cancelled || input.signal?.aborted === true;
    // Staging-abort forwarding: the same controller that aborts the
    // prepare loop also aborts sharded work — an abort between phases or
    // mid-shard fails honestly with CANCELLED and cancels in-flight jobs.
    const onAbortSignal = (): void => {
      cancelled = true;
      for (const job of [...active]) {
        void job.cancel().catch(() => undefined);
      }
    };
    input.signal?.addEventListener('abort', onAbortSignal, { once: true });
    try {
      if (isAborted()) throw cancelledError();
      const shardCount = resolveShardCount(pageCount, {
        hardwareConcurrency: input.hardwareConcurrency,
        totalBytes: estimateInFlightBytes(input.stagedSizes),
        totalPixels: estimatePixelCost(input.stagedPixels, input.retainedPixels),
        // P3 item 7: estimated sub-PDF outputs join the gate — absent
        // kinds default to 'unknown' (conservative), so callers that
        // thread real kinds (ImagesTool) keep JPEG batches sharding while
        // unknown batches gate early.
        totalOutputBytes: estimateShardOutputBytes(
          input.stagedSizes,
          input.stagedKinds,
          input.stagedPixels,
        ),
      });

      if (shardCount <= 1) {
        // Historical single-worker path, unchanged: same operation, same
        // ids, same options, same progress passthrough.
        if (isAborted()) throw cancelledError();
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
      // Shards run concurrently (`Promise.all` below), so wall time is the
      // slowest shard — never the sum. The engine duration of each single
      // run stays authoritative (D4); this only combines the parallel
      // spans honestly before adding the sequential merge wall.
      let maxShardDurationMs = 0;
      const shardMarks: StudioPerfMark[] = [];
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
      for (let i = 0; i < shardResults.length; i += 1) {
        const shard = shardResults[i];
        maxShardDurationMs = Math.max(maxShardDurationMs, shard.durationMs);
        // Keep per-shard attribution spans when present (DEV-only):
        // namespaced by shard so concurrent spans stay distinguishable.
        if (shard.perfMarks !== undefined) {
          for (const mark of shard.perfMarks) {
            shardMarks.push({ ...mark, name: `shard:${i + 1}:${mark.name}` });
          }
        }
      }
      reportShards();

      if (isAborted()) throw cancelledError();

      // Ordered merge through temp studio docs (RotateTool pattern).
      const tempIds: string[] = [];
      try {
        for (let i = 0; i < shardResults.length; i += 1) {
          if (isAborted()) throw cancelledError();
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
        if (isAborted()) throw cancelledError();
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
          // Parallel shard wall (max) + sequential merge wall — not the sum.
          const durationMs = maxShardDurationMs + merged.durationMs;
          if (shardMarks.length > 0 || merged.perfMarks !== undefined) {
            return {
              ...merged,
              durationMs,
              perfMarks: [...shardMarks, ...(merged.perfMarks ?? [])],
            };
          }
          return { ...merged, durationMs };
        } finally {
          active.delete(job);
          mergeJob = null;
        }
      } finally {
        for (const id of tempIds) {
          await deps.closeDoc(id).catch(() => undefined);
        }
      }
    } finally {
      input.signal?.removeEventListener('abort', onAbortSignal);
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
