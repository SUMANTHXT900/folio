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
import ScanicCapture, {
  AUTO_CAPTURE_COOLDOWN_MS,
  AUTO_CAPTURE_MEAN_THRESHOLD,
  AUTO_CAPTURE_STABLE_TICKS_REQUIRED,
  AUTO_CAPTURE_TICK_MS,
  SCANIC_ML_ASSET_BASE_URL,
  formatScanName,
  grayscaleSAD,
  isStableFrame,
  shouldAutoFire,
} from './ScanicCapture';
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
      cb(new Blob(['png-bytes'], { type: 'image/png' }));
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
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(['png-bytes'], { type: 'image/png' }));
    };
    const onCommit = vi.fn();
    const onExit = vi.fn();
    render(<ScanicCapture onCommit={onCommit} onExit={onExit} />);
    await injectAndReview(photo('a.jpg', [1, 2]), photo('b.jpg', [3, 4]));

    // Eager warp fills each page's blob on view; no accept click needed —
    // Next is already gated open (>=1 page) and builds everything remaining.
    // Visit page 2 so its eager warp completes before building.
    await waitFor(() => expect(mockExtract).toHaveBeenCalled());
    fireEvent.click(q('[data-page-next]'));
    await screen.findByText('Page 2 of 2');
    await waitFor(() => expect(mockExtract.mock.calls.length).toBeGreaterThanOrEqual(2));
    const next = screen.getByText('Next', { exact: true }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    await screen.findByText('All pages ready');

    expect(screen.getByText('Build PDF', { exact: true })).toBeTruthy();
    expect(screen.getByText('Back to camera', { exact: true })).toBeTruthy();

    fireEvent.click(screen.getByText('Build PDF', { exact: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    const pages = onCommit.mock.calls[0][0] as Array<{ file: File; name: string }>;
    expect(pages.map((p) => p.name)).toEqual(['scan-001.jpg', 'scan-002.jpg']);
    expect(pages[0].file.type).toBe('image/png');
    expect(await pages[0].file.text()).toBe('png-bytes');
    expect(pages[1].file.type).toBe('image/png');
    expect(await pages[1].file.text()).toBe('png-bytes');
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
    const pages = onCommit.mock.calls[0][0] as Array<{ file: File; name: string }>;
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe('scan-001.jpg');
    expect(pages[0].file.type).toBe('image/jpeg');
    expect(Array.from(new Uint8Array(await pages[0].file.arrayBuffer()))).toEqual([7, 7, 7]);
  });

  it('Use original toggles back to warped', async () => {
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(['png-bytes'], { type: 'image/png' }));
    };
    const onCommit = vi.fn();
    render(<ScanicCapture onCommit={onCommit} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [7, 7, 7]));
    await waitFor(() => expect(mockExtract).toHaveBeenCalled());
    // Warped -> original -> warped: two toggles land back on the crop.
    fireEvent.click(screen.getByText('Use original', { exact: true }));
    fireEvent.click(screen.getByText('Use original', { exact: true }));
    expect(screen.getByText('Page 1 of 1')).toBeTruthy();
    fireEvent.click(screen.getByText('Next', { exact: true }));
    await screen.findByText('All pages ready');
    fireEvent.click(screen.getByText('Build PDF', { exact: true }));
    const pages = onCommit.mock.calls[0][0] as Array<{ file: File; name: string }>;
    expect(pages).toHaveLength(1);
    expect(pages[0].file.type).toBe('image/png');
    expect(await pages[0].file.text()).toBe('png-bytes');
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

describe('eager warp', () => {
  it('warps a page with corners immediately, with no accept click', async () => {
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(['png-bytes'], { type: 'image/png' }));
    };
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    // Eager warp fills the single canvas; implicit accept needs no click.
    const img = (await findQ('[data-crop-result-img]')) as HTMLImageElement;
    expect(img.src).toMatch(/^blob:mock-/);
    await waitFor(() => expect(mockExtract).toHaveBeenCalled());
    // Visited on show; Next is gated open (>=1 page) without any accept.
    await waitFor(() => {
      expect(q('[data-review-progress]').getAttribute('aria-label')).toBe('1 of 1 viewed');
    });
    expect((screen.getByText('Next', { exact: true }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('warps once per quad — no re-warp loop for the same corners', async () => {
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(['png-bytes'], { type: 'image/png' }));
    };
    render(<ScanicCapture onCommit={() => undefined} onExit={() => undefined} />);
    await injectAndReview(photo('a.jpg', [1]));
    await findQ('[data-crop-result-img]');
    await waitFor(() => expect(mockExtract).toHaveBeenCalled());
    const calls = mockExtract.mock.calls.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(mockExtract.mock.calls.length).toBe(calls);
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
    mockScan.mockReturnValue(new Promise(() => {}) as ReturnType<typeof scanDocument>);
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
      cb(new Blob(['png-bytes'], { type: 'image/png' }));
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
    const reset = await screen.findByRole('button', { name: 'Reset to auto' });
    expect((reset as HTMLButtonElement).disabled).toBe(false);
  });
});
