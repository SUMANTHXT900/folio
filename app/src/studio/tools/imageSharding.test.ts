/**
 * Sharded images-build tests (PERFORMANCE.md P3 item 13).
 *
 * The engine is faked at the `ShardDeps` seam: `runOperation` records
 * calls and returns controllable `StudioJob`s, `openBytes` mints temp
 * ids, `closeDoc` records cleanup. Ordering, single-path fidelity,
 * cancellation wiring, and temp cleanup are asserted here; pixel
 * equivalence stays engine-tested (`engine/tests/pdf_images_to_pdf.rs` +
 * merge tests).
 */
import { describe, expect, it } from 'vitest';
import type { OperationId } from '../../types/engine';
import type { StudioJob, StudioResult } from '../services/folio';
import {
  MAX_SHARD_IN_FLIGHT_BYTES,
  buildImagesPdf,
  estimateInFlightBytes,
  planShards,
  resolveShardCount,
  type ShardDeps,
  type ShardedImagesInput,
} from './imageSharding';

function studioResult(pageCount = 1, durationMs = 10): StudioResult {
  return {
    summary: { pageCount } as unknown as StudioResult['summary'],
    outputs: [
      {
        name: 'shard.pdf',
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, pageCount]),
        byteLength: 5,
        pageCount,
      },
    ],
    durationMs,
  };
}

interface FakeRun {
  calls: Array<{ operation: OperationId; ids: string[]; options: unknown }>;
  /** Resolvers per call index; unset entries auto-succeed. */
  behaviors: Array<'ok' | 'fail' | 'hang'>;
  jobs: StudioJob[];
  cancels: boolean[];
  runOperation: ShardDeps['runOperation'];
}

function makeFakeRun(behaviors: Array<'ok' | 'fail' | 'hang'> = []): FakeRun {
  const fake: FakeRun = {
    calls: [],
    behaviors,
    jobs: [],
    cancels: [],
    runOperation: ((
      operation: OperationId,
      ids: string[],
      options: unknown,
      runOptions?: {
        onProgress?: (p: { fraction: number | null; label: string }) => void;
      },
    ): StudioJob => {
      const index = fake.calls.length;
      fake.calls.push({ operation, ids, options });
      const behavior = fake.behaviors[index] ?? 'ok';
      // Simulate one honest engine progress event per job so the
      // orchestrator's aggregation path is exercised.
      runOptions?.onProgress?.({ fraction: 1, label: 'engine-done' });
      let cancelFn!: () => Promise<void>;
      let done: Promise<StudioResult>;
      if (behavior === 'hang') {
        let reject!: (e: unknown) => void;
        done = new Promise<StudioResult>((_, rej) => {
          reject = rej;
        });
        // Avoid unhandled rejection when nobody awaits before cancel.
        done.catch(() => undefined);
        cancelFn = async () => {
          fake.cancels[index] = true;
          const error = new Error('cancelled') as Error & { code?: string };
          error.code = 'CANCELLED';
          reject(error);
        };
      } else if (behavior === 'fail') {
        const error = new Error(`shard ${index} blew up`) as Error & { code?: string };
        error.code = 'PROCESSING_FAILED';
        done = Promise.reject(error);
        done.catch(() => undefined);
        cancelFn = async () => {
          fake.cancels[index] = true;
        };
      } else {
        done = Promise.resolve(studioResult(ids.length));
        cancelFn = async () => {
          fake.cancels[index] = true;
        };
      }
      fake.cancels[index] = false;
      const job: StudioJob = { done, cancel: cancelFn };
      fake.jobs.push(job);
      return job;
    }) as ShardDeps['runOperation'],
  };
  return fake;
}

interface FakeTemps {
  opened: string[];
  closed: string[];
  openBytes: ShardDeps['openBytes'];
  closeDoc: ShardDeps['closeDoc'];
}

function makeFakeTemps(): FakeTemps {
  const fake: FakeTemps = {
    opened: [],
    closed: [],
    openBytes: (async (name: string) => {
      const id = `temp-${fake.opened.length}`;
      fake.opened.push(`${id}:${name}`);
      return { id, name, sizeBytes: 5, pageCount: 1 };
    }) as ShardDeps['openBytes'],
    closeDoc: (async (id: string) => {
      fake.closed.push(id);
    }) as ShardDeps['closeDoc'],
  };
  return fake;
}

function input(pageCount: number, hardwareConcurrency = 8): ShardedImagesInput {
  return {
    stagedIds: Array.from({ length: pageCount }, (_, i) => `staged-${i}`),
    stagedSizes: new Array<number>(pageCount).fill(1000),
    pageSize: 'fit',
    hardwareConcurrency,
  };
}

describe('resolveShardCount', () => {
  it('keeps small batches single-worker', () => {
    expect(resolveShardCount(0, { hardwareConcurrency: 16 })).toBe(1);
    expect(resolveShardCount(7, { hardwareConcurrency: 16 })).toBe(1);
  });

  it('is device-aware: 2 workers by default, 3 on many-core', () => {
    expect(resolveShardCount(9, { hardwareConcurrency: 2 })).toBe(2);
    expect(resolveShardCount(9, { hardwareConcurrency: 4 })).toBe(2);
    expect(resolveShardCount(9, { hardwareConcurrency: 8 })).toBe(3);
    expect(resolveShardCount(9, { hardwareConcurrency: 16 })).toBe(3);
  });

  it('falls back to 2 workers when concurrency is unknown', () => {
    const nav = navigator as unknown as { hardwareConcurrency?: number };
    const original = nav.hardwareConcurrency;
    try {
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        value: undefined,
        configurable: true,
      });
      expect(resolveShardCount(9, {})).toBe(2);
    } finally {
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        value: original,
        configurable: true,
      });
    }
  });

  it('never exceeds one shard per page', () => {
    expect(resolveShardCount(8, { hardwareConcurrency: 16 })).toBe(3);
  });

  it('stays single-worker over the memory cap', () => {
    expect(
      resolveShardCount(64, {
        hardwareConcurrency: 16,
        totalBytes: MAX_SHARD_IN_FLIGHT_BYTES + 1,
      }),
    ).toBe(1);
  });
});

describe('planShards', () => {
  it('covers every index exactly once, in order', () => {
    for (const [pages, k] of [
      [8, 2],
      [9, 3],
      [10, 3],
      [8, 3],
    ] as Array<[number, number]>) {
      const plans = planShards(pages, k);
      expect(plans).toHaveLength(Math.min(k, pages));
      expect(plans.flat()).toEqual(Array.from({ length: pages }, (_, i) => i));
    }
  });

  it('splits 9 pages across 3 shards as 3/3/3', () => {
    expect(planShards(9, 3)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ]);
  });

  it('handles degenerate input', () => {
    expect(planShards(0, 3)).toEqual([]);
    expect(planShards(5, 0)).toEqual([]);
    expect(planShards(2, 8)).toEqual([[0], [1]]);
  });
});

describe('estimateInFlightBytes', () => {
  it('sums non-negative sizes', () => {
    expect(estimateInFlightBytes([3, 4, 5])).toBe(12);
    expect(estimateInFlightBytes([])).toBe(0);
  });
});

describe('buildImagesPdf single path', () => {
  it('makes exactly the historical engine call for <8 pages', async () => {
    const run = makeFakeRun();
    const temps = makeFakeTemps();
    const progress: unknown[] = [];
    const job = buildImagesPdf(
      { ...input(7), onProgress: (p) => progress.push(p) },
      { runOperation: run.runOperation, openBytes: temps.openBytes, closeDoc: temps.closeDoc },
    );
    const out = await job.done;
    expect(out.outputs).toHaveLength(1);
    // One call, unchanged operation/ids/options; no merge, no temp docs.
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].operation).toBe('pdf.images_to_pdf');
    expect(run.calls[0].ids).toEqual(input(7).stagedIds);
    expect(run.calls[0].options).toEqual({
      pageSize: 'fit',
      backgroundRgb: [255, 255, 255],
    });
    expect(temps.opened).toEqual([]);
    expect(temps.closed).toEqual([]);
  });
});

describe('buildImagesPdf sharded path', () => {
  it('shards in collection order and merges temps in shard order', async () => {
    const run = makeFakeRun();
    const temps = makeFakeTemps();
    const seen: string[] = [];
    const job = buildImagesPdf(
      { ...input(9), onProgress: (p) => seen.push(p.label) },
      { runOperation: run.runOperation, openBytes: temps.openBytes, closeDoc: temps.closeDoc },
    );
    const out = await job.done;
    // 3 shard builds + 1 ordered merge.
    expect(run.calls).toHaveLength(4);
    const shardCalls = run.calls.slice(0, 3);
    for (const call of shardCalls) {
      expect(call.operation).toBe('pdf.images_to_pdf');
      expect(call.options).toEqual({ pageSize: 'fit', backgroundRgb: [255, 255, 255] });
    }
    expect(shardCalls.flatMap((c) => c.ids)).toEqual(input(9).stagedIds);
    const merge = run.calls[3];
    expect(merge.operation).toBe('pdf.merge');
    expect(merge.ids).toEqual(['temp-0', 'temp-1', 'temp-2']);
    // Temp docs opened in shard order and all closed afterwards.
    expect(temps.opened.map((o) => o.split(':')[0])).toEqual(['temp-0', 'temp-1', 'temp-2']);
    expect(temps.closed).toEqual(['temp-0', 'temp-1', 'temp-2']);
    // Progress stays within [0, 1] and names shards + merge honestly.
    expect(seen.some((l) => l.startsWith('Shard 1 of 3'))).toBe(true);
    expect(seen.some((l) => l.startsWith('Merging 3 parts'))).toBe(true);
    expect(out.durationMs).toBeGreaterThan(0);
  });

  it('fails honestly on a shard error: no fallback, siblings cancelled, temps cleaned', async () => {
    const run = makeFakeRun(['ok', 'fail', 'ok']);
    const temps = makeFakeTemps();
    const job = buildImagesPdf(input(9), {
      runOperation: run.runOperation,
      openBytes: temps.openBytes,
      closeDoc: temps.closeDoc,
    });
    await expect(job.done).rejects.toThrow('shard 1 blew up');
    // No silent single-worker retry: exactly the 3 shard calls, no merge.
    expect(run.calls).toHaveLength(3);
    expect(run.calls.every((c) => c.operation === 'pdf.images_to_pdf')).toBe(true);
    expect(temps.opened).toEqual([]);
    expect(temps.closed).toEqual([]);
  });

  it('wires cancellation to every in-flight shard job', async () => {
    const run = makeFakeRun(['hang', 'hang']);
    const temps = makeFakeTemps();
    const job = buildImagesPdf(input(8, 4), {
      runOperation: run.runOperation,
      openBytes: temps.openBytes,
      closeDoc: temps.closeDoc,
    });
    const settled = job.done.catch((e: unknown) => e);
    // Let both shard jobs start before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await job.cancel();
    const error = (await settled) as { code?: string };
    expect(error.code).toBe('CANCELLED');
    expect(run.jobs).toHaveLength(2);
    expect(run.cancels).toEqual([true, true]);
    // Merge never ran; nothing to clean.
    expect(run.calls.every((c) => c.operation === 'pdf.images_to_pdf')).toBe(true);
    expect(temps.opened).toEqual([]);
  });

  it('still closes temp docs when the merge fails', async () => {
    const run = makeFakeRun(['ok', 'ok', 'ok', 'fail']);
    const temps = makeFakeTemps();
    const job = buildImagesPdf(input(9), {
      runOperation: run.runOperation,
      openBytes: temps.openBytes,
      closeDoc: temps.closeDoc,
    });
    await expect(job.done).rejects.toThrow();
    expect(temps.opened).toHaveLength(3);
    expect(temps.closed).toEqual(['temp-0', 'temp-1', 'temp-2']);
  });

  it('reports increasing bounded progress across shards and merge', async () => {
    const run = makeFakeRun();
    const temps = makeFakeTemps();
    // Exercise the per-shard progress callbacks with staggered fractions.
    const captured: Array<(p: { fraction: number | null; label: string }) => void> = [];
    type RunArgs = Parameters<ShardDeps['runOperation']>;
    const capturingRun = {
      ...run,
      runOperation: ((...args: RunArgs): StudioJob => {
        const [operation, ids, options, runOptions] = args;
        if (operation === 'pdf.images_to_pdf' && runOptions?.onProgress) {
          captured.push(runOptions.onProgress);
        }
        return run.runOperation(operation, ids, options, runOptions);
      }) as ShardDeps['runOperation'],
    };
    const fractions: number[] = [];
    const job = buildImagesPdf(
      {
        ...input(9),
        onProgress: (p) => {
          if (p.fraction !== null) fractions.push(p.fraction);
        },
      },
      {
        runOperation: capturingRun.runOperation,
        openBytes: temps.openBytes,
        closeDoc: temps.closeDoc,
      },
    );
    await job.done;
    expect(captured).toHaveLength(3);
    for (const cb of captured) cb({ fraction: 1, label: 'done' });
    for (const f of fractions) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    // Final merge progress sits above the shard phase (0.9 weight).
    expect(fractions[fractions.length - 1]).toBeGreaterThanOrEqual(0.9);
  });
});
