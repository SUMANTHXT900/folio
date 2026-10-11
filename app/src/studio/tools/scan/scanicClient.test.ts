// @vitest-environment node
/**
 * `ScanicClient` tests with a FakeWorker: lazy single-worker creation,
 * transfer semantics (the exact pixel buffer is posted as transferable),
 * response mapping/rebuilding, validation-before-transfer, terminate-to-cancel
 * with epoch-guarded late results, and transparent recreate after a crash.
 */
import { afterEach, describe, expect, it } from 'vitest';
import './scanicTestImageData';
import { DEFAULT_DETECTOR, ML_MODEL_INPUT_SIZE } from './detectorPolicy';
import {
  ScanicClient,
  acquireDetectionPool,
  detectionLaneClient,
  getRetainedDetectClient,
  redetect as redetectViaRetained,
  releaseRetainedDetectClient,
} from './scanicClient';
import {
  SCANIC_WORKER_PROTOCOL_VERSION,
  type ScanicCorners,
  type ScanicDetectionResult,
} from './scanicProtocol';

const CORNERS: ScanicCorners = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 1, y: 0 },
  bottomRight: { x: 1, y: 1 },
  bottomLeft: { x: 0, y: 1 },
};

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posts: Array<{ message: Record<string, unknown>; transfer: Transferable[] }> = [];
  terminated = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posts.push({ message: message as Record<string, unknown>, transfer: transfer ?? [] });
  }

  terminate(): void {
    this.terminated = true;
  }

  deliver(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  crash(message = 'worker boom'): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function makeClient(): { client: ScanicClient; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const client = new ScanicClient({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  return { client, workers };
}

function detectReply(id: unknown, overrides: Record<string, unknown> = {}): object {
  return {
    protocol: SCANIC_WORKER_PROTOCOL_VERSION,
    kind: 'detect-result',
    id,
    result: { success: true, corners: CORNERS, confidence: 0.9, detector: 'ml', ...overrides },
  };
}

describe('ScanicClient.detect', () => {
  it('creates the worker lazily, transfers the pixel buffer, and maps the result', async () => {
    const { client, workers } = makeClient();
    expect(workers).toHaveLength(0);

    const image = new ImageData(2, 2);
    const promise = client.detect(image);
    expect(workers).toHaveLength(1);
    const [post] = workers[0].posts;
    expect(post.message.kind).toBe('detect');
    expect(post.message.protocol).toBe(SCANIC_WORKER_PROTOCOL_VERSION);
    // ML-first default (D35): no detector argument means the policy default.
    expect(post.message.detector).toBe(DEFAULT_DETECTOR);
    expect(post.message.width).toBe(2);
    expect(post.message.height).toBe(2);
    // The exact pixel buffer crosses as a transferred buffer (neuter-on-send).
    expect(post.transfer).toEqual([image.data.buffer]);
    expect(post.message.buffer).toBe(image.data.buffer);

    workers[0].deliver(detectReply(post.message.id));
    await expect(promise).resolves.toMatchObject({
      success: true,
      corners: CORNERS,
      confidence: 0.9,
      detector: 'ml',
    });

    // Init-once: the next request reuses the same worker.
    const again = client.detect(new ImageData(1, 1), 'ml');
    expect(workers).toHaveLength(1);
    const second = workers[0].posts[1];
    expect(second.message.detector).toBe('ml');
    workers[0].deliver(
      detectReply(second?.message.id, { success: false, corners: null, confidence: null }),
    );
    await expect(again).resolves.toMatchObject({
      success: false,
      corners: null,
      confidence: null,
      detector: 'ml',
    });
  });

  it('copies a view over a larger buffer down to its exact range before transfer', async () => {
    const { client, workers } = makeClient();
    const backing = new ArrayBuffer(2 * 2 * 4 + 32);
    const view = new Uint8ClampedArray(backing, 16, 2 * 2 * 4);
    const image = new ImageData(view, 2, 2);

    void client.detect(image);
    const [post] = workers[0].posts;
    expect(post.message.buffer).not.toBe(backing);
    expect((post.message.buffer as ArrayBuffer).byteLength).toBe(16);
  });

  it('neuters the sent pixel buffer (real transfer semantics)', async () => {
    // A worker double that performs the transfer for real: structuredClone
    // detaches the moved buffer exactly like postMessage does in a browser.
    const worker = new FakeWorker();
    worker.postMessage = (message: unknown, transfer?: Transferable[]): void => {
      structuredClone(message, { transfer: transfer ?? [] });
      FakeWorker.prototype.postMessage.call(worker, message, transfer);
    };
    const client = new ScanicClient({ createWorker: () => worker as unknown as Worker });

    const image = new ImageData(2, 2);
    expect(image.data.byteLength).toBe(16);
    void client.detect(image);
    expect(image.data.byteLength).toBe(0); // Neuter-on-send.
  });

  it('propagates a worker error reply as a rejection', async () => {
    const { client, workers } = makeClient();
    const promise = client.detect(new ImageData(1, 1));
    workers[0].deliver({
      protocol: SCANIC_WORKER_PROTOCOL_VERSION,
      kind: 'error',
      id: 1,
      message: 'scanic worker received invalid image dimensions (0x0)',
    });
    await expect(promise).rejects.toThrow(/invalid image dimensions/);
  });
});

describe('ScanicClient.redetect', () => {
  it('always sends ML (D46: no classical path) and transfers the buffer', async () => {
    const workers: FakeWorker[] = [];
    const client = new ScanicClient({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });

    const firstImage = new ImageData(2, 2);
    const first = client.detect(firstImage);
    expect(workers[0].posts[0].message.detector).toBe('ml');
    expect(workers[0].posts[0].transfer).toEqual([firstImage.data.buffer]);
    workers[0].deliver(detectReply(workers[0].posts[0].message.id, { detector: 'ml' }));
    await expect(first).resolves.toMatchObject({ detector: 'ml' });

    const secondImage = new ImageData(2, 2);
    const second = client.redetect(secondImage);
    expect(workers[0].posts[1].message.detector).toBe(DEFAULT_DETECTOR);
    expect(workers[0].posts[1].transfer).toEqual([secondImage.data.buffer]);
    workers[0].deliver(detectReply(workers[0].posts[1].message.id));
    await expect(second).resolves.toMatchObject({ success: true, detector: 'ml' });
  });
});

describe('ScanicClient.extract', () => {
  it('transfers the full-res buffer and rebuilds the warped ImageData from the reply', async () => {
    const { client, workers } = makeClient();
    const image = new ImageData(2, 2);
    const promise = client.extract(image, CORNERS);
    const [post] = workers[0].posts;
    expect(post.message.kind).toBe('extract');
    expect(post.message.corners).toEqual(CORNERS);
    expect(post.transfer).toEqual([image.data.buffer]);

    const buffer = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255,
    ]).buffer;
    workers[0].deliver({
      protocol: SCANIC_WORKER_PROTOCOL_VERSION,
      kind: 'extract-result',
      id: post.message.id,
      width: 2,
      height: 2,
      buffer,
    });
    const warped = await promise;
    expect(warped.width).toBe(2);
    expect(warped.height).toBe(2);
    expect(Array.from(warped.data.slice(0, 8))).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('rejects invalid corners BEFORE creating a worker or transferring bytes', async () => {
    const { client, workers } = makeClient();
    const collapsed: ScanicCorners = { ...CORNERS, topRight: { ...CORNERS.topLeft } };
    await expect(client.extract(new ImageData(1, 1), collapsed)).rejects.toMatchObject({
      code: 'invalid-corners',
    });
    expect(workers).toHaveLength(0);
  });

  it('rejects a malformed warp reply instead of constructing a broken ImageData', async () => {
    const { client, workers } = makeClient();
    const promise = client.extract(new ImageData(1, 1), CORNERS);
    const [post] = workers[0].posts;
    workers[0].deliver({
      protocol: SCANIC_WORKER_PROTOCOL_VERSION,
      kind: 'extract-result',
      id: post.message.id,
      width: 2,
      height: 2,
      buffer: new ArrayBuffer(4), // 2×2 RGBA needs 16 bytes.
    });
    await expect(promise).rejects.toMatchObject({ code: 'worker-response' });
  });
});

describe('ScanicClient.detect instrumentation', () => {
  it('backfills client-known instrumentation when the worker predates it', async () => {
    const { client, workers } = makeClient();
    const promise = client.detect(new ImageData(2, 2));
    const [post] = workers[0].posts;
    workers[0].deliver(detectReply(post.message.id)); // No `instrumentation` on the wire.
    const result = await promise;
    expect(result.instrumentation).toEqual({
      decodeMs: null,
      transferBytes: 2 * 2 * 4,
      ortLoadMs: null,
      sessionCreateMs: null,
      inferenceMs: null,
      confidence: 0.9,
      inputWidth: 2,
      inputHeight: 2,
      modelInputSize: ML_MODEL_INPUT_SIZE,
    });
  });

  it('applies caller-supplied decodeMs over a backfilled result', async () => {
    const { client, workers } = makeClient();
    const promise = client.detect(new ImageData(1, 1), 'ml', { decodeMs: 3.25 });
    const [post] = workers[0].posts;
    workers[0].deliver(detectReply(post.message.id));
    const result = await promise;
    expect(result.instrumentation).toMatchObject({ decodeMs: 3.25, transferBytes: 4 });
  });

  it('keeps worker-produced ORT timings and only overrides decodeMs', async () => {
    const { client, workers } = makeClient();
    const promise = client.detect(new ImageData(2, 2), 'ml', { decodeMs: 9 });
    const [post] = workers[0].posts;
    workers[0].deliver({
      protocol: SCANIC_WORKER_PROTOCOL_VERSION,
      kind: 'detect-result',
      id: post.message.id,
      result: {
        success: true,
        corners: CORNERS,
        confidence: 0.7,
        detector: 'ml',
        instrumentation: {
          decodeMs: null,
          transferBytes: 16,
          ortLoadMs: 40,
          sessionCreateMs: null,
          inferenceMs: 11,
          confidence: 0.7,
          inputWidth: 2,
          inputHeight: 2,
          modelInputSize: ML_MODEL_INPUT_SIZE,
        },
      },
    });
    const result = await promise;
    expect(result.instrumentation).toEqual({
      decodeMs: 9,
      transferBytes: 16,
      ortLoadMs: 40,
      sessionCreateMs: null,
      inferenceMs: 11,
      confidence: 0.7,
      inputWidth: 2,
      inputHeight: 2,
      modelInputSize: ML_MODEL_INPUT_SIZE,
    });
  });
});

describe('retained detect client (mount lifetime)', () => {
  afterEach(() => {
    releaseRetainedDetectClient();
  });

  function countingFactory(counter: { creations: number }): {
    createWorker: () => Worker;
    workers: FakeWorker[];
  } {
    const workers: FakeWorker[] = [];
    return {
      workers,
      createWorker: () => {
        counter.creations += 1;
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    };
  }

  it('creates once and reuses across calls (one cold session create)', async () => {
    const counter = { creations: 0 };
    const { createWorker, workers } = countingFactory(counter);
    const first = getRetainedDetectClient({ createWorker });
    const second = getRetainedDetectClient({ createWorker });
    expect(second).toBe(first);
    expect(counter.creations).toBe(0); // Lazy: no worker until first use.

    const pending = first.detect(new ImageData(2, 2));
    expect(counter.creations).toBe(1);
    // Second client handle, same worker — no new session.
    const pending2 = second.detect(new ImageData(1, 1));
    expect(counter.creations).toBe(1);
    expect(workers).toHaveLength(1);
    workers[0].deliver(detectReply(workers[0].posts[0].message.id));
    workers[0].deliver(
      detectReply(workers[0].posts[1].message.id, {
        success: false,
        corners: null,
        confidence: null,
      }),
    );
    await expect(pending).resolves.toMatchObject({ success: true });
    await expect(pending2).resolves.toMatchObject({ success: false });
  });

  it('release terminates the worker and the next use starts cold', async () => {
    const counter = { creations: 0 };
    const { createWorker, workers } = countingFactory(counter);
    const first = getRetainedDetectClient({ createWorker });
    // Park an in-flight request so release has something to cancel.
    const pending = first.detect(new ImageData(1, 1));
    releaseRetainedDetectClient();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(workers[0].terminated).toBe(true);

    const next = getRetainedDetectClient({ createWorker });
    expect(next).not.toBe(first);
    const retry = next.detect(new ImageData(1, 1));
    expect(counter.creations).toBe(2);
    const worker = workers[1];
    worker.deliver(detectReply(worker.posts[0].message.id));
    await expect(retry).resolves.toMatchObject({ success: true });
    releaseRetainedDetectClient();
  });

  it('module redetect() is served by the retained client', async () => {
    const counter = { creations: 0 };
    const { createWorker, workers } = countingFactory(counter);
    getRetainedDetectClient({ createWorker });
    const promise = redetectViaRetained(new ImageData(2, 2));
    expect(workers).toHaveLength(1);
    expect(workers[0].posts[0].message.detector).toBe(DEFAULT_DETECTOR);
    workers[0].deliver(detectReply(workers[0].posts[0].message.id));
    await expect(promise).resolves.toMatchObject({ success: true, detector: 'ml' });
    expect(counter.creations).toBe(1);
  });
});

describe('acquireDetectionPool (retained-preferring K lanes)', () => {
  afterEach(() => {
    releaseRetainedDetectClient();
  });

  /**
   * Session-creation counting driver: workers are lazy (a `ScanicClient`
   * creates its worker on first USE), so a "cold session create" is
   * observed exactly when a lane's first `detect()` runs. `detectAndSettle`
   * runs one detect per lane and answers it, so `counter.creations` counts
   * warmed sessions across simulated drains.
   */
  function makeDriver(): {
    createWorker: () => Worker;
    counter: { creations: number };
    detectAndSettle: (client: ScanicClient) => Promise<ScanicDetectionResult>;
  } {
    const workers: FakeWorker[] = [];
    const consumed = new Map<FakeWorker, number>();
    const counter = { creations: 0 };
    return {
      counter,
      createWorker: () => {
        counter.creations += 1;
        const worker = new FakeWorker();
        workers.push(worker);
        consumed.set(worker, 0);
        return worker as unknown as Worker;
      },
      detectAndSettle: async (client: ScanicClient) => {
        const promise = client.detect(new ImageData(2, 2));
        const worker = workers.find(
          (candidate) => (consumed.get(candidate) ?? 0) < candidate.posts.length,
        );
        if (worker === undefined) throw new Error('no posted worker for detect');
        const post = worker.posts[consumed.get(worker) ?? 0];
        consumed.set(worker, (consumed.get(worker) ?? 0) + 1);
        worker.deliver(detectReply(post.message.id));
        return promise;
      },
    };
  }

  it('staffs lane 0 with the retained client and reuses it across drains', async () => {
    const { createWorker, counter, detectAndSettle } = makeDriver();
    // First drain of K=3: 1 retained + 2 fresh = 3 cold session creates.
    const first = acquireDetectionPool(3, { createWorker });
    expect(first.clients).toHaveLength(3);
    await Promise.all(first.clients.map((client) => detectAndSettle(client)));
    expect(counter.creations).toBe(3);
    expect(first.clients[0]).toBe(getRetainedDetectClient());
    first.releaseOwned();

    // Second drain: retained lane reused — only the 2 fresh lanes recreate.
    const second = acquireDetectionPool(3, { createWorker });
    expect(second.clients).toHaveLength(3);
    expect(second.clients[0]).toBe(first.clients[0]);
    expect(second.clients[1]).not.toBe(first.clients[1]);
    await Promise.all(second.clients.map((client) => detectAndSettle(client)));
    expect(counter.creations).toBe(5);
    second.releaseOwned();
    releaseRetainedDetectClient();
    expect(counter.creations).toBe(5); // Release creates nothing.
  });

  it('releaseOwned terminates fresh lanes but keeps the retained lane warm', async () => {
    const { createWorker, counter, detectAndSettle } = makeDriver();
    const pool = acquireDetectionPool(2, { createWorker });
    const retained = pool.clients[0];
    await Promise.all(pool.clients.map((client) => detectAndSettle(client)));
    expect(counter.creations).toBe(2);
    pool.releaseOwned();
    // Retained survives releaseOwned: still the same instance afterwards,
    // and its next detect reuses the warm worker (no new session create).
    expect(getRetainedDetectClient()).toBe(retained);
    await detectAndSettle(retained);
    expect(counter.creations).toBe(2);
  });

  it('preferRetained:false staffs all-fresh lanes', async () => {
    const { createWorker, counter, detectAndSettle } = makeDriver();
    const pool = acquireDetectionPool(2, { createWorker, preferRetained: false });
    expect(pool.clients).toHaveLength(2);
    await Promise.all(pool.clients.map((client) => detectAndSettle(client)));
    expect(counter.creations).toBe(2);
    pool.releaseOwned();
  });

  it('clamps to at least 1 lane', () => {
    const { createWorker } = makeDriver();
    const pool = acquireDetectionPool(0, { createWorker });
    expect(pool.clients).toHaveLength(1);
    expect(pool.clients[0]).toBe(getRetainedDetectClient());
    pool.releaseOwned();
  });
});

describe('detectionLaneClient (no-modulo lane indexing)', () => {
  it('indexes lanes directly and rejects out-of-range lanes loudly', () => {
    const { client } = makeClient();
    const pool = [
      client,
      new ScanicClient({ createWorker: () => new FakeWorker() as unknown as Worker }),
    ];
    expect(detectionLaneClient(pool, 0)).toBe(client);
    expect(detectionLaneClient(pool, 1)).toBe(pool[1]);
    expect(() => detectionLaneClient(pool, 2)).toThrow(/lane 2 has no client/);
  });
});

describe('ScanicClient cancellation and worker lifecycle', () => {
  it('terminate rejects pending work as cancelled, drops late results, and recreates', async () => {
    const { client, workers } = makeClient();
    const promise = client.detect(new ImageData(1, 1));
    expect(workers).toHaveLength(1);

    client.terminate();
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(workers[0].terminated).toBe(true);

    // A late result from the dead generation must never resolve anything.
    workers[0].deliver(detectReply(1));
    expect(client.droppedMessages).toBe(1);

    // The next request transparently recreates the worker.
    const retry = client.detect(new ImageData(1, 1));
    expect(workers).toHaveLength(2);
    const [post] = workers[1].posts;
    workers[1].deliver(detectReply(post.message.id));
    await expect(retry).resolves.toMatchObject({ success: true });
  });

  it('a worker crash rejects pending work as worker-crashed and recreates transparently', async () => {
    const { client, workers } = makeClient();
    const promise = client.detect(new ImageData(1, 1));
    workers[0].crash('scanic WASM exploded');
    await expect(promise).rejects.toMatchObject({ code: 'worker-crashed' });
    expect(workers[0].terminated).toBe(true);

    const retry = client.detect(new ImageData(1, 1));
    expect(workers).toHaveLength(2);
    expect(workers[1].posts).toHaveLength(1);
    const [post] = workers[1].posts;
    workers[1].deliver(detectReply(post.message.id));
    await expect(retry).resolves.toMatchObject({ success: true });
  });

  it('drops malformed and unknown-id messages with a diagnostic count', async () => {
    const { client, workers } = makeClient();
    void client.detect(new ImageData(1, 1));
    const worker = workers[0];
    worker.deliver(null);
    worker.deliver('nonsense');
    worker.deliver({ protocol: 999, kind: 'detect-result', id: 1, result: {} });
    worker.deliver({ protocol: SCANIC_WORKER_PROTOCOL_VERSION, kind: 'mystery', id: 1 });
    worker.deliver({ protocol: SCANIC_WORKER_PROTOCOL_VERSION, kind: 'detect-result', id: 'one' });
    worker.deliver(detectReply(98)); // Unknown request id.
    expect(client.droppedMessages).toBe(6);
  });
});
