/**
 * Bare-capture experiment switch (experiment B for F-22) — flag behavior ONLY.
 *
 * `localStorage['folio-bare-capture'] === '1'` takes the sensor-native
 * default (bare `takePhoto()`, no photoSettings, no max request) so the
 * phone can compare max-res vs native-default with measured evidence.
 * Default OFF: absent/invalid values keep the byte-identical max path.
 * The flag is read once per capture (a mid-session toggle applies to the
 * next shutter; nothing is cached across sessions).
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScanicCapture from './ScanicCapture';

// Detection + warp run through `ScanicClient` (module scan worker); jsdom
// has no workers/WASM, so every constructed client shares one set of
// doubles (same shape as ScanicCapture.test.tsx — this file stays scoped to
// the bare-capture flag and never re-pins drain/warp semantics).
const { __clientMocks, __poolMocks } = vi.hoisted(() => ({
  __clientMocks: { detect: vi.fn(), extract: vi.fn(), terminate: vi.fn() },
  __poolMocks: {
    releaseRetained: vi.fn(),
    releaseOwned: vi.fn(),
    acquire: vi.fn(),
    lane: vi.fn(),
  },
}));

// Dev-gate control for the capture-quality toggle: the component reuses
// `isCaptureSpansEnabled()` (no-arg call reads the hostname). The mock
// preserves every other export and only gates the no-arg call, so the
// explicit-hostname unit contract in captureSpans.test.ts is untouched.
const { __spansGate } = vi.hoisted(() => ({ __spansGate: { enabled: true } }));

vi.mock('./captureSpans', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./captureSpans')>();
  return {
    ...orig,
    isCaptureSpansEnabled: (...args: unknown[]) => {
      if (args.length > 0) {
        return (orig.isCaptureSpansEnabled as (...a: never[]) => boolean)(
          ...(args as never[]),
        );
      }
      return __spansGate.enabled;
    },
  };
});

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

/** ImageCapture double: records takePhoto arg lists + capabilities calls. */
function stubImageCapture() {
  const takePhoto = vi.fn(async (_settings?: { imageWidth?: number; imageHeight?: number }) => {
    void _settings;
    return new Blob(['sensor-bytes'], { type: 'image/jpeg' });
  });
  const getPhotoCapabilities = vi.fn(async () => ({
    imageWidth: { max: 4000 },
    imageHeight: { max: 3000 },
  }));
  vi.stubGlobal(
    'ImageCapture',
    class {
      constructor(_track: unknown) {
        void _track;
      }
      getPhotoCapabilities() {
        return getPhotoCapabilities();
      }
      takePhoto(...args: [settings?: { imageWidth?: number; imageHeight?: number }]) {
        // Rest-forward preserves call arity: a bare takePhoto() records
        // zero args, a max capture records one.
        return takePhoto(...args);
      }
    },
  );
  return { takePhoto, getPhotoCapabilities };
}

function mockCameraForShutter() {
  const stop = vi.fn();
  const track = {
    id: 'track-1',
    stop,
    readyState: 'live',
    getCapabilities: () => ({}),
    getSettings: () => ({ width: 1920, height: 1080 }),
    applyConstraints: vi.fn(async () => undefined),
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn(async () => stream),
      enumerateDevices: vi.fn(async () => []),
    },
    configurable: true,
  });
}

function restoreMediaDevices() {
  try {
    // @ts-expect-error test-only teardown
    delete navigator.mediaDevices;
  } catch {
    // jsdom without mediaDevices — nothing to restore.
  }
}

let urlCounter = 0;

beforeEach(() => {
  urlCounter = 0;
  __spansGate.enabled = true;
  try {
    window.localStorage.clear();
  } catch {
    // jsdom without storage — isolation is best-effort.
  }
  URL.createObjectURL = vi.fn(() => {
    urlCounter += 1;
    return `blob:mock-${urlCounter}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  mockDetect.mockResolvedValue({
    success: true,
    corners: null,
    confidence: 0,
    detector: 'ml',
  });
  mockWarpExtract.mockResolvedValue({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
});

afterEach(() => {
  cleanup();
  restoreMediaDevices();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.style.overflow = '';
});

describe('bare-capture experiment flag (folio-bare-capture)', () => {
  it('flag ON calls bare takePhoto() with zero args and skips the max request', async () => {
    const { takePhoto, getPhotoCapabilities } = stubImageCapture();
    mockCameraForShutter();
    window.localStorage.setItem('folio-bare-capture', '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
      await findQ('[data-scan-capture]');
      fireEvent.click(q('[data-scan-capture]'));
      await findQ('[data-review-cta]');
      await waitFor(() => expect(takePhoto).toHaveBeenCalledTimes(1));
      // Zero args: the native default, not the capabilities max.
      expect(takePhoto.mock.calls[0]).toHaveLength(0);
      // The maxW/maxH capabilities round-trip was skipped.
      expect(getPhotoCapabilities).not.toHaveBeenCalled();
      // Single unambiguous phone-console line.
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
    }
  });

  it('flag absent keeps the byte-identical max path (takePhoto with max settings)', async () => {
    const { takePhoto, getPhotoCapabilities } = stubImageCapture();
    mockCameraForShutter();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
      await findQ('[data-scan-capture]');
      fireEvent.click(q('[data-scan-capture]'));
      await findQ('[data-review-cta]');
      await waitFor(() => expect(takePhoto).toHaveBeenCalledTimes(1));
      expect(takePhoto.mock.calls[0]).toEqual([{ imageWidth: 4000, imageHeight: 3000 }]);
      expect(getPhotoCapabilities).toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it.each(['0', 'true', 'TRUE', '2', 'yes', ''])(
    'invalid flag value %j is treated as OFF (max path)',
    async (value) => {
      const { takePhoto } = stubImageCapture();
      mockCameraForShutter();
      window.localStorage.setItem('folio-bare-capture', value);
      render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
      await findQ('[data-scan-capture]');
      fireEvent.click(q('[data-scan-capture]'));
      await findQ('[data-review-cta]');
      await waitFor(() => expect(takePhoto).toHaveBeenCalledTimes(1));
      expect(takePhoto.mock.calls[0]).toEqual([{ imageWidth: 4000, imageHeight: 3000 }]);
    },
  );

  it('flag is read once per capture: toggling mid-session applies to the next shutter (no stale cache)', async () => {
    const { takePhoto } = stubImageCapture();
    mockCameraForShutter();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    // First shutter with the flag OFF: max path (also warms the per-track caps cache).
    fireEvent.click(q('[data-scan-capture]'));
    await findQ('[data-review-cta]');
    await waitFor(() => expect(takePhoto).toHaveBeenCalledTimes(1));
    expect(takePhoto.mock.calls[0]).toEqual([{ imageWidth: 4000, imageHeight: 3000 }]);
    // Toggle ON after render: the next shutter must go bare despite the cache.
    window.localStorage.setItem('folio-bare-capture', '1');
    fireEvent.click(q('[data-scan-capture]'));
    await waitFor(() => expect(takePhoto).toHaveBeenCalledTimes(2));
    expect(takePhoto.mock.calls[1]).toHaveLength(0);
  });
});

describe('capture-quality toggle (dev-gated More-sheet row)', () => {
  function qualityButtons(): { max: HTMLElement; fast: HTMLElement; group: HTMLElement } {
    const group = q('[data-capture-quality]');
    const btns = Array.from(group.querySelectorAll('button'));
    const max = btns.find((b) => b.textContent?.trim() === 'Max detail');
    const fast = btns.find((b) => b.textContent?.trim() === 'Fast capture (test)');
    if (!max || !fast) throw new Error('missing capture-quality options');
    return { max: max as HTMLElement, fast: fast as HTMLElement, group };
  }

  it('renders on dev hosts with honest copy and Max detail selected by default', async () => {
    __spansGate.enabled = true;
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-capture-quality]');
    const { max, fast, group } = qualityButtons();
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Capture quality');
    // 44px segmented targets, same pattern as the Capture mode row.
    for (const btn of [max, fast]) {
      expect(btn.className).toMatch('min-h-[44px]');
    }
    // Honest copy: never implies Fast is better.
    expect(document.querySelector('[data-capture-quality-note]')?.textContent).toBe(
      'Native-default resolution — for measurement only',
    );
    // Default OFF: Max detail pressed, flag untouched.
    expect(max.getAttribute('aria-pressed')).toBe('true');
    expect(fast.getAttribute('aria-pressed')).toBe('false');
    expect(window.localStorage.getItem('folio-bare-capture')).toBeNull();
  });

  it('is hidden on prod hosts while the rest of the More sheet is byte-identical', async () => {
    __spansGate.enabled = false;
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    // Sheet itself still mounts with every production hook…
    await findQ('[data-scan-sheet]');
    expect(document.querySelector('[data-scan-mode]')).not.toBeNull();
    expect(document.querySelector('[data-mirror-toggle]')).not.toBeNull();
    expect(document.querySelector('[data-camera-select]')).not.toBeNull();
    // …but the quality row leaves no trace.
    expect(document.querySelector('[data-capture-quality]')).toBeNull();
    expect(document.querySelector('[data-capture-quality-note]')).toBeNull();
    expect(document.querySelector('[data-scan-sheet]')?.textContent).not.toMatch(
      'Capture quality',
    );
    expect(document.querySelector('[data-scan-sheet]')?.textContent).not.toMatch(
      'Fast capture',
    );
  });

  it('tapping Fast capture sets localStorage 1', async () => {
    __spansGate.enabled = true;
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-capture-quality]');
    const { max, fast } = qualityButtons();
    fireEvent.click(fast);
    expect(window.localStorage.getItem('folio-bare-capture')).toBe('1');
    expect(fast.getAttribute('aria-pressed')).toBe('true');
    expect(max.getAttribute('aria-pressed')).toBe('false');
  });

  it('tapping Max detail clears the flag', async () => {
    __spansGate.enabled = true;
    window.localStorage.setItem('folio-bare-capture', '1');
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-capture-quality]');
    const { max, fast } = qualityButtons();
    // Persisted ON pre-selects Fast on open.
    expect(fast.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(max);
    expect(window.localStorage.getItem('folio-bare-capture')).toBeNull();
    expect(max.getAttribute('aria-pressed')).toBe('true');
    expect(fast.getAttribute('aria-pressed')).toBe('false');
  });

  it('persisted value pre-selects on open (ON selects Fast, absent selects Max)', async () => {
    __spansGate.enabled = true;
    window.localStorage.setItem('folio-bare-capture', '1');
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-capture-quality]');
    let { max, fast } = qualityButtons();
    expect(fast.getAttribute('aria-pressed')).toBe('true');
    expect(max.getAttribute('aria-pressed')).toBe('false');
    cleanup();

    __spansGate.enabled = true;
    window.localStorage.clear();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-capture-quality]');
    ({ max, fast } = qualityButtons());
    expect(max.getAttribute('aria-pressed')).toBe('true');
    expect(fast.getAttribute('aria-pressed')).toBe('false');
  });
});
