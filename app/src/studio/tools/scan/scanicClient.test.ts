// @vitest-environment node
/**
 * `ScanicClient` tests with a FakeWorker: lazy single-worker creation,
 * transfer semantics (the exact pixel buffer is posted as transferable),
 * response mapping/rebuilding, validation-before-transfer, terminate-to-cancel
 * with epoch-guarded late results, and transparent recreate after a crash.
 */
import { describe, expect, it } from 'vitest';
import './scanicTestImageData';
import { DEFAULT_DETECTOR } from './detectorPolicy';
import { ScanicClient } from './scanicClient';
import { SCANIC_WORKER_PROTOCOL_VERSION, type ScanicCorners } from './scanicProtocol';

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
    await expect(promise).resolves.toEqual({
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
    await expect(again).resolves.toEqual({
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
  it('forces the ML attempt even when the default path resolved classical, and transfers the buffer', async () => {
    const workers: FakeWorker[] = [];
    const client = new ScanicClient({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      // A cached warm-failure policy would resolve detect() to classical;
      // redetect() must bypass it and force ML.
      defaultDetector: () => 'classical',
    });

    const firstImage = new ImageData(2, 2);
    const first = client.detect(firstImage);
    expect(workers[0].posts[0].message.detector).toBe('classical');
    expect(workers[0].posts[0].transfer).toEqual([firstImage.data.buffer]);
    workers[0].deliver(detectReply(workers[0].posts[0].message.id, { detector: 'classical' }));
    await expect(first).resolves.toMatchObject({ detector: 'classical' });

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
