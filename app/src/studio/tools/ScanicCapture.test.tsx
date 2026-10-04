/**
 * ScanicCapture tests: full-screen takeover contract, ML-default detection,
 * mirror control, finder frame/status, result-FIRST queue flow, commit
 * semantics (warped PNG vs byte-identical original, capture order,
 * `scan-NNN.jpg` naming), and the portaled corner editor.
 *
 * `scanic` is doubled (jsdom has no camera, no canvas 2D, no WASM): the
 * doubles stay faithful — DOM handle buttons with `data-corner`, arrow-key
 * nudges, Enter/Escape confirm/cancel — so these tests pin the integration
 * contract, not just the component.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScanicCapture, { SCANIC_ML_ASSET_BASE_URL, formatScanName } from './ScanicCapture';
import { createCornerEditor, extractDocument, scanDocument } from 'scanic';
import type { ScanicCorners } from './scan/index';

vi.mock('scanic', () => ({
  scanDocument: vi.fn(),
  extractDocument: vi.fn(),
  createCornerEditor: vi.fn(),
}));

const mockScan = vi.mocked(scanDocument);
const mockExtract = vi.mocked(extractDocument);
const mockEditorFactory = vi.mocked(createCornerEditor);

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
function cloneCorners(c: ScanicCorners): ScanicCorners {
  return {
    topLeft: { ...c.topLeft },
    topRight: { ...c.topRight },
    bottomRight: { ...c.bottomRight },
    bottomLeft: { ...c.bottomLeft },
  };
}

type EditorOpts = {
  container: HTMLElement;
  image: unknown;
  corners?: ScanicCorners;
  onChange?: (c: ScanicCorners) => void;
  onConfirm?: (c: ScanicCorners) => void;
  onCancel?: () => void;
};

/** Faithful editor double: DOM handles + keyboard, Enter/Escape, reset. */
function installEditorDouble() {
  mockEditorFactory.mockImplementation((opts: unknown) => {
    const o = opts as EditorOpts;
    let corners = cloneCorners(o.corners ?? detectedCorners());
    const buttons: HTMLButtonElement[] = [];
    (['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const).forEach((name) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'scanic-handle';
      b.dataset.corner = name;
      b.addEventListener('keydown', (ev: Event) => {
        const e = ev as KeyboardEvent;
        if (e.key === 'Enter') {
          o.onConfirm?.(cloneCorners(corners));
          return;
        }
        if (e.key === 'Escape') {
          o.onCancel?.();
          return;
        }
        const delta = e.shiftKey ? 10 : 1;
        const next = { ...corners[name] };
        if (e.key === 'ArrowLeft') next.x -= delta;
        else if (e.key === 'ArrowRight') next.x += delta;
        else if (e.key === 'ArrowUp') next.y -= delta;
        else if (e.key === 'ArrowDown') next.y += delta;
        else return;
        corners = { ...corners, [name]: next };
        o.onChange?.(cloneCorners(corners));
      });
      o.container.appendChild(b);
      buttons.push(b);
    });
    return {
      getCorners: () => cloneCorners(corners),
      setCorners: (c: ScanicCorners) => {
        corners = cloneCorners(c);
        return true;
      },
      reset: () => {
        corners = cloneCorners(o.corners ?? detectedCorners());
        o.onChange?.(cloneCorners(corners));
      },
      nudge: () => true,
      refreshTheme: () => undefined,
      confirm: () => {
        const c = cloneCorners(corners);
        o.onConfirm?.(c);
        return c;
      },
      cancel: () => {
        o.onCancel?.();
      },
      destroy: () => {
        for (const b of buttons) b.remove();
      },
    };
  });
}

function photo(name: string, bytes: number[]): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
}

/** E2E-contract attribute lookup (the contract uses data attrs, not test ids). */
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

function injectFiles(...files: File[]) {
  const input = screen.getByLabelText('Add image files instead');
  fireEvent.change(input, { target: { files } });
}

/** Camera flow: enqueue via the file fallback, then enter review via the CTA. */
async function injectAndReview(...files: File[]) {
  injectFiles(...files);
  const cta = await findQ('[data-review-cta]');
  fireEvent.click(cta);
  await findQ('[data-scan-queue]');
}

/** Live-camera double: resolves getUserMedia with a stoppable fake stream. */
function mockLiveCamera() {
  const stop = vi.fn();
  const track = {
    stop,
    getCapabilities: () => ({}),
    applyConstraints: vi.fn(async () => undefined),
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => stream) },
    configurable: true,
  });
  return { stop, track };
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
  URL.createObjectURL = vi.fn(() => {
    urlCounter += 1;
    return `blob:mock-${urlCounter}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  // Fake image loader: jsdom never fires load on blob URLs.
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
  mockScan.mockResolvedValue({
    success: true,
    message: 'ok',
    confidence: 0.9,
    score: null,
    output: null,
    corners: detectedCorners(),
    contour: null,
    debug: null,
    timings: [],
  });
  mockExtract.mockResolvedValue({
    success: true,
    message: 'ok',
    output: document.createElement('canvas'),
    corners: detectedCorners(),
    contour: null,
    debug: null,
    timings: [],
  });
  installEditorDouble();
});

afterEach(() => {
  cleanup();
  restoreMediaDevices();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.style.overflow = '';
  // @ts-expect-error test-only cleanup of the canvas export stub
  if ('toBlob' in HTMLCanvasElement.prototype) delete HTMLCanvasElement.prototype.toBlob;
});

describe('formatScanName', () => {
  it('zero-pads capture-order names', () => {
    expect(formatScanName(0)).toBe('scan-001.jpg');
    expect(formatScanName(11)).toBe('scan-012.jpg');
  });
});

describe('ScanicCapture shell', () => {
  it('portals a full-screen takeover root with ML default and no toggle', () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    const root = q('[data-scanner-root]');
    expect(root.getAttribute('data-detector')).toBe('ml');
    expect(root.className).toMatch('fixed');
    expect(root.className).toMatch('inset-0');
    expect(root.className).toMatch('z-50');
    // Portaled to document.body, not nested inline in the RTL container.
    expect(root.parentElement).toBe(document.body);
    expect(screen.getByText(/No camera is available/)).toBeTruthy();
    // The ML toggle button is dead — ML is the default.
    expect(document.querySelector('[data-ml-detector]')).toBeNull();
    // Session strip is always rendered, even with no pages.
    expect(q('[data-scan-strip]')).toBeTruthy();
    // Honest no-camera copy rides the finder status line.
    expect(q('[data-finder-status]').textContent).toMatch(/No camera is available/);
  });

  it('locks body scroll while mounted and restores on unmount', () => {
    const { unmount } = render(
      <ScanicCapture onCommit={() => undefined} onExit={() => undefined} />,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('renders the shutter only when the camera is live', async () => {
    // No camera in jsdom by default — no shutter without a live preview.
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    expect(document.querySelector('[data-scan-capture]')).toBeNull();
    cleanup();

    mockLiveCamera();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    expect(await findQ('[data-scan-capture]')).toBeTruthy();
  });
});

describe('viewfinder', () => {
  it('shows a full-bleed finder frame with honest Point-at-page status when live', async () => {
    mockLiveCamera();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    expect(q('[data-finder-frame]')).toBeTruthy();
    expect(q('[data-finder-status]').textContent).toBe('Point at the page');
    const video = document.querySelector(
      'video[aria-label="Camera preview"]',
    ) as HTMLVideoElement | null;
    expect(video).not.toBeNull();
    expect(video?.className).toMatch('object-cover');
  });

  it('requests high-res constraints with a continuous-focus effort', async () => {
    const { track } = mockLiveCamera();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    const getUserMedia = navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>;
    expect(getUserMedia).toHaveBeenCalled();
    const constraints = getUserMedia.mock.calls[0][0] as {
      video: { width?: { ideal: number }; height?: { ideal: number } };
    };
    // Back camera defaults to 1080p ideals.
    expect(constraints.video.width).toEqual({ ideal: 1920 });
    expect(constraints.video.height).toEqual({ ideal: 1080 });
    // Continuous focus effort where available (mock accepts anything).
    expect(track.applyConstraints).toHaveBeenCalled();
  });
});

describe('mirror control', () => {
  it('mirrors the front preview by default and flips via the toggle', async () => {
    mockLiveCamera();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    // Back camera is never mirrored, even with the toggle pressed.
    let video = document.querySelector(
      'video[aria-label="Camera preview"]',
    ) as HTMLVideoElement | null;
    expect(video?.style.transform).toBe('');
    const toggle = await findQ('[data-mirror-toggle]');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    // Switch to the front camera — preview mirrors by default.
    fireEvent.click(screen.getByLabelText('Switch camera'));
    await waitFor(() => {
      video = document.querySelector(
        'video[aria-label="Camera preview"]',
      ) as HTMLVideoElement | null;
      expect(video?.style.transform).toBe('scaleX(-1)');
    });

    // Toggle off — preview unmirrors (captures stay unmirrored regardless).
    fireEvent.click(q('[data-mirror-toggle]'));
    await waitFor(() => {
      expect(q('[data-mirror-toggle]').getAttribute('aria-pressed')).toBe('false');
    });
    video = document.querySelector('video[aria-label="Camera preview"]') as HTMLVideoElement | null;
    expect(video?.style.transform).toBe('');
  });
});

describe('result-FIRST queue', () => {
  it('emits the exact E2E contract after capture', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    injectFiles(photo('a.jpg', [1, 2]), photo('b.jpg', [3, 4]));
    const cta = await findQ('[data-review-cta]');
    expect(cta.textContent).toBe('Review 2 pages');
    fireEvent.click(cta);
    expect(await findQ('[data-scan-queue]')).toBeTruthy();
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    expect(q('[data-crop-result]')).toBeTruthy();
    expect(q('[data-crop-result-img]')).toBeTruthy();
    for (const label of ['Looks good', 'Use original', 'Adjust corners', 'Discard', 'Re-detect']) {
      expect(screen.getByText(label, { exact: true })).toBeTruthy();
    }
    expect(q('[data-review-progress]').getAttribute('aria-label')).toBe('0 of 2 reviewed');
  });

  it('commits warped PNGs in capture order, then offers Build PDF / Back to camera', async () => {
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(['png-bytes'], { type: 'image/png' }));
    };
    const onCommit = vi.fn();
    const onExit = vi.fn();
    render(<ScanicCapture onCommit={onCommit} onExit={onExit} />);
    await injectAndReview(photo('a.jpg', [1, 2]), photo('b.jpg', [3, 4]));

    fireEvent.click(screen.getByText('Looks good', { exact: true }));
    await screen.findByText('Page 2 of 2');
    fireEvent.click(screen.getByText('Looks good', { exact: true }));
    await screen.findByText('All pages ready');

    expect(screen.getByText('Build PDF', { exact: true })).toBeTruthy();
    expect(screen.getByText('Back to camera', { exact: true })).toBeTruthy();
    expect(q('[data-review-progress]').getAttribute('aria-label')).toBe('2 of 2 reviewed');

    fireEvent.click(screen.getByText('Build PDF', { exact: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    const pages = onCommit.mock.calls[0][0] as Array<{ file: File; name: string }>;
    expect(pages.map((p) => p.name)).toEqual(['scan-001.jpg', 'scan-002.jpg']);
    expect(pages[0].file.type).toBe('image/png');
    expect(await pages[0].file.text()).toBe('png-bytes');
  });

  it('commits the byte-identical original on "Use original"', async () => {
    const onCommit = vi.fn();
    render(<ScanicCapture onCommit={onCommit} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [7, 7, 7]));
    fireEvent.click(screen.getByText('Use original', { exact: true }));
    await screen.findByText('All pages ready');
    fireEvent.click(screen.getByText('Build PDF', { exact: true }));
    const pages = onCommit.mock.calls[0][0] as Array<{ file: File; name: string }>;
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe('scan-001.jpg');
    expect(pages[0].file.type).toBe('image/jpeg');
    expect(Array.from(new Uint8Array(await pages[0].file.arrayBuffer()))).toEqual([7, 7, 7]);
  });

  it('discards a page from the queue', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]), photo('b.jpg', [2]));
    fireEvent.click(screen.getByText('Discard', { exact: true }));
    await screen.findByText('Page 1 of 1');
  });

  it('re-runs ML detection via Re-detect', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    await waitFor(() => expect(mockScan).toHaveBeenCalled());
    const callsBefore = mockScan.mock.calls.length;
    fireEvent.click(screen.getByText('Re-detect', { exact: true }));
    await waitFor(() => {
      expect(mockScan.mock.calls.length).toBeGreaterThan(callsBefore);
    });
    const lastOptions = mockScan.mock.calls[mockScan.mock.calls.length - 1][1] as {
      detector: string;
    };
    expect(lastOptions.detector).toBe('ml');
  });
});

describe('corner editor', () => {
  it('portals 4 slider handles, steps with arrow keys, and applies', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    fireEvent.click(screen.getByText('Adjust corners', { exact: true }));

    const tl = document.body.querySelector('[data-crop-handle="tl"]') as HTMLButtonElement | null;
    expect(tl).not.toBeNull();
    expect(document.body.querySelectorAll('[data-crop-handle]').length).toBe(4);
    expect(tl?.getAttribute('role')).toBe('slider');
    const before = tl?.getAttribute('aria-valuetext');
    if (!tl) throw new Error('missing tl handle');
    // Shift+Arrow = coarse step (1px would round to the same percent at 640px wide).
    fireEvent.keyDown(tl, { key: 'ArrowRight', shiftKey: true });
    await waitFor(() => {
      expect(q('[data-crop-handle="tl"]').getAttribute('aria-valuetext')).not.toBe(before);
    });

    fireEvent.click(screen.getByText('Apply', { exact: true }));
    await waitFor(() => {
      expect(document.body.querySelector('[data-crop-handle]')).toBeNull();
    });
    // Queue is back; the editor portal is gone from the scanner root too.
    expect(q('[data-scan-queue]')).toBeTruthy();
  });

  it('disables Reset to auto when there is no detection baseline', async () => {
    // BOTH detectors miss: the ML attempt finds nothing AND the one
    // classical fallback finds nothing (null-means-missed policy).
    mockScan.mockResolvedValueOnce({
      success: false,
      message: 'none',
      output: null,
      corners: null,
      contour: null,
      debug: null,
      timings: [],
    });
    mockScan.mockResolvedValueOnce({
      success: false,
      message: 'none',
      output: null,
      corners: null,
      contour: null,
      debug: null,
      timings: [],
    });
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    fireEvent.click(screen.getByText('Adjust corners', { exact: true }));
    const reset = await screen.findByText('Reset to auto', { exact: true });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ML detector default', () => {
  it('detects ML-first with the vendored base URL and no toggle', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    expect(document.querySelector('[data-ml-detector]')).toBeNull();
    await injectAndReview(photo('a.jpg', [1]));
    await waitFor(() => expect(mockScan).toHaveBeenCalled());
    const options = mockScan.mock.calls[0][1] as {
      detector: string;
      ml?: { assetBaseUrl: string };
    };
    expect(options.detector).toBe('ml');
    expect(options.ml?.assetBaseUrl).toBe(SCANIC_ML_ASSET_BASE_URL);
    expect(SCANIC_ML_ASSET_BASE_URL).toBe('/assets/scanic-ml/');
  });

  it('falls back to classical when ML succeeds but finds no quad (null-means-missed)', async () => {
    mockScan.mockResolvedValueOnce({
      success: false,
      message: 'no confident document (ml)',
      confidence: null,
      score: 0.1,
      output: null,
      corners: null,
      contour: null,
      debug: null,
      timings: [],
    });
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    await waitFor(() => expect(mockScan.mock.calls.length).toBeGreaterThanOrEqual(2));
    const second = mockScan.mock.calls[1][1] as { detector: string };
    expect(second.detector).toBe('classical');
    // Classical corners land on the page: adjust is seeded, Reset enabled.
    fireEvent.click(screen.getByText('Adjust corners', { exact: true }));
    const reset = await screen.findByText('Reset to auto', { exact: true });
    expect((reset as HTMLButtonElement).disabled).toBe(false);
  });
});
