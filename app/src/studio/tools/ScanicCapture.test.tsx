/**
 * ScanicCapture tests: full-screen takeover contract, ML-default detection,
 * mirror control, finder frame/status, result-FIRST queue flow, commit
 * semantics (warped JPEG q0.9 vs byte-identical original, capture order,
 * `scan-NNN.jpg` naming), main-lens scoring, and the portaled corner editor.
 *
 * `ScanicClient` is doubled (jsdom has no workers, no camera, no canvas 2D,
 * no WASM): every constructed client shares one set of doubles, and a fake
 * 2D context bridges decode/encode. Corner handles are the dependency-free
 * ScanicReview buttons (`data-crop-handle`), so these tests pin the
 * integration contract, not just the component.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScanicCapture, {
  AUTO_CAPTURE_COOLDOWN_MS,
  AUTO_CAPTURE_MEAN_THRESHOLD,
  AUTO_CAPTURE_STABLE_TICKS_REQUIRED,
  AUTO_CAPTURE_TICK_MS,
  CAMERA_STORAGE_KEY,
  SCANIC_ML_ASSET_BASE_URL,
  __resetCameraChoiceForTests,
  buildVideoConstraints,
  cameraDisplayName,
  cameraFailureMessage,
  formatScanName,
  grayscaleSAD,
  hasZoomCapability,
  isLandscapeScreen,
  isStableFrame,
  scoreBackCamera,
  shouldAutoFire,
} from './ScanicCapture';
import type { ScanicCorners } from './scan/index';

// Detection + warp run through `ScanicClient` (module scan worker); jsdom
// has no workers/WASM, so every constructed client shares one set of
// doubles. `ScanicClientError` stays a real class so the component's
// `instanceof` cancel-swallow checks behave.
const { __clientMocks } = vi.hoisted(() => ({
  __clientMocks: { detect: vi.fn(), extract: vi.fn(), terminate: vi.fn() },
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
  __resetCameraChoiceForTests();
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
  // Fake 2D canvas: jsdom has no canvas 2D. Detection decodes via the
  // stubbed Image (W×H) + getImageData; warp encodes via putImageData +
  // per-test toBlob stubs.
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
  it('fills the viewport edge-to-edge with cover and floating scrims when live', async () => {
    mockLiveCamera();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    expect(q('[data-finder-frame]')).toBeTruthy();
    expect(q('[data-finder-status]').textContent).toBe('Point at the page');
    const video = document.querySelector(
      'video[aria-label="Camera preview"]',
    ) as HTMLVideoElement | null;
    expect(video).not.toBeNull();
    expect(video?.className).toContain('object-cover');
    expect(video?.className).toContain('inset-0');
    expect(video?.className).toContain('h-full');
    expect(video?.className).toContain('w-full');
    // Full-bleed layer: absolute inset-0 of the fixed surface — no
    // aspect/box classes by construction, so black bars are impossible.
    const layer = q('[data-viewfinder]');
    expect(layer.className).toContain('absolute');
    expect(layer.className).toContain('inset-0');
    expect(layer.className).not.toMatch('aspect-');
    expect(layer.className).not.toMatch('max-w');
    // Floating chrome: top + bottom scrims fade from ink-950, pointer-events
    // pass through except on the controls themselves.
    const scrims = Array.from(document.querySelectorAll('[data-scanner-root] div')).filter((d) =>
      d.className.includes('from-ink-950'),
    );
    expect(scrims.length).toBeGreaterThanOrEqual(2);
    for (const s of scrims) expect(s.className).toContain('pointer-events-none');
    expect(scrims.some((d) => d.className.includes('to-transparent'))).toBe(true);
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
    // Back camera requests portrait ideals (tall frames; the full-bleed
    // preview cover-crops, capture stores the full frame).
    expect(constraints.video.width).toEqual({ ideal: 1080 });
    expect(constraints.video.height).toEqual({ ideal: 1920 });
    // Continuous focus effort where available (mock accepts anything).
    expect(track.applyConstraints).toHaveBeenCalled();

    // Front camera requests smaller portrait ideals.
    fireEvent.click(screen.getByLabelText('Switch camera'));
    await waitFor(() => {
      expect(getUserMedia.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const frontConstraints = getUserMedia.mock.calls[getUserMedia.mock.calls.length - 1][0] as {
      video: { width?: { ideal: number }; height?: { ideal: number } };
    };
    expect(frontConstraints.video.width).toEqual({ ideal: 720 });
    expect(frontConstraints.video.height).toEqual({ ideal: 1280 });
  });
});

describe('zero layout shift', () => {
  function ctaSlot(): HTMLElement {
    const slot = Array.from(document.querySelectorAll('div')).find((d) =>
      d.className.includes('min-h-[52px]'),
    );
    if (!slot) throw new Error('missing review-CTA slot');
    return slot as HTMLElement;
  }

  it('keeps the floating filmstrip, full-bleed layer, and controls fixed across the first capture', async () => {
    mockLiveCamera();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');

    // Overlay invariants BEFORE any page exists: the floating filmstrip is
    // always rendered at a fixed height (never collapses when empty), and
    // the viewfinder is an unboxed full-bleed layer.
    const stripClass = q('[data-scan-strip]').className;
    expect(stripClass).toContain('h-16');
    expect(q('[data-scan-strip]').textContent).toMatch(/No pages yet/);

    const layerClass = q('[data-viewfinder]').className;
    expect(layerClass).toContain('inset-0');
    expect(layerClass).not.toMatch('aspect-');

    // The review-CTA slot is reserved even with an empty queue (the button
    // itself stays queue-gated per the E2E contract).
    const reservedClass = ctaSlot().className;
    expect(document.querySelector('[data-review-cta]')).toBeNull();

    // First capture: enqueue a page while staying on the camera view.
    injectFiles(photo('a.jpg', [1, 2]));
    await findQ('[data-review-cta]');

    // The overlay must not move: same layers, same classes, zero shift.
    expect(q('[data-scan-strip]').className).toBe(stripClass);
    expect(q('[data-viewfinder]').className).toBe(layerClass);
    expect(ctaSlot().className).toBe(reservedClass);
    // The CTA rides inside its reserved slot — present, slot unchanged.
    expect(q('[data-review-cta]').parentElement?.className).toBe(reservedClass);
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
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    };
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    injectFiles(photo('a.jpg', [1, 2]), photo('b.jpg', [3, 4]));
    const cta = await findQ('[data-review-cta]');
    // Implicit accept: no pending, the CTA always offers the full queue.
    expect(cta.textContent).toBe('View 2 pages');
    fireEvent.click(cta);
    expect(await findQ('[data-scan-queue]')).toBeTruthy();
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    // Single-canvas result view: exactly one warped image, no overlay.
    const resultImg = await findQ('[data-crop-result-img]');
    expect(resultImg.tagName.toLowerCase()).toBe('img');
    const result = q('[data-crop-result]');
    expect(result.querySelectorAll('img').length).toBe(1);
    expect(document.querySelector('[data-detect-overlay]')).toBeNull();
    // No accept click exists anywhere.
    expect(screen.queryByText('Looks good', { exact: true })).toBeNull();
    for (const label of ['Use original', 'Adjust corners', 'Discard', 'Re-detect']) {
      expect(screen.getByText(label, { exact: true })).toBeTruthy();
    }
    // Pager beside the hero (prev disabled on the first page).
    expect(q('[data-page-prev]')).toBeTruthy();
    expect(q('[data-page-next]')).toBeTruthy();
    expect((q('[data-page-prev]') as HTMLButtonElement).disabled).toBe(true);
    // Implicit accept: the first show already marks page 1 visited.
    await waitFor(() => {
      expect(q('[data-review-progress]').getAttribute('aria-label')).toBe('1 of 2 viewed');
    });
  });

  it('builds all remaining pages in order with no accept click', async () => {
    const seen: Array<{ type?: string; quality?: number }> = [];
    HTMLCanvasElement.prototype.toBlob = function (
      cb: (b: Blob | null) => void,
      type?: string,
      quality?: number,
    ) {
      seen.push({ type, quality });
      cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    } as typeof HTMLCanvasElement.prototype.toBlob;
    const onCommit = vi.fn();
    const onExit = vi.fn();
    render(<ScanicCapture onCommit={onCommit} onExit={onExit} />);
    await injectAndReview(photo('a.jpg', [1, 2]), photo('b.jpg', [3, 4]));

    // Eager warp fills each page's blob on view; no accept click needed —
    // Next is already gated open (>=1 page) and builds everything remaining.
    // Visit page 2 so its eager warp completes before building.
    await waitFor(() => expect(mockWarpExtract).toHaveBeenCalled());
    fireEvent.click(q('[data-page-next]'));
    await screen.findByText('Page 2 of 2');
    await waitFor(() => expect(mockWarpExtract.mock.calls.length).toBeGreaterThanOrEqual(2));
    const next = screen.getByText('Next', { exact: true }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    await screen.findByText('All pages ready');

    expect(screen.getByText('Build PDF', { exact: true })).toBeTruthy();
    expect(screen.getByText('Back to camera', { exact: true })).toBeTruthy();

    fireEvent.click(screen.getByText('Build PDF', { exact: true }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledTimes(1);
    const pages = onCommit.mock.calls[0][0] as Array<{ file: File; name: string }>;
    expect(pages.map((p) => p.name)).toEqual(['scan-001.jpg', 'scan-002.jpg']);
    expect(pages[0].file.type).toBe('image/jpeg');
    expect(await pages[0].file.text()).toBe('jpeg-bytes');
    expect(pages[1].file.type).toBe('image/jpeg');
    expect(await pages[1].file.text()).toBe('jpeg-bytes');
    // Warped output encodes full-res JPEG q0.9 (never PNG).
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.type).toBe('image/jpeg');
      expect(s.quality).toBe(0.9);
    }
  });

  it('Use original toggles to the byte-identical original', async () => {
    const onCommit = vi.fn();
    render(<ScanicCapture onCommit={onCommit} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [7, 7, 7]));
    fireEvent.click(screen.getByText('Use original', { exact: true }));
    // Toggle verdict: stays on the same page (no auto-advance to done).
    expect(screen.getByText('Page 1 of 1')).toBeTruthy();
    fireEvent.click(screen.getByText('Next', { exact: true }));
    await screen.findByText('All pages ready');
    fireEvent.click(screen.getByText('Build PDF', { exact: true }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const pages = onCommit.mock.calls[0][0] as Array<{ file: File; name: string }>;
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe('scan-001.jpg');
    expect(pages[0].file.type).toBe('image/jpeg');
    expect(Array.from(new Uint8Array(await pages[0].file.arrayBuffer()))).toEqual([7, 7, 7]);
  });

  it('Use original toggles back to warped', async () => {
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    };
    const onCommit = vi.fn();
    render(<ScanicCapture onCommit={onCommit} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [7, 7, 7]));
    await waitFor(() => expect(mockWarpExtract).toHaveBeenCalled());
    // Warped -> original -> warped: two toggles land back on the crop.
    fireEvent.click(screen.getByText('Use original', { exact: true }));
    fireEvent.click(screen.getByText('Use original', { exact: true }));
    expect(screen.getByText('Page 1 of 1')).toBeTruthy();
    fireEvent.click(screen.getByText('Next', { exact: true }));
    await screen.findByText('All pages ready');
    fireEvent.click(screen.getByText('Build PDF', { exact: true }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const pages = onCommit.mock.calls[0][0] as Array<{ file: File; name: string }>;
    expect(pages).toHaveLength(1);
    expect(pages[0].file.type).toBe('image/jpeg');
    expect(await pages[0].file.text()).toBe('jpeg-bytes');
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
    await waitFor(() => expect(mockDetect).toHaveBeenCalled());
    const callsBefore = mockDetect.mock.calls.length;
    fireEvent.click(screen.getByText('Re-detect', { exact: true }));
    await waitFor(() => {
      expect(mockDetect.mock.calls.length).toBeGreaterThan(callsBefore);
    });
    const lastDetector = mockDetect.mock.calls[mockDetect.mock.calls.length - 1][1] as string;
    expect(lastDetector).toBe('ml');
  });
});

describe('eager warp', () => {
  it('warps a page with corners immediately, with no accept click', async () => {
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    };
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    // Eager warp fills the single canvas; implicit accept needs no click.
    const img = (await findQ('[data-crop-result-img]')) as HTMLImageElement;
    expect(img.src).toMatch(/^blob:mock-/);
    await waitFor(() => expect(mockWarpExtract).toHaveBeenCalled());
    // Visited on show; Next is gated open (>=1 page) without any accept.
    await waitFor(() => {
      expect(q('[data-review-progress]').getAttribute('aria-label')).toBe('1 of 1 viewed');
    });
    expect((screen.getByText('Next', { exact: true }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('warps once per quad — no re-warp loop for the same corners', async () => {
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    };
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    await findQ('[data-crop-result-img]');
    await waitFor(() => expect(mockWarpExtract).toHaveBeenCalled());
    const calls = mockWarpExtract.mock.calls.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(mockWarpExtract.mock.calls.length).toBe(calls);
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

  it('renders 8 adjust handles: 4 corners + 4 rigid-edge midpoints', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    fireEvent.click(screen.getByText('Adjust corners', { exact: true }));
    await findQ('[data-crop-adjust]');
    expect(document.body.querySelectorAll('[data-crop-handle]').length).toBe(4);
    expect(document.body.querySelectorAll('[data-crop-handle-mid]').length).toBe(4);
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      expect(document.body.querySelector(`[data-crop-handle-mid="${edge}"]`)).not.toBeNull();
    }
  });

  it('disables Reset to auto when there is no detection baseline', async () => {
    // Detection misses entirely (null quad): no baseline to reset to.
    mockDetect.mockResolvedValueOnce({
      success: false,
      corners: null,
      confidence: null,
      detector: 'classical',
    });
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    fireEvent.click(screen.getByText('Adjust corners', { exact: true }));
    const reset = await screen.findByRole('button', { name: 'Reset to auto' });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('auto capture stability shutter', () => {
  it('grayscaleSAD sums absolute per-pixel differences', () => {
    expect(grayscaleSAD(new Uint8Array([10, 20, 30]), new Uint8Array([10, 20, 30]))).toBe(0);
    expect(grayscaleSAD(new Uint8Array([0, 0, 0]), new Uint8Array([1, 2, 3]))).toBe(6);
    expect(grayscaleSAD(new Uint8Array([255, 0]), new Uint8Array([0, 255]))).toBe(510);
  });

  it('grayscaleSAD treats unreadable/mismatched frames as maximally different', () => {
    expect(grayscaleSAD(new Uint8Array([1, 2]), new Uint8Array([1]))).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(grayscaleSAD(new Uint8Array([]), new Uint8Array([1]))).toBe(Number.POSITIVE_INFINITY);
  });

  it('isStableFrame accepts steady frames up to the mean threshold', () => {
    const pixels = 100;
    // Static frame (SAD 0) counts as stable.
    expect(isStableFrame(0, pixels)).toBe(true);
    expect(isStableFrame(AUTO_CAPTURE_MEAN_THRESHOLD * pixels, pixels)).toBe(true);
    expect(isStableFrame(AUTO_CAPTURE_MEAN_THRESHOLD * pixels + 1, pixels)).toBe(false);
    expect(isStableFrame(Number.POSITIVE_INFINITY, pixels)).toBe(false);
    expect(isStableFrame(0, 0)).toBe(false);
  });

  it('shouldAutoFire needs N consecutive ticks plus cooldown spacing', () => {
    const n = AUTO_CAPTURE_STABLE_TICKS_REQUIRED;
    expect(shouldAutoFire(n - 1, 10_000, null)).toBe(false);
    expect(shouldAutoFire(n, 10_000, null)).toBe(true);
    // Static-frame repeat inside the cooldown stays gated…
    expect(shouldAutoFire(n, 10_000, 10_000 - (AUTO_CAPTURE_COOLDOWN_MS - 1))).toBe(false);
    // …and fires once the cooldown has fully elapsed (boundary inclusive).
    expect(shouldAutoFire(n, 10_000, 10_000 - AUTO_CAPTURE_COOLDOWN_MS)).toBe(true);
    expect(shouldAutoFire(n + 3, 10_000, 10_000 - AUTO_CAPTURE_COOLDOWN_MS - 500)).toBe(true);
  });
});

describe('capture mode + gallery cluster', () => {
  it('defaults to Manual with an Auto capture option that never fires on its own', async () => {
    mockLiveCamera();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    const group = q('[data-scan-mode]');
    expect(group.getAttribute('role')).toBe('group');
    const manual = screen.getByText('Manual', { exact: true });
    const auto = screen.getByText('Auto capture', { exact: true });
    expect(manual.getAttribute('aria-pressed')).toBe('true');
    expect(auto.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(auto);
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    expect(manual.getAttribute('aria-pressed')).toBe('false');
    // jsdom has no readable preview frames — nothing may self-queue.
    await new Promise((r) => setTimeout(r, AUTO_CAPTURE_TICK_MS * 2 + 100));
    expect(document.querySelector('[data-review-cta]')).toBeNull();
    fireEvent.click(manual);
    expect(manual.getAttribute('aria-pressed')).toBe('true');
  });

  it('gallery thumb shows the last queued page and jumps to review', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    // Empty queue: gallery exists but stays disabled.
    expect((q('[data-scan-gallery]') as HTMLButtonElement).disabled).toBe(true);
    injectFiles(photo('a.jpg', [1, 2]), photo('b.jpg', [3, 4]));
    const gallery = await findQ('[data-scan-gallery]');
    expect((gallery as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(gallery);
    expect(await findQ('[data-scan-queue]')).toBeTruthy();
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
  });

  it('shows Scanning… hold steady while a capture is being detected', async () => {
    mockLiveCamera();
    // Never-resolving detection keeps the entry in `detecting`.
    mockDetect.mockReturnValue(new Promise(() => {}));
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    expect(q('[data-finder-status]').textContent).toBe('Point at the page');
    injectFiles(photo('a.jpg', [9]));
    await waitFor(() => {
      expect(q('[data-finder-status]').textContent).toBe('Scanning… hold steady');
    });
  });

  it('dwells the working pill briefly after instant detection (readable, not a flash)', async () => {
    mockLiveCamera();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    // Default mock settles detection in milliseconds: sleep past the settle
    // but inside the 800ms dwell, then the pill must STILL read working —
    // without the dwell it would already read idle.
    injectFiles(photo('a.jpg', [9]));
    await new Promise((r) => setTimeout(r, 400));
    expect(q('[data-finder-status]').textContent).toBe('Scanning… hold steady');
  });
});

describe('review filmstrip + batch bar', () => {
  it('renders numbered thumbs, pager, add-back, and an ungated Next that reaches done', async () => {
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    };
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]), photo('b.jpg', [2]));
    expect(q('[data-scan-filmstrip]')).toBeTruthy();
    expect(document.body.querySelectorAll('[data-film-thumb]').length).toBe(2);
    expect(q('[data-scan-add]').getAttribute('aria-label')).toBe('Back to camera');
    expect(q('[data-batch-bar]')).toBeTruthy();
    // Implicit accept: Next is gated open (>=1 page) with zero accept clicks.
    expect((screen.getByText('Next', { exact: true }) as HTMLButtonElement).disabled).toBe(false);
    // Initial show visits page 1.
    await waitFor(() => {
      expect(q('[data-review-progress]').getAttribute('aria-label')).toBe('1 of 2 viewed');
    });

    // Pager next visits page 2; prev is 44px and disabled at the ends.
    const prev = q('[data-page-prev]') as HTMLButtonElement;
    const pagerNext = q('[data-page-next]') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(pagerNext.disabled).toBe(false);
    for (const btn of [prev, pagerNext]) {
      expect(btn.className).toMatch('min-h-[44px]');
      expect(btn.className).toMatch('min-w-[44px]');
    }
    fireEvent.click(pagerNext);
    await screen.findByText('Page 2 of 2');
    await waitFor(() => {
      expect(q('[data-review-progress]').getAttribute('aria-label')).toBe('2 of 2 viewed');
    });
    expect((q('[data-page-prev]') as HTMLButtonElement).disabled).toBe(false);
    expect((q('[data-page-next]') as HTMLButtonElement).disabled).toBe(true);

    // Filmstrip tap jumps back without any accept click.
    fireEvent.click(document.body.querySelectorAll('[data-film-thumb]')[0] as HTMLElement);
    await screen.findByText('Page 1 of 2');
    // Both visited: progress stays full.
    expect(q('[data-review-progress]').getAttribute('aria-label')).toBe('2 of 2 viewed');

    // Next reaches the done screen.
    fireEvent.click(screen.getByText('Next', { exact: true }));
    await screen.findByText('All pages ready');
  });

  it('Discard scans drops everything back to the camera, confirm-free', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]), photo('b.jpg', [2]));
    expect(q('[data-batch-bar]')).toBeTruthy();
    fireEvent.click(screen.getByText('Discard scans', { exact: true }));
    await waitFor(() => {
      expect(document.querySelector('[data-scan-queue]')).toBeNull();
    });
    expect(q('[data-scan-strip]').textContent).toMatch(/No pages yet/);
  });

  it('[data-scan-add] returns to the camera without losing the queue', async () => {
    mockLiveCamera();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    fireEvent.click(q('[data-scan-add]'));
    await findQ('[data-scan-capture]');
    expect(q('[data-review-cta]').textContent).toBe('View 1 pages');
  });
});

describe('implicit accept navigation', () => {
  it('disables both pager buttons on a single page', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    expect((q('[data-page-prev]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[data-page-next]') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => {
      expect(q('[data-review-progress]').getAttribute('aria-label')).toBe('1 of 1 viewed');
    });
  });

  it('discarding the last remaining page returns to the camera', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    fireEvent.click(screen.getByText('Discard', { exact: true }));
    await waitFor(() => {
      expect(document.querySelector('[data-scan-queue]')).toBeNull();
    });
    expect(q('[data-scan-strip]').textContent).toMatch(/No pages yet/);
  });
});

describe('ML detector default', () => {
  it('detects with the ML detector by default and no toggle', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    expect(document.querySelector('[data-ml-detector]')).toBeNull();
    await injectAndReview(photo('a.jpg', [1]));
    await waitFor(() => expect(mockDetect).toHaveBeenCalled());
    // Worker contract: detect(pixels, detector). Model assets are owned by
    // the worker; the UI only names the detector.
    const detector = mockDetect.mock.calls[0][1] as string;
    expect(detector).toBe('ml');
    expect(SCANIC_ML_ASSET_BASE_URL).toBe('/assets/scanic-ml/');
  });

  it('reports a classical-backed quad when ML sees nothing (worker-internal fallback)', async () => {
    mockDetect.mockResolvedValueOnce({
      success: true,
      corners: detectedCorners(),
      confidence: null,
      detector: 'classical',
    });
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    // Single worker call: the ML→classical fallback lives inside the
    // worker, not as a second UI-driven attempt.
    await waitFor(() => expect(mockDetect).toHaveBeenCalledTimes(1));
    expect(mockDetect.mock.calls[0][1]).toBe('ml');
    // Classical corners land on the page: adjust is seeded, Reset enabled.
    fireEvent.click(screen.getByText('Adjust corners', { exact: true }));
    const reset = await screen.findByRole('button', { name: 'Reset to auto' });
    expect((reset as HTMLButtonElement).disabled).toBe(false);
  });

  it('adjust-next advances the page with no warp and no verdict change', async () => {
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]), photo('b.jpg', [2]));
    await waitFor(() => expect(mockWarpExtract).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Adjust corners', { exact: true }));
    const nextBtn = await screen.findByRole('button', { name: 'Next page' });
    fireEvent.click(nextBtn);
    // Page 2 shows (its first eager warp may legitimately run once).
    expect(await screen.findByText('Page 2 of 2')).toBeTruthy();
    await waitFor(() => expect(mockWarpExtract).toHaveBeenCalled());
    const settled = mockWarpExtract.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    // Steady state: the tap itself warped nothing and decided nothing.
    expect(mockWarpExtract.mock.calls.length).toBe(settled);
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
  });
});

describe('original-blob capture (ImageCapture)', () => {
  function stubImageCaptureNative() {
    let seenSettings: { imageWidth?: number; imageHeight?: number } | undefined | null = null;
    let calls = 0;
    vi.stubGlobal(
      'ImageCapture',
      class {
        constructor(_track: unknown) {
          void _track;
        }
        async getPhotoCapabilities() {
          return { imageWidth: { max: 4000 }, imageHeight: { max: 3000 } };
        }
        async takePhoto(settings?: { imageWidth?: number; imageHeight?: number }) {
          calls += 1;
          seenSettings = settings ?? null;
          return new Blob(['sensor-bytes'], { type: 'image/jpeg' });
        }
      },
    );
    return {
      seen: () => seenSettings,
      calls: () => calls,
    };
  }

  function mockCameraForShutter() {
    const stop = vi.fn();
    const track = {
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
    return { stop };
  }

  it('takePhoto resolves the sensor-native blob with photoCapabilities max (no canvas re-encode)', async () => {
    const toBlobTypes: Array<string | undefined> = [];
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void, type?: string) {
      toBlobTypes.push(type);
      cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    };
    const probe = stubImageCaptureNative();
    mockCameraForShutter();
    const onCommit = vi.fn();
    render(<ScanicCapture onCommit={onCommit} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');

    fireEvent.click(q('[data-scan-capture]'));
    const cta = await findQ('[data-review-cta]');
    expect(cta.textContent).toBe('View 1 pages');
    // Best original: the capabilities max was requested.
    await waitFor(() => expect(probe.calls()).toBe(1));
    expect(probe.seen()).toEqual({ imageWidth: 4000, imageHeight: 3000 });
    // Capture never re-encoded: no canvas export during the shutter itself
    // (warped JPEG q0.9 runs later, in review, via canvasToJpeg only).
    expect(toBlobTypes.includes('image/jpeg')).toBe(false);

    // Original bytes flow downstream byte-identical.
    fireEvent.click(cta);
    await findQ('[data-scan-queue]');
    fireEvent.click(screen.getByText('Use original', { exact: true }));
    fireEvent.click(screen.getByText('Next', { exact: true }));
    await screen.findByText('All pages ready');
    fireEvent.click(screen.getByText('Build PDF', { exact: true }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const pages = onCommit.mock.calls[0][0] as Array<{ file: File; name: string }>;
    expect(pages).toHaveLength(1);
    expect(pages[0].file.type).toBe('image/jpeg');
    expect(await pages[0].file.text()).toBe('sensor-bytes');
  });

  it('takePhoto without exposed capabilities uses the native default', async () => {
    let seen: unknown = 'unset';
    vi.stubGlobal(
      'ImageCapture',
      class {
        constructor(_track: unknown) {
          void _track;
        }
        async takePhoto(settings?: unknown) {
          seen = settings;
          return new Blob(['native-default'], { type: 'image/jpeg' });
        }
      },
    );
    mockCameraForShutter();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    fireEvent.click(q('[data-scan-capture]'));
    await findQ('[data-review-cta]');
    expect(seen === undefined || seen === null).toBe(true);
  });

  it('canvas-draw fallback runs only when ImageCapture is unavailable', async () => {
    // No ImageCapture on this browser — the legacy video-frame path applies.
    vi.stubGlobal('ImageCapture', undefined);
    const toBlobTypes: Array<string | undefined> = [];
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void, type?: string) {
      toBlobTypes.push(type);
      cb(new Blob(['fallback-bytes'], { type: 'image/jpeg' }));
    };
    const drawImage = vi.fn();
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error test-only canvas 2D double (drawImage probe)
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage });
    try {
      mockCameraForShutter();
      render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
      await findQ('[data-scan-capture]');
      const video = document.querySelector(
        'video[aria-label="Camera preview"]',
      ) as HTMLVideoElement;
      Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true });

      fireEvent.click(q('[data-scan-capture]'));
      await findQ('[data-review-cta]');
      expect(drawImage).toHaveBeenCalled();
      expect(toBlobTypes.includes('image/jpeg')).toBe(true);
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetContext;
    }
  });
});

describe('camera picker', () => {
  function mockTwoCameras() {
    const stop1 = vi.fn();
    const track1 = {
      stop: stop1,
      readyState: 'live',
      getCapabilities: () => ({}),
      getSettings: () => ({ width: 1920, height: 1080 }),
      applyConstraints: vi.fn(async () => undefined),
    };
    const stream1 = {
      getTracks: () => [track1],
      getVideoTracks: () => [track1],
    } as unknown as MediaStream;
    const stop2 = vi.fn();
    const track2 = {
      stop: stop2,
      readyState: 'live',
      getCapabilities: () => ({}),
      getSettings: () => ({ width: 1920, height: 1080 }),
      applyConstraints: vi.fn(async () => undefined),
    };
    const stream2 = {
      getTracks: () => [track2],
      getVideoTracks: () => [track2],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async (constraints: unknown) => {
      const video = (constraints as { video?: { deviceId?: { exact?: string } } }).video;
      if (video?.deviceId?.exact === 'cam-2') return stream2;
      return stream1;
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia,
        enumerateDevices: vi.fn(async () => [
          { kind: 'videoinput', deviceId: 'cam-1', label: 'Front Cam', groupId: '' },
          { kind: 'videoinput', deviceId: 'cam-2', label: 'Back Cam', groupId: '' },
        ]),
      },
      configurable: true,
    });
    return { stop1, stop2, getUserMedia };
  }

  it('lists every video input in a 44px labelled select and restarts with deviceId exact', async () => {
    const { stop1, getUserMedia } = mockTwoCameras();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    const select = (await findQ('[data-camera-select]')) as HTMLSelectElement;
    expect(select.getAttribute('aria-label')).toBe('Choose camera');
    expect(select.className).toMatch('min-h-[44px]');
    const options = Array.from(select.querySelectorAll('option'));
    // Default + every enumerated input, ordered indices in the labels.
    expect(options.map((o) => o.value)).toEqual(['', 'cam-1', 'cam-2']);
    expect(options[1].textContent).toMatch(/1:/);
    expect(options[1].textContent).toMatch(/Front Cam/);
    expect(options[2].textContent).toMatch(/2:/);

    fireEvent.change(select, { target: { value: 'cam-2' } });
    await waitFor(() => {
      const last = getUserMedia.mock.calls[getUserMedia.mock.calls.length - 1][0] as {
        video: { deviceId?: { exact?: string } };
      };
      expect(last.video.deviceId).toEqual({ exact: 'cam-2' });
    });
    // Switching stops the old tracks.
    expect(stop1).toHaveBeenCalled();
    // Facing quick-flip stays alongside the picker.
    expect(screen.getByLabelText('Switch camera')).toBeTruthy();
  });

  it('falls back to facingMode with an honest note when the exact device fails', async () => {
    const stop = vi.fn();
    const track = {
      stop,
      readyState: 'live',
      getCapabilities: () => ({}),
      getSettings: () => ({ width: 1280, height: 720 }),
      applyConstraints: vi.fn(async () => undefined),
    };
    const fallbackStream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async (constraints: unknown) => {
      const video = (constraints as { video?: { deviceId?: { exact?: string } } }).video;
      if (video?.deviceId?.exact === 'dead-cam') {
        throw new DOMException('not found', 'NotFoundError');
      }
      return fallbackStream;
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia,
        enumerateDevices: vi.fn(async () => [
          { kind: 'videoinput', deviceId: 'dead-cam', label: 'Dead Cam', groupId: '' },
          { kind: 'videoinput', deviceId: 'good-cam', label: 'Good Cam', groupId: '' },
        ]),
      },
      configurable: true,
    });
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    const select = (await findQ('[data-camera-select]')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'dead-cam' } });
    // Fallback recovers to live with an honest note (no bare failure).
    await findQ('[data-scan-capture]');
    await waitFor(() => {
      expect(getUserMedia.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/could not be opened/);
  });
});

describe('orientation-honest constraints', () => {
  function setOrientation(type: string | null) {
    const screenObj = window.screen as unknown as { orientation?: { type?: string } };
    const prev = screenObj.orientation;
    if (type === null) {
      // @ts-expect-error test-only orientation removal
      delete window.screen.orientation;
    } else {
      Object.defineProperty(window.screen, 'orientation', {
        value: { type },
        configurable: true,
      });
    }
    return () => {
      if (prev === undefined) {
        try {
          // @ts-expect-error test-only orientation restore
          delete window.screen.orientation;
        } catch {
          // Nothing to restore.
        }
      } else {
        Object.defineProperty(window.screen, 'orientation', {
          value: prev,
          configurable: true,
        });
      }
    };
  }

  it('keeps portrait ideals on portrait screens (back 1080x1920, front 720x1280)', () => {
    const restore = setOrientation('portrait-primary');
    try {
      expect(isLandscapeScreen()).toBe(false);
      expect(buildVideoConstraints('environment')).toEqual({
        facingMode: { ideal: 'environment' },
        width: { ideal: 1080 },
        height: { ideal: 1920 },
      });
      expect(buildVideoConstraints('user')).toEqual({
        facingMode: { ideal: 'user' },
        width: { ideal: 720 },
        height: { ideal: 1280 },
      });
    } finally {
      restore();
    }
  });

  it('requests landscape max with a 1280 width floor on landscape screens', () => {
    const restore = setOrientation('landscape-primary');
    try {
      expect(isLandscapeScreen()).toBe(true);
      const back = buildVideoConstraints('environment');
      expect(back.width).toEqual({ ideal: 1920, min: 1280 });
      expect(back.height).toEqual({ ideal: 1080 });
      const front = buildVideoConstraints('user');
      expect(front.width).toEqual({ ideal: 1920, min: 1280 });
      expect(front.height).toEqual({ ideal: 1080 });
      // Explicit device omits facingMode (exact conflicts with it).
      const exact = buildVideoConstraints('environment', 'cam-2');
      expect(exact.deviceId).toEqual({ exact: 'cam-2' });
      expect('facingMode' in exact).toBe(false);
    } finally {
      restore();
    }
  });

  it('reflects the live stream aspect onto the preview (no forced ratio)', async () => {
    const restore = setOrientation('landscape-primary');
    try {
      const stop = vi.fn();
      const track = {
        stop,
        readyState: 'live',
        getCapabilities: () => ({}),
        getSettings: () => ({ width: 2560, height: 1440 }),
        applyConstraints: vi.fn(async () => undefined),
      };
      const stream = {
        getTracks: () => [track],
        getVideoTracks: () => [track],
      } as unknown as MediaStream;
      const getUserMedia = vi.fn(async (_constraints?: unknown) => stream);
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
        configurable: true,
      });
      render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
      await findQ('[data-scan-capture]');
      // Landscape ideals reached the sensor request (never a portrait crop).
      const firstCall = getUserMedia.mock.calls[0]?.[0] as unknown as {
        video: { width?: unknown; height?: unknown };
      };
      if (!firstCall) throw new Error('getUserMedia was not called');
      expect(firstCall.video.width).toEqual({ ideal: 1920, min: 1280 });
      const video = document.querySelector(
        'video[aria-label="Camera preview"]',
      ) as HTMLVideoElement;
      await waitFor(() => {
        expect(video.style.aspectRatio).toBe('2560 / 1440');
      });
      // Full-bleed layer keeps no hardcoded aspect/max-w box.
      expect(q('[data-viewfinder]').className).not.toMatch('aspect-');
    } finally {
      restore();
    }
  });

  it('names cameras with ordered indices and honest fallbacks', () => {
    expect(cameraDisplayName({ label: 'HD Webcam' }, 0)).toBe('1: HD Webcam');
    expect(cameraDisplayName({ label: '' }, 1)).toBe('Camera 2');
    expect(cameraDisplayName({ label: null }, 0, 'environment')).toBe('1: Back camera 1');
    expect(cameraDisplayName({ label: '  ' }, 2, 'user')).toBe('3: Front camera 3');
  });
});

describe('honest camera errors', () => {
  function mockFailingCamera(name: string) {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('camera failed', name);
        }),
        enumerateDevices: vi.fn(async () => []),
      },
      configurable: true,
    });
  }

  it('speaks plainly per failure type, never a bare something-went-wrong', async () => {
    expect(cameraFailureMessage('denied').toLowerCase()).toMatch(/denied/);
    expect(cameraFailureMessage('missing').toLowerCase()).toMatch(/no camera was found/);
    expect(cameraFailureMessage('overconstrained').toLowerCase()).toMatch(/resolution/);
    for (const kind of ['denied', 'missing', 'overconstrained', 'unavailable'] as const) {
      expect(cameraFailureMessage(kind).toLowerCase()).not.toMatch(/something went wrong/);
    }
  });

  it('shows the permission line when access is denied', async () => {
    mockFailingCamera('NotAllowedError');
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await waitFor(() => {
      expect(q('[data-finder-status]').textContent).toMatch(/denied/);
    });
  });

  it('shows the device-missing line when no device exists', async () => {
    mockFailingCamera('NotFoundError');
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await waitFor(() => {
      expect(q('[data-finder-status]').textContent).toMatch(/No camera was found/);
    });
  });

  it('shows the overconstrained line when the resolution cannot be met', async () => {
    mockFailingCamera('OverconstrainedError');
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await waitFor(() => {
      expect(q('[data-finder-status]').textContent).toMatch(/requested resolution/);
    });
  });

  it('denied state still mounts the real camera picker with the Default camera option', async () => {
    mockFailingCamera('NotAllowedError');
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await waitFor(() => {
      expect(q('[data-finder-status]').textContent).toMatch(/denied/);
    });
    // Real picker (same contract), honest empty state: Default camera only.
    const select = (await findQ('[data-camera-select]')) as HTMLSelectElement;
    expect(select.getAttribute('aria-label')).toBe('Choose camera');
    expect(select.disabled).toBe(false);
    expect(select.className).toMatch('min-h-[44px]');
    const options = Array.from(select.querySelectorAll('option'));
    expect(options.map((o) => o.value)).toEqual(['']);
    expect(options[0].textContent).toMatch(/Default camera/);
    // Denied fallback help + Retry stay untouched.
    expect(screen.getByText('Retry camera', { exact: true })).toBeTruthy();
  });
});

describe('camera-phase chrome (slim top bar)', () => {
  function mockCameraWithCaps(caps: unknown) {
    const stop = vi.fn();
    const track = {
      stop,
      readyState: 'live',
      getCapabilities: caps === 'missing' ? undefined : () => caps as Record<string, unknown>,
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
        enumerateDevices: vi.fn(async () => [
          { kind: 'videoinput', deviceId: 'cam-1', label: 'Front Cam', groupId: '' },
          { kind: 'videoinput', deviceId: 'cam-2', label: 'Back Cam', groupId: '' },
        ]),
      },
      configurable: true,
    });
  }

  it('labels every top-bar toggle so purpose is obvious without pressing', async () => {
    mockLiveCamera();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    // Icon + tiny visible labels (additive, aria names unchanged).
    expect(screen.getByText('Flash', { exact: true })).toBeTruthy();
    expect(screen.getByText('Flip', { exact: true })).toBeTruthy();
    expect(screen.getByText('Mirror', { exact: true })).toBeTruthy();
    expect(screen.getByLabelText('Switch camera')).toBeTruthy();
    expect(q('[data-mirror-toggle]').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Toggle torch')).toBeTruthy();
  });

  it('shows flash on explicit torch support', async () => {
    mockCameraWithCaps({ torch: true });
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    expect(screen.getByLabelText('Toggle torch')).toBeTruthy();
    expect(screen.getByText('Flash', { exact: true })).toBeTruthy();
  });

  it('shows flash when capabilities are inconclusive (no torch field)', async () => {
    mockCameraWithCaps({});
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    expect(screen.getByLabelText('Toggle torch')).toBeTruthy();
  });

  it('shows flash when getCapabilities is missing entirely', async () => {
    mockCameraWithCaps('missing');
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    expect(screen.getByLabelText('Toggle torch')).toBeTruthy();
  });

  it('hides flash only on hard-unsupported (torch: false)', async () => {
    mockCameraWithCaps({ torch: false });
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    expect(screen.queryByLabelText('Toggle torch')).toBeNull();
    expect(screen.queryByText('Flash', { exact: true })).toBeNull();
    // Flip + Mirror stay regardless of torch support.
    expect(screen.getByText('Flip', { exact: true })).toBeTruthy();
    expect(screen.getByText('Mirror', { exact: true })).toBeTruthy();
  });

  it('keeps the top bar, select row, and finder frame in distinct non-overlapping zones', async () => {
    mockCameraWithCaps({});
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    const topbar = q('[data-scanner-topbar]');
    const finder = q('[data-finder-frame]');
    expect(topbar).not.toBe(finder);
    expect(finder.contains(topbar)).toBe(false);
    expect(topbar.contains(finder)).toBe(false);
    // Top bar stacks vertically (slim row + select row below it).
    expect(topbar.className).toMatch('flex-col');
    // Finder frame carries top clearance below both chrome rows.
    expect(finder.className).toMatch('pt-36');
    // Camera select lives in its own compact row below the top bar,
    // never inside (over) the finder frame.
    const selectRow = q('[data-camera-select-row]');
    expect(selectRow).toBeTruthy();
    expect(topbar.contains(selectRow)).toBe(true);
    expect(finder.contains(selectRow)).toBe(false);
    const select = q('[data-camera-select]');
    expect(finder.contains(select)).toBe(false);
  });

  it('renders the camera select as a compact slim row (bounded, small text)', async () => {
    mockCameraWithCaps({});
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    const select = (await findQ('[data-camera-select]')) as HTMLSelectElement;
    expect(select.getAttribute('aria-label')).toBe('Choose camera');
    // 44px target kept, compactness additive: small text + max-width bound.
    expect(select.className).toMatch('min-h-[44px]');
    expect(select.className).toMatch('text-xs');
    expect(select.className).toMatch('max-w-');
    expect(select.className).toMatch('camera-select-compact');
  });

  it('docks the session strip in the bottom overlay cluster above the shutter row', async () => {
    mockLiveCamera();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    const strip = q('[data-scan-strip]');
    // Compact floating filmstrip keeps its height contract.
    expect(strip.className).toContain('h-16');
    // Docked-bottom: an absolute bottom-0 ancestor carries the overlay.
    const dock = strip.closest('div.absolute');
    expect(dock).not.toBeNull();
    expect((dock as HTMLElement).className).toMatch('bottom-0');
    // Same overlay cluster also carries the shutter row below the strip.
    const cluster = dock as HTMLElement;
    expect(cluster.querySelector('[data-scan-strip]')).not.toBeNull();
    expect(cluster.querySelector('[data-scan-capture]')).not.toBeNull();
    // Strip sits above the shutter in DOM order.
    const stripIndex = Array.from(cluster.querySelectorAll('*')).findIndex(
      (el) => el === strip || (el as Element).querySelector?.('[data-scan-strip]'),
    );
    expect(stripIndex).toBeGreaterThanOrEqual(0);
    expect(
      strip.compareDocumentPosition(q('[data-scan-capture]') as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('best-camera probe + persisted pick + flash honesty', () => {
  function mockProbeCameras() {
    const makeTrack = (caps: unknown) => ({
      stop: vi.fn(),
      readyState: 'live',
      getCapabilities: () => caps,
      getSettings: () => ({ width: 1920, height: 1080 }),
      applyConstraints: vi.fn(async () => undefined),
    });
    const lowCaps = { width: { max: 1920 }, height: { max: 1080 } };
    const highCaps = { width: { max: 4000 }, height: { max: 3000 } };
    const lowTrack = makeTrack(lowCaps);
    const lowStream = {
      getTracks: () => [lowTrack],
      getVideoTracks: () => [lowTrack],
    } as unknown as MediaStream;
    const highTrack = makeTrack(highCaps);
    const highStream = {
      getTracks: () => [highTrack],
      getVideoTracks: () => [highTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async (constraints: unknown) => {
      const video = (constraints as { video?: { deviceId?: { exact?: string } } }).video;
      if (video?.deviceId?.exact === 'cam-2') return highStream;
      return lowStream;
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia,
        enumerateDevices: vi.fn(async () => [
          { kind: 'videoinput', deviceId: 'cam-1', label: 'Back Cam 1', groupId: '' },
          { kind: 'videoinput', deviceId: 'cam-2', label: 'Back Cam 2', groupId: '' },
        ]),
      },
      configurable: true,
    });
    return { getUserMedia };
  }

  it('probes a sharper back camera and offers a one-tap switch (never auto-switches)', async () => {
    // No ImageCapture in jsdom here — the probe falls back to track
    // capabilities (low 1920x1080 vs high 4000x3000, ~5.7x = clearly beats).
    const { getUserMedia } = mockProbeCameras();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    const suggest = await findQ('[data-camera-suggest]');
    expect(suggest.textContent).toMatch(/Sharper camera found/);
    // Default stream stays live — the probe never auto-switches.
    expect(q('[data-scan-capture]')).toBeTruthy();
    const callsBefore = getUserMedia.mock.calls.length;
    fireEvent.click(suggest.querySelector('button') as HTMLElement);
    await waitFor(() => {
      expect(getUserMedia.mock.calls.length).toBeGreaterThan(callsBefore);
    });
    const last = getUserMedia.mock.calls[getUserMedia.mock.calls.length - 1][0] as {
      video: { deviceId?: { exact?: string } };
    };
    expect(last.video.deviceId).toEqual({ exact: 'cam-2' });
    // Suggestion clears once the switch starts.
    await waitFor(() => {
      expect(document.querySelector('[data-camera-suggest]')).toBeNull();
    });
  });

  it('persists the user pick to localStorage and restores it on the next mount', async () => {
    const { getUserMedia } = mockProbeCameras();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    const select = (await findQ('[data-camera-select]')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'cam-2' } });
    await waitFor(() => {
      const last = getUserMedia.mock.calls[getUserMedia.mock.calls.length - 1][0] as {
        video: { deviceId?: { exact?: string } };
      };
      expect(last.video.deviceId).toEqual({ exact: 'cam-2' });
    });
    expect(window.localStorage.getItem(CAMERA_STORAGE_KEY)).toBe('cam-2');
    cleanup();
    // New session (module ref cleared, storage kept) — the stored pick wins.
    __resetCameraChoiceForTests();
    window.localStorage.setItem(CAMERA_STORAGE_KEY, 'cam-2');
    const stop = vi.fn();
    const track = {
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
    const secondGUM = vi.fn(async (_constraints?: unknown) => stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: secondGUM,
        enumerateDevices: vi.fn(async () => [
          { kind: 'videoinput', deviceId: 'cam-1', label: 'Back Cam 1', groupId: '' },
          { kind: 'videoinput', deviceId: 'cam-2', label: 'Back Cam 2', groupId: '' },
        ]),
      },
      configurable: true,
    });
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    await waitFor(() => {
      expect(secondGUM).toHaveBeenCalled();
    });
    const first = secondGUM.mock.calls[0]?.[0] as unknown as {
      video: { deviceId?: { exact?: string } };
    };
    expect(first.video.deviceId).toEqual({ exact: 'cam-2' });
  });

  it('keeps the flash toggle mounted on a transient torch failure with an honest note', async () => {
    const stop = vi.fn();
    const track = {
      stop,
      readyState: 'live',
      getCapabilities: () => ({}),
      getSettings: () => ({ width: 1920, height: 1080 }),
      applyConstraints: vi.fn(async () => {
        throw new DOMException('torch failed', 'NotSupportedError');
      }),
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
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    fireEvent.click(screen.getByLabelText('Toggle torch'));
    await waitFor(() => {
      expect(screen.queryByLabelText('Toggle torch')).not.toBeNull();
    });
    // Toggle never unmounts on the transient failure — the honest note shows.
    expect(screen.getByLabelText('Toggle torch')).toBeTruthy();
    expect(document.querySelector('[data-torch-note]')?.textContent).toMatch(
      /Flash isn't available on this camera/,
    );
  });

  it('resets the torch to off on every camera change', async () => {
    const makeTrack = () => ({
      stop: vi.fn(),
      readyState: 'live',
      getCapabilities: () => ({ torch: true }),
      getSettings: () => ({ width: 1920, height: 1080 }),
      applyConstraints: vi.fn(async () => undefined),
    });
    const track1 = makeTrack();
    const stream1 = {
      getTracks: () => [track1],
      getVideoTracks: () => [track1],
    } as unknown as MediaStream;
    const track2 = makeTrack();
    const stream2 = {
      getTracks: () => [track2],
      getVideoTracks: () => [track2],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async (constraints: unknown) => {
      const video = (constraints as { video?: { deviceId?: { exact?: string } } }).video;
      if (video?.deviceId?.exact === 'cam-2') return stream2;
      return stream1;
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia,
        enumerateDevices: vi.fn(async () => [
          { kind: 'videoinput', deviceId: 'cam-1', label: 'Back Cam 1', groupId: '' },
          { kind: 'videoinput', deviceId: 'cam-2', label: 'Back Cam 2', groupId: '' },
        ]),
      },
      configurable: true,
    });
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    fireEvent.click(screen.getByLabelText('Toggle torch'));
    await waitFor(() => {
      expect(screen.getByLabelText('Toggle torch').getAttribute('aria-pressed')).toBe('true');
    });
    const select = (await findQ('[data-camera-select]')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'cam-2' } });
    await waitFor(() => {
      expect(screen.getByLabelText('Toggle torch').getAttribute('aria-pressed')).toBe('false');
    });
  });

  it('lists exactly the enumerated logical cameras — never a fabricated third lens', async () => {
    mockProbeCameras();
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await findQ('[data-scan-capture]');
    const select = (await findQ('[data-camera-select]')) as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option'));
    // Default + the 2 enumerated logical lenses (hidden physical lenses are
    // platform-invisible and must never be faked into the list).
    expect(options.map((o) => o.value)).toEqual(['', 'cam-1', 'cam-2']);
    expect(options).toHaveLength(3);
  });
});

describe('main-lens scoring (scoreBackCamera)', () => {
  it('penalizes ultra-wide labels so a plain main lens wins at equal pixels', () => {
    const ultra = scoreBackCamera({
      label: '0.5x Ultra Wide camera',
      maxPixels: 12_000_000,
      hasZoom: false,
    });
    const main = scoreBackCamera({ label: 'Back camera', maxPixels: 12_000_000, hasZoom: false });
    expect(ultra).toBeLessThan(main);
    // Penalty is -100; the megapixel tiebreak alone (+12) can never overcome it.
    expect(main - ultra).toBeGreaterThanOrEqual(100);
  });

  it('prefers a zoom-capable lens over a fixed lens at equal pixels', () => {
    const noZoom = scoreBackCamera({ label: 'Back camera', maxPixels: 8_000_000, hasZoom: false });
    const zoom = scoreBackCamera({ label: 'Back camera', maxPixels: 8_000_000, hasZoom: true });
    expect(zoom).toBeGreaterThan(noZoom);
    expect(zoom - noZoom).toBe(50);
  });

  it('breaks ties with megapixels when labels and zoom match', () => {
    const low = scoreBackCamera({ label: 'Back camera', maxPixels: 8_000_000, hasZoom: false });
    const high = scoreBackCamera({ label: 'Back camera', maxPixels: 12_000_000, hasZoom: false });
    expect(high).toBeGreaterThan(low);
    expect(high - low).toBeCloseTo(4, 6);
  });

  it('matches the label penalty variants and the zoom capability gate', () => {
    for (const label of ['Ultra camera', 'wide-angle', '0.5x', 'fisheye lens', 'Macro cam']) {
      expect(scoreBackCamera({ label, maxPixels: 12_000_000, hasZoom: false })).toBeLessThan(
        scoreBackCamera({ label: 'Back camera', maxPixels: 1_000_000, hasZoom: false }),
      );
    }
    expect(hasZoomCapability({ zoom: { min: 1, max: 8 } })).toBe(true);
    expect(hasZoomCapability({ zoom: { min: 1, max: 1 } })).toBe(false);
    expect(hasZoomCapability({})).toBe(false);
    expect(hasZoomCapability(null)).toBe(false);
  });
});
