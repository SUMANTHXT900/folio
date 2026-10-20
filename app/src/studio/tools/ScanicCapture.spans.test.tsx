/**
 * ScanicCapture F-22 shutter-localize tests: dev-gated span marks across the
 * capture pipeline (enqueue → strip → drain → warp → build) plus the single
 * `console.table` on completion. Gate-off records nothing.
 *
 * `ScanicClient` is doubled exactly like `ScanicCapture.test.tsx` (jsdom has
 * no workers/camera/canvas 2D/WASM); this file pins only the spans contract,
 * never the P2 race behavior.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScanicCapture from './ScanicCapture';
import { getCaptureSpans } from './captureSpans';
import type { ScanicCorners } from './scan/index';

const { __clientMocks, __poolMocks } = vi.hoisted(() => ({
  __clientMocks: { detect: vi.fn(), extract: vi.fn(), terminate: vi.fn() },
  __poolMocks: {
    releaseRetained: vi.fn(),
    releaseOwned: vi.fn(),
    acquire: vi.fn(),
    lane: vi.fn(),
  },
}));

vi.mock('./scan/scanicClient', () => ({
  ScanicClient: vi.fn(function (this: unknown) {
    return __clientMocks;
  }),
  ScanicClientError: class ScanicClientError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'ScanicClientError';
      this.code = code;
    }
  },
  getRetainedDetectClient: vi.fn(() => __clientMocks),
  releaseRetainedDetectClient: (...args: unknown[]) => {
    void (__poolMocks.releaseRetained as (...a: unknown[]) => unknown)(...args);
  },
  acquireDetectionPool: (workerCount: unknown) => {
    void (__poolMocks.acquire as (...a: unknown[]) => unknown)(workerCount);
    const count = Math.max(1, Math.floor(typeof workerCount === 'number' ? workerCount : 1));
    return {
      clients: Array.from({ length: count }, () => __clientMocks),
      releaseOwned: (...args: unknown[]) => {
        void (__poolMocks.releaseOwned as (...a: unknown[]) => unknown)(...args);
      },
    };
  },
  detectionLaneClient: (pool: unknown[], workerIndex: number) => {
    void (__poolMocks.lane as (...a: unknown[]) => unknown)(pool, workerIndex);
    return pool[workerIndex];
  },
}));

const mockDetect = __clientMocks.detect;
const mockWarpExtract = __clientMocks.extract;

const W = 640;
const H = 480;

function detectedCorners(): ScanicCorners {
  return {
    topLeft: { x: 64, y: 48 },
    topRight: { x: 576, y: 48 },
    bottomRight: { x: 576, y: 432 },
    bottomLeft: { x: 64, y: 432 },
  };
}

function photo(name: string, bytes: number[]): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
}

function q(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el as HTMLElement;
}

async function findQ(sel: string): Promise<HTMLElement> {
  await waitFor(() => {
    if (!document.querySelector(sel)) throw new Error(`missing element ${sel}`);
  });
  return q(sel);
}

const realLocation = window.location;

function stubHostname(hostname: string) {
  Object.defineProperty(window, 'location', {
    value: { hostname },
    configurable: true,
    writable: true,
  });
}

let urlCounter = 0;

beforeEach(() => {
  stubHostname('localhost');
  urlCounter = 0;
  URL.createObjectURL = vi.fn(() => {
    urlCounter += 1;
    return `blob:mock-${urlCounter}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
    cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
  };
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = W;
      naturalHeight = H;
      width = W;
      height = H;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    },
  );
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: () => undefined,
    putImageData: () => undefined,
    getImageData: () => ({
      width: W,
      height: H,
      data: new Uint8ClampedArray(W * H * 4),
    }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  mockDetect.mockResolvedValue({
    success: true,
    corners: detectedCorners(),
    confidence: 0.9,
    detector: 'ml',
  });
  mockWarpExtract.mockResolvedValue({
    width: W,
    height: H,
    data: new Uint8ClampedArray(W * H * 4),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.style.overflow = '';
  Object.defineProperty(window, 'location', {
    value: realLocation,
    configurable: true,
    writable: true,
  });
  // @ts-expect-error test-only cleanup of the canvas export stub
  if ('toBlob' in HTMLCanvasElement.prototype) delete HTMLCanvasElement.prototype.toBlob;
});

/** Steps recorded so far, in order. */
function steps(): string[] {
  return getCaptureSpans().map((s) => s.step);
}

/** Asserts `wanted` appears as an ordered subsequence of the recorded steps. */
function expectSubsequence(wanted: string[]) {
  const got = steps();
  let at = 0;
  for (const step of wanted) {
    const found = got.indexOf(step, at);
    expect(found).toBeGreaterThanOrEqual(0);
    at = found + 1;
  }
}

describe('capture pipeline spans (gate on)', () => {
  it('marks enqueue → strip → drain → warp → build in order, then tables once', async () => {
    const table = vi.spyOn(console, 'table').mockImplementation(() => undefined);
    const onCommit = vi.fn();
    render(<ScanicCapture onCommit={onCommit} onExit={() => undefined} />);

    // Shoot one photo via the file fallback (same enqueue path as the shutter).
    fireEvent.change(screen.getByLabelText('Add image files instead'), {
      target: { files: [photo('a.jpg', [1, 2])] },
    });
    fireEvent.click(await findQ('[data-review-cta]'));
    await findQ('[data-scan-queue]');
    await waitFor(() => {
      expect(document.querySelector('[data-review-preparing]')).toBeNull();
    });
    // Eager warp commits the single canvas.
    await findQ('[data-crop-result-img]');
    expectSubsequence([
      'file-parked',
      'thumb-url',
      'strip-rendered',
      'drain-decode',
      'drain-detect',
      'drain-commit',
      'drain-warp',
      'drain-commit',
    ]);

    // Deltas stay sane: non-negative, totals monotonic.
    let total = -1;
    for (const s of getCaptureSpans()) {
      expect(s.ms).toBeGreaterThanOrEqual(0);
      expect(s.totalMs).toBeGreaterThanOrEqual(total);
      total = s.totalMs;
    }

    // Review → done → build: completion tables exactly once.
    fireEvent.click(screen.getByText('Next', { exact: true }));
    await screen.findByText('All pages ready');
    fireEvent.click(screen.getByText('Build PDF', { exact: true }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expectSubsequence(['build-start', 'build-end']);
    expect(table).toHaveBeenCalledTimes(1);
  });
});

describe('capture pipeline spans (gate off)', () => {
  it('records zero marks and never tables on the production host', async () => {
    stubHostname('folio-pdf.pages.dev');
    const table = vi.spyOn(console, 'table').mockImplementation(() => undefined);
    const onCommit = vi.fn();
    render(<ScanicCapture onCommit={onCommit} onExit={() => undefined} />);

    fireEvent.change(screen.getByLabelText('Add image files instead'), {
      target: { files: [photo('a.jpg', [1, 2])] },
    });
    fireEvent.click(await findQ('[data-review-cta]'));
    await findQ('[data-scan-queue]');
    await waitFor(() => {
      expect(document.querySelector('[data-review-preparing]')).toBeNull();
    });
    fireEvent.click(screen.getByText('Next', { exact: true }));
    await screen.findByText('All pages ready');
    fireEvent.click(screen.getByText('Build PDF', { exact: true }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));

    expect(getCaptureSpans()).toEqual([]);
    expect(table).not.toHaveBeenCalled();
  });
});
