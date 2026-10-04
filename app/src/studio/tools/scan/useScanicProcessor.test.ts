/**
 * `useScanicProcessor` tests: capture-order sequential draining under
 * StrictMode (single detect per capture, concurrency 1), ready-entry shape,
 * no-document and failure settlement, buildNow drain semantics, and the
 * keepQueue unmount contract (no URL revocation).
 */
import { act, renderHook } from '@testing-library/react';
import { createElement, StrictMode, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import './scanicTestImageData';
import { useScanicProcessor, type ScanicProcessorOptions } from './useScanicProcessor';
import type { ScanicClient } from './scanicClient';
import type { ScanicCorners, ScanicDetectorKind } from './scanicProtocol';

const CORNERS: ScanicCorners = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 2, y: 0 },
  bottomRight: { x: 2, y: 2 },
  bottomLeft: { x: 0, y: 2 },
};

interface FakeClientHarness {
  client: ScanicClient;
  kinds: string[];
  /** Detector argument per detect call; undefined = client policy default. */
  detectors: Array<ScanicDetectorKind | undefined>;
  maxConcurrent: () => number;
}

function makeFakeClient(
  overrides: {
    detect?: () => Promise<{
      success: boolean;
      corners: ScanicCorners | null;
      confidence: number | null;
      detector: ScanicDetectorKind;
    }>;
  } = {},
): FakeClientHarness {
  const kinds: string[] = [];
  const detectors: Array<ScanicDetectorKind | undefined> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const client = {
    async detect(
      _image: ImageData,
      detector?: ScanicDetectorKind,
    ): Promise<{
      success: boolean;
      corners: ScanicCorners | null;
      confidence: number | null;
      detector: ScanicDetectorKind;
    }> {
      kinds.push('detect');
      detectors.push(detector);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return overrides.detect
          ? await overrides.detect()
          : { success: true, corners: CORNERS, confidence: 0.8, detector: detector ?? 'ml' };
      } finally {
        concurrent -= 1;
      }
    },
    async extract(): Promise<ImageData> {
      kinds.push('extract');
      return new ImageData(2, 2);
    },
  } as unknown as ScanicClient;
  return { client, kinds, detectors, maxConcurrent: () => maxConcurrent };
}

function makeOptions(client: ScanicClient, overrides: Partial<ScanicProcessorOptions> = {}) {
  return {
    client,
    decode: async (): Promise<ImageData> => new ImageData(2, 2),
    encodePng: async (): Promise<Blob> => new Blob(['png'], { type: 'image/png' }),
    ...overrides,
  } satisfies ScanicProcessorOptions;
}

const strictWrapper = ({ children }: { children: ReactNode }) =>
  createElement(StrictMode, null, children);

beforeEach(() => {
  let created = 0;
  URL.createObjectURL = vi.fn(() => `blob:scan-${(created += 1)}`);
  URL.revokeObjectURL = vi.fn();
});

describe('useScanicProcessor draining', () => {
  it('drains captures sequentially in capture order under StrictMode', async () => {
    const { client, kinds, detectors, maxConcurrent } = makeFakeClient();
    const { result, unmount } = renderHook(() => useScanicProcessor(makeOptions(client)), {
      wrapper: strictWrapper,
    });

    act(() => {
      result.current.enqueueCapture(new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
      result.current.enqueueCapture(new File(['b'], 'b.jpg', { type: 'image/jpeg' }));
    });

    await act(async () => {
      await result.current.buildNow();
    });

    // Exactly one detect+extract per capture (StrictMode must not double-run
    // the drain) and strict capture order with concurrency 1. No detector is
    // passed: the client resolves the ML-first policy itself.
    expect(kinds).toEqual(['detect', 'extract', 'detect', 'extract']);
    expect(detectors).toEqual([undefined, undefined]);
    expect(maxConcurrent()).toBe(1);
    expect(result.current.readyCount).toBe(2);
    expect(result.current.entries.map((entry) => entry.id)).toEqual(['scan-1', 'scan-2']);
    expect(result.current.entries.map((entry) => entry.phase)).toEqual(['ready', 'ready']);
    for (const entry of result.current.entries) {
      expect(entry.imageWidth).toBe(2);
      expect(entry.imageHeight).toBe(2);
      expect(entry.corners).toEqual(CORNERS);
      expect(entry.warpedUrl).toMatch(/^blob:scan-/);
      expect(entry.detector).toBe('ml');
      expect(entry.error).toBeNull();
      expect(entry.photoUrl).toMatch(/^blob:scan-/);
    }
    unmount();
  });

  it('passes an explicit detector override through to the client', async () => {
    const { client, kinds, detectors } = makeFakeClient();
    const { result, unmount } = renderHook(() =>
      useScanicProcessor(makeOptions(client, { detector: 'classical' })),
    );

    act(() => {
      result.current.enqueueCapture(new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
    });
    await act(async () => {
      await result.current.buildNow();
    });

    expect(kinds).toEqual(['detect', 'extract']);
    expect(detectors).toEqual(['classical']);
    expect(result.current.entries[0].detector).toBe('classical');
    unmount();
  });

  it('settles a capture with no detected document as ready with null corners', async () => {
    const { client, kinds } = makeFakeClient({
      detect: async () => ({
        success: false,
        corners: null,
        confidence: null,
        detector: 'classical',
      }),
    });
    const { result, unmount } = renderHook(() => useScanicProcessor(makeOptions(client)));

    act(() => {
      result.current.enqueueCapture(new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
    });
    await act(async () => {
      await result.current.buildNow();
    });

    expect(kinds).toEqual(['detect']);
    expect(result.current.readyCount).toBe(1);
    expect(result.current.entries[0].phase).toBe('ready');
    expect(result.current.entries[0].corners).toBeNull();
    expect(result.current.entries[0].warpedUrl).toBeNull();
    expect(result.current.entries[0].detector).toBe('classical');
    expect(result.current.entries[0].error).toBeNull();
    unmount();
  });

  it('settles a decode failure as ready with the error recorded and continues the queue', async () => {
    const { client, kinds } = makeFakeClient();
    let calls = 0;
    const { result, unmount } = renderHook(() =>
      useScanicProcessor(
        makeOptions(client, {
          decode: async (): Promise<ImageData> => {
            calls += 1;
            if (calls === 1) throw new Error('decode exploded');
            return new ImageData(2, 2);
          },
        }),
      ),
    );

    act(() => {
      result.current.enqueueCapture(new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
      result.current.enqueueCapture(new File(['b'], 'b.jpg', { type: 'image/jpeg' }));
    });
    await act(async () => {
      await result.current.buildNow();
    });

    // First capture failed (original bytes still available for fallback);
    // the drainer moved on and the second capture processed normally.
    expect(result.current.entries[0].phase).toBe('ready');
    expect(result.current.entries[0].error).toBe('decode exploded');
    expect(result.current.entries[0].warpedUrl).toBeNull();
    expect(result.current.entries[0].detector).toBeNull();
    expect(result.current.entries[1].error).toBeNull();
    expect(result.current.entries[1].warpedUrl).not.toBeNull();
    expect(result.current.entries[1].detector).toBe('ml');
    expect(kinds).toEqual(['detect', 'extract']);
    unmount();
  });

  it('keeps the queue and URLs on unmount (keepQueue contract)', async () => {
    let resolveDetect:
      | ((result: {
          success: boolean;
          corners: ScanicCorners | null;
          confidence: number | null;
          detector: ScanicDetectorKind;
        }) => void)
      | null = null;
    const client = {
      detect: () =>
        new Promise<{
          success: boolean;
          corners: ScanicCorners | null;
          confidence: number | null;
          detector: ScanicDetectorKind;
        }>((resolve) => {
          resolveDetect = resolve;
        }),
      extract: async () => new ImageData(2, 2),
    } as unknown as ScanicClient;
    const { result, unmount } = renderHook(() => useScanicProcessor(makeOptions(client)));

    act(() => {
      result.current.enqueueCapture(new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
    });
    // Let the decode finish and the detect request go in flight.
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => {
      resolveDetect?.({ success: false, corners: null, confidence: null, detector: 'ml' });
      await Promise.resolve();
    });
    // A post-unmount result is dropped silently; nothing is revoked either.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('buildNow waits for in-flight work instead of resolving on a pending queue', async () => {
    const { client } = makeFakeClient();
    const { result, unmount } = renderHook(() => useScanicProcessor(makeOptions(client)));

    act(() => {
      result.current.enqueueCapture(new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
    });

    let entries = result.current.entries;
    await act(async () => {
      entries = await result.current.buildNow();
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].phase).toBe('ready');
    expect(entries[0].warpedUrl).not.toBeNull();
    unmount();
  });
});
