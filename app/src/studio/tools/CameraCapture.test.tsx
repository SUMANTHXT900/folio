/**
 * Scanner camera tests with mocked mediaDevices (no hardware in CI).
 *
 * Covers: permission-denied failure copy + retry, successful stream with
 * scanner overlay, grid toggle, session strip rendering, Done lifecycle
 * (tracks stopped, onDone called), auto-capture (motion-gated
 * auto-shutter: SAD stability gate incl. static feeds, cooldown, toggle). Real frame capture and capability controls are
 * manual-device-matrix only (Phase 3 adds capability tests).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_CAPTURE_SAD_THRESHOLD,
  AUTO_CAPTURE_STABLE_EDGE,
  CameraCapture,
  canSkipNormalization,
  captureTargetDims,
  frameMeanSad,
  SCAN_CAPTURE_LONG_EDGE,
  toGrayLuma,
} from './CameraCapture';

const stopTrack = vi.fn();
function videoTrack(caps?: unknown, applyImpl?: (c: unknown) => Promise<void>) {
  return {
    stop: stopTrack,
    kind: 'video',
    getCapabilities: caps === undefined ? undefined : () => caps,
    applyConstraints: vi.fn(applyImpl ?? (async () => undefined)),
  };
}
function streamWith(track: unknown) {
  return { getTracks: () => [track], getVideoTracks: () => [track] };
}
const fakeStream = streamWith(videoTrack({}));

function mockMedia(impl: {
  getUserMedia: () => Promise<unknown>;
  enumerateDevices?: () => Promise<unknown[]>;
}) {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn(impl.getUserMedia),
      enumerateDevices: vi.fn(
        impl.enumerateDevices ?? (async () => [{ kind: 'videoinput', deviceId: 'd1', label: '' }]),
      ),
    },
    configurable: true,
  });
  return navigator.mediaDevices as unknown as {
    getUserMedia: ReturnType<typeof vi.fn>;
    enumerateDevices: ReturnType<typeof vi.fn>;
  };
}

const playMock = vi.fn(async () => undefined);

beforeEach(() => {
  stopTrack.mockClear();
  playMock.mockClear();
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
    value: playMock,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const noop = () => undefined;
const noopImport = async () => ({
  added: 0,
  failed: 0,
  cancelled: false,
  firstError: null,
});

describe('CameraCapture failure states', () => {
  it('maps permission denial to friendly copy with retry + back actions', async () => {
    const media = mockMedia({
      getUserMedia: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    });
    const onDone = vi.fn();
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={onDone}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByText(/Camera access was denied/);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText('Back to pages'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(stopTrack).not.toHaveBeenCalled();
  });

  it('maps missing cameras without crashing', async () => {
    mockMedia({
      getUserMedia: async () => {
        throw new DOMException('none', 'NotFoundError');
      },
    });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByText(/No camera was found/);
  });
});

describe('CameraCapture scanner UI', () => {
  it('shows overlay, grid toggle, strip, and stops tracks on Done', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    const onDone = vi.fn();
    const { unmount } = render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={onDone}
        onBuildNow={noop}
        sessionPages={[
          { id: 's1', previewUrl: 'blob:s1', name: 'scan-001.jpg' },
          { id: 's2', previewUrl: 'blob:s2', name: 'scan-002.jpg' },
        ]}
      />,
    );
    await screen.findByLabelText('Capture page');
    // Framing overlay present, grid off by default.
    expect(document.querySelector('[data-scanner-overlay]')).not.toBeNull();
    expect(document.querySelector('[data-scanner-grid]')).toBeNull();
    // Auto-capture toggle: present in the dock and default ON.
    const autoToggle = screen.getByLabelText('Auto capture');
    expect(autoToggle.getAttribute('aria-pressed')).toBe('true');
    expect(autoToggle.getAttribute('data-auto-capture')).toBe('on');
    fireEvent.click(screen.getByLabelText('Show alignment grid'));
    expect(document.querySelector('[data-scanner-grid]')).not.toBeNull();
    // Session strip: newest last, count visible.
    expect(screen.getByText('2 captured')).toBeTruthy();
    expect(screen.getByAltText('Captured page 2: scan-002.jpg')).toBeTruthy();
    // Retake enabled with session pages.
    expect(screen.getByLabelText('Undo last capture')).toBeTruthy();
    // Done stops the stream and leaves.
    fireEvent.click(screen.getByLabelText('Back to pages'));
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('stops the stream on unmount', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    const { unmount } = render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    unmount();
    expect(stopTrack).toHaveBeenCalled();
  });
});

describe('CameraCapture responsive HUD', () => {
  it('layers topbar, dock, and strip without moving behavior', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[{ id: 's1', previewUrl: 'blob:s1', name: 'scan-001.jpg' }]}
      />,
    );
    await screen.findByLabelText('Capture page');
    // TopBar: close + grid + switch.
    expect(screen.getByLabelText('Back to pages')).toBeTruthy();
    expect(screen.getByLabelText('Show alignment grid')).toBeTruthy();
    expect(screen.getByLabelText('Switch camera')).toBeTruthy();
    // Dock group with shutter + retake.
    expect(screen.getByLabelText('Camera controls')).toBeTruthy();
    expect(screen.getByLabelText('Undo last capture')).toBeTruthy();
    // Session strip intact.
    expect(screen.getByLabelText('Pages captured this session')).toBeTruthy();
  });

  it('keeps torch compact and renders no zoom control (F-11)', async () => {
    const track = videoTrack({
      zoom: { min: 2, max: 6, step: 1 },
      torch: true,
      focusMode: [],
    });
    mockMedia({ getUserMedia: async () => streamWith(track) });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    const torch = await screen.findByLabelText('Turn flashlight on');
    expect(torch.className).toContain('rounded-full');
    // Zoom control removed: the track's range is not a focal-length
    // multiplier (BUGS F-11), so nothing zoom-like may render even when
    // the device reports a zoom range.
    expect(screen.queryByLabelText(/Camera zoom/)).toBeNull();
    expect(screen.queryByText('1.0×')).toBeNull();
  });
});

describe('CameraCapture scanner surface (M3.x)', () => {
  it('has Import in the scanner bar and no scan-mode selector', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    expect(screen.getByLabelText('Import images from files')).toBeTruthy();
    // Fixed viewfinder: the session strip container is ALWAYS rendered
    // (its height reserved) even before the first capture, so the
    // measured viewport rect never changes when pages land.
    expect(screen.getByLabelText('Pages captured this session')).toBeTruthy();
    expect(screen.getByText('Captured pages appear here')).toBeTruthy();
    // The mode selector is gone entirely: no Original/Document/
    // Grayscale/B&W group anywhere in the scanner.
    expect(screen.queryByLabelText('Capture mode')).toBeNull();
    expect(screen.queryByLabelText(/scan mode/i)).toBeNull();
    expect(screen.queryByText('Grayscale')).toBeNull();
    expect(screen.queryByText('B&W')).toBeNull();
    // Immersive root: fixed interaction surface (mobile) with safe-area.
    const root = document.querySelector('[data-scanner-root]') as HTMLElement | null;
    expect(root).not.toBeNull();
    expect(root?.className).toContain('fixed');
    expect(root?.className).toContain('flex');
    // Desktop keeps a bounded centered panel instead of the phone overlay.
    expect(root?.className).toContain('md:w-[46rem]');
    expect(root?.className).toContain('md:left-1/2');
    // Safe-area handling ships as utility classes on the immersive root.
    expect(root?.className).toContain('safe-area-inset-top');
    expect(root?.className).toContain('safe-area-inset-bottom');
  });

  it('runs a picker import with progress and cancel wiring', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    let captured: {
      files: File[];
      progress: (completed: number, total: number, name: string) => void;
      signal: AbortSignal;
      finish: () => void;
    } | null = null;
    const onImportFiles = vi.fn(
      async (
        files: File[],
        progress: (completed: number, total: number, name: string) => void,
        signal: AbortSignal,
      ) => {
        await new Promise<void>((resolve) => {
          captured = { files, progress, signal, finish: resolve };
          signal.addEventListener('abort', () => resolve());
        });
        return { added: files.length, failed: 0, cancelled: signal.aborted, firstError: null };
      },
    );
    render(
      <CameraCapture
        onImportFiles={onImportFiles}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    const input = document.querySelector(
      'input[type="file"][data-import-input]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    const files = [new File(['a'], 'a.jpg', { type: 'image/jpeg' })];
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(captured).not.toBeNull());
    const session = captured as unknown as {
      progress: (completed: number, total: number, name: string) => void;
      signal: AbortSignal;
    };
    // Progress overlay renders with the imported count.
    act(() => {
      session.progress(1, 3, 'a.jpg');
    });
    expect(await screen.findByText(/Preparing images… 1 of 3/)).toBeTruthy();
    // Cancel aborts the signal (import resolves as cancelled).
    fireEvent.click(screen.getByLabelText('Cancel import'));
    await waitFor(() => expect(session.signal.aborted).toBe(true));
    await screen.findByText(/Import cancelled/);
  });
});

describe('CameraCapture capability controls', () => {
  const fullCaps = {
    torch: true,
    focusMode: ['continuous', 'single-shot'],
  };

  it('renders torch only when reported, and applies through constraints', async () => {
    const track = videoTrack(fullCaps);
    mockMedia({ getUserMedia: async () => streamWith(track) });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    fireEvent.click(await screen.findByLabelText('Turn flashlight on'));
    await waitFor(() =>
      expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] }),
    );
    expect(screen.getByLabelText('Turn flashlight off')).toBeTruthy();
  });

  it('hides torch on capability-free tracks (laptop-webcam shape)', async () => {
    const track = videoTrack(undefined);
    mockMedia({ getUserMedia: async () => streamWith(track) });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    expect(screen.queryByLabelText(/Camera zoom/)).toBeNull();
    expect(screen.queryByLabelText(/flashlight/)).toBeNull();
    expect(screen.queryByText(/Tap the preview to refocus/)).toBeNull();
  });

  it('disables torch with a note when applyConstraints rejects', async () => {
    const track = videoTrack(fullCaps, async () => {
      throw new DOMException('rejected', 'NotAllowedError');
    });
    mockMedia({ getUserMedia: async () => streamWith(track) });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    fireEvent.click(await screen.findByLabelText('Turn flashlight on'));
    await screen.findByText(/flashlight is not available/);
    expect(screen.queryByLabelText(/flashlight/)).toBeNull();
  });

  it('tap-to-focus fires only with single-shot support', async () => {
    const track = videoTrack(fullCaps);
    mockMedia({ getUserMedia: async () => streamWith(track) });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    const viewport = document.querySelector('video')?.parentElement;
    expect(viewport).not.toBeNull();
    fireEvent.click(viewport!, { clientX: 10, clientY: 10 });
    expect(document.querySelector('[data-focus-point]')).not.toBeNull();
    expect(track.applyConstraints).toHaveBeenCalledWith({
      advanced: [{ focusMode: 'single-shot' }],
    });
  });

  it('taps do nothing without single-shot support', async () => {
    const track = videoTrack({ focusMode: ['continuous'] });
    mockMedia({ getUserMedia: async () => streamWith(track) });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    const viewport = document.querySelector('video')?.parentElement;
    expect(viewport).not.toBeNull();
    if (viewport) fireEvent.click(viewport, { clientX: 5, clientY: 5 });
    expect(document.querySelector('[data-focus-point]')).toBeNull();
    const requested = JSON.stringify(track.applyConstraints.mock.calls);
    expect(requested).not.toContain('single-shot');
  });

  it('recalculates capabilities when switching cameras', async () => {
    const rear = videoTrack(fullCaps);
    const front = videoTrack({});
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(streamWith(rear))
      .mockResolvedValue(streamWith(front));
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia, enumerateDevices: async () => [] },
      configurable: true,
    });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Turn flashlight on');
    fireEvent.click(screen.getByLabelText('Switch camera'));
    await waitFor(() => expect(screen.queryByLabelText(/flashlight/)).toBeNull());
  });
});

describe('CameraCapture scanner shell (M3.x follow-up)', () => {
  it('locks page scroll while open and restores it on exit', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    const { unmount } = render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    // The page behind can no longer scroll under the scanner surface.
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.position).toBe('');
    expect(document.body.style.overflow).toBe('');
  });

  it('offers a primary View pages CTA once pages exist', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    const onDone = vi.fn();
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={onDone}
        onBuildNow={noop}
        sessionPages={[{ id: 's1', previewUrl: 'blob:s1', name: 'scan-001.jpg' }]}
      />,
    );
    await screen.findByLabelText('Capture page');
    const cta = document.querySelector('[data-review-cta]');
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain('View 1 page');
    fireEvent.click(cta as HTMLElement);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape (keyboard-accessible exit)', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    const onDone = vi.fn();
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={onDone}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('CameraCapture lifecycle hardening', () => {
  it('B1: a stale late-resolving stream is stopped and never installed', async () => {
    const staleStop = vi.fn();
    const staleStream = {
      getTracks: () => [{ stop: staleStop, kind: 'video' }],
      getVideoTracks: () => [],
    };
    const liveStop = vi.fn();
    const liveStream = {
      getTracks: () => [{ stop: liveStop, kind: 'video' }],
      getVideoTracks: () => [],
    };
    let resolveStale!: (s: unknown) => void;
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveStale = r as (s: unknown) => void)))
      .mockResolvedValue(liveStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia, enumerateDevices: async () => [] },
      configurable: true,
    });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    // First request still pending — start another generation.
    fireEvent.click(screen.getByLabelText('Switch camera'));
    await screen.findByLabelText('Capture page');
    // Late resolution of generation 1: stopped, never installed.
    resolveStale(staleStream);
    await waitFor(() => expect(staleStop).toHaveBeenCalledTimes(1));
    expect(liveStop).not.toHaveBeenCalled();
    expect((document.querySelector('video') as HTMLVideoElement | null)?.srcObject).toBe(
      liveStream,
    );
    expect(screen.queryByText(/disconnected|blocked|could not be started/)).toBeNull();
  });

  it('B2: track ended moves to disconnected with retry recovery', async () => {
    const listeners = new Map<string, Set<() => void>>();
    const trackStop = vi.fn();
    const track = {
      stop: trackStop,
      kind: 'video',
      getCapabilities: () => ({}),
      applyConstraints: async () => undefined,
      addEventListener: (t: string, h: () => void) => {
        let set = listeners.get(t);
        if (!set) {
          set = new Set();
          listeners.set(t, set);
        }
        set.add(h);
      },
      removeEventListener: (t: string, h: () => void) => listeners.get(t)?.delete(h),
    };
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [track],
      getVideoTracks: () => [track],
    }));
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia, enumerateDevices: async () => [] },
      configurable: true,
    });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    listeners.get('ended')?.forEach((h) => h());
    await screen.findByText(/camera disconnected/i);
    expect(trackStop).toHaveBeenCalled();
    // Retry restores a live camera.
    fireEvent.click(screen.getByText('Try again'));
    await screen.findByLabelText('Capture page');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('B3: play() rejection releases hardware and offers retry', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    playMock.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    const onDone = vi.fn();
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={onDone}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByText(/blocked by the browser \(autoplay policy\)/);
    expect(stopTrack).toHaveBeenCalled();
    expect(screen.queryByLabelText('Capture page')).toBeNull();
    // Retry (a real user tap) resumes the camera.
    playMock.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByText('Try again'));
    await screen.findByLabelText('Capture page');
  });

  it('devicechange refreshes devices and disconnects a vanished active camera', async () => {
    const target = new EventTarget();
    const removeSpy = vi.spyOn(target, 'removeEventListener');
    const d1 = { kind: 'videoinput', deviceId: 'd1', label: 'Cam 1' };
    const d2 = { kind: 'videoinput', deviceId: 'd2', label: 'Cam 2' };
    let current: Array<{ kind: string; deviceId: string; label: string }> = [d1, d2];
    const getUserMedia = vi.fn(async () => fakeStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: Object.assign(target, {
        getUserMedia,
        enumerateDevices: async () => current,
      }),
      configurable: true,
    });
    const { unmount } = render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    // Select the second camera explicitly, then unplug it.
    fireEvent.change(screen.getByLabelText('Choose camera'), { target: { value: 'd2' } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    current = [d1];
    target.dispatchEvent(new Event('devicechange'));
    await screen.findByText(/no longer available/);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('devicechange', expect.any(Function));
  });
});

describe('CameraCapture tab-hidden pause (AGENT11)', () => {
  function pausableTrack() {
    return {
      stop: stopTrack,
      enabled: true,
      kind: 'video',
      getCapabilities: () => ({}),
      applyConstraints: vi.fn(async () => undefined),
    };
  }
  function setHidden(value: boolean) {
    Object.defineProperty(document, 'hidden', { value, configurable: true });
  }
  function restoreHidden() {
    delete (document as unknown as Record<string, unknown>)['hidden'];
  }

  it('disables tracks on hide and re-enables on visible without re-requesting', async () => {
    const track = pausableTrack();
    const media = mockMedia({ getUserMedia: async () => streamWith(track) });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    expect(track.enabled).toBe(true);
    try {
      setHidden(true);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(track.enabled).toBe(false);
      setHidden(false);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(track.enabled).toBe(true);
      // Still live on the same stream: no failure, no second request.
      expect(screen.getByLabelText('Capture page')).toBeTruthy();
      expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    } finally {
      restoreHidden();
    }
  });

  it('pauses on pagehide and resumes on pageshow', async () => {
    const track = pausableTrack();
    mockMedia({ getUserMedia: async () => streamWith(track) });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    window.dispatchEvent(new Event('pagehide'));
    expect(track.enabled).toBe(false);
    window.dispatchEvent(new Event('pageshow'));
    expect(track.enabled).toBe(true);
    expect(screen.getByLabelText('Capture page')).toBeTruthy();
  });

  it('never touches a released stream after unmount', async () => {
    const track = pausableTrack();
    mockMedia({ getUserMedia: async () => streamWith(track) });
    const { unmount } = render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    unmount();
    expect(stopTrack).toHaveBeenCalledTimes(1);
    // Late visibility events reach no listener: no throw, no extra stop.
    try {
      setHidden(true);
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    } finally {
      restoreHidden();
    }
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
});

describe('CameraCapture secure-context branch (AGENT11)', () => {
  it('shows the HTTPS/localhost message when mediaDevices is missing', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    try {
      render(
        <CameraCapture
          onImportFiles={noopImport}
          onScanAccept={noop}
          onRetake={noop}
          onDone={noop}
          onBuildNow={noop}
          sessionPages={[]}
        />,
      );
      await screen.findByText(/needs HTTPS or localhost/);
    } finally {
      delete (navigator as unknown as Record<string, unknown>)['mediaDevices'];
    }
  });

  it('prefers the HTTPS message over the permission copy on insecure origins', async () => {
    mockMedia({
      getUserMedia: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    });
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    try {
      render(
        <CameraCapture
          onImportFiles={noopImport}
          onScanAccept={noop}
          onRetake={noop}
          onDone={noop}
          onBuildNow={noop}
          sessionPages={[]}
        />,
      );
      await screen.findByText(/needs HTTPS or localhost/);
      expect(screen.queryByText(/access was denied/)).toBeNull();
    } finally {
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    }
  });

  it('maps AbortError to an actionable retry line', async () => {
    mockMedia({
      getUserMedia: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByText(/request was interrupted/);
  });
});

describe('CameraCapture landscape-compact layout (AGENT11)', () => {
  it('compacts dock and strip in landscape via layout classes only', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[{ id: 's1', previewUrl: 'blob:s1', name: 'scan-001.jpg' }]}
      />,
    );
    await screen.findByLabelText('Capture page');
    // Orientation-aware compaction: pure CSS, no behavior change.
    expect(screen.getByLabelText('Camera controls').className).toContain('landscape:mt-1');
    expect(screen.getByLabelText('Pages captured this session').className).toContain(
      'landscape:gap-1',
    );
    // Behavior intact: shutter + strip still wired.
    expect(screen.getByLabelText('Undo last capture')).toBeTruthy();
    expect(screen.getByAltText('Captured page 1: scan-001.jpg')).toBeTruthy();
  });
});

describe('CameraCapture facing-toggle device semantics (AGENT11)', () => {
  it('clears the explicit device choice when toggling facing cameras', async () => {
    const getUserMedia = vi.fn(async () => fakeStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia,
        enumerateDevices: async () => [
          { kind: 'videoinput', deviceId: 'd1', label: 'Cam 1' },
          { kind: 'videoinput', deviceId: 'd2', label: 'Cam 2' },
        ],
      },
      configurable: true,
    });
    render(
      <CameraCapture
        onImportFiles={noopImport}
        onScanAccept={noop}
        onRetake={noop}
        onDone={noop}
        onBuildNow={noop}
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    fireEvent.change(screen.getByLabelText('Choose camera'), { target: { value: 'd2' } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText('Choose camera') as HTMLSelectElement).value).toBe('d2');
    // Facing toggle drops the explicit deviceId (no stale-device lock).
    fireEvent.click(screen.getByLabelText('Switch camera'));
    await waitFor(() =>
      expect((screen.getByLabelText('Choose camera') as HTMLSelectElement).value).toBe(''),
    );
  });
});

describe('CameraCapture capture/scan budgets (5-4/5-6, 3600px scan-capture policy)', () => {
  it('captureTargetDims keeps small frames untouched (no upscale)', () => {
    expect(captureTargetDims(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(captureTargetDims(2500, 1406)).toEqual({ width: 2500, height: 1406 });
    expect(captureTargetDims(3600, 2025)).toEqual({ width: 3600, height: 2025 });
  });

  it('captureTargetDims clamps 12MP-class frames to the 3600px scan-capture budget', () => {
    expect(SCAN_CAPTURE_LONG_EDGE).toBe(3600);
    expect(captureTargetDims(4000, 3000)).toEqual({ width: 3600, height: 2700 });
    expect(captureTargetDims(3000, 4000)).toEqual({ width: 2700, height: 3600 });
  });

  it('canSkipNormalization skips within-budget JPEGs with zero decodes (gallery default)', () => {
    const jpeg = new File(['x'], 'scan-001.jpg', { type: 'image/jpeg' });
    expect(canSkipNormalization({ width: 1920, height: 1080 }, jpeg)).toBe(true);
    expect(canSkipNormalization({ width: 2500, height: 1875 }, jpeg)).toBe(true);
    // Over the 2500px gallery budget the full path still runs.
    expect(canSkipNormalization({ width: 3600, height: 2700 }, jpeg)).toBe(false);
  });

  it('canSkipNormalization takes a maxLongEdge: camera accept keeps 3600px captures', () => {
    const jpeg = new File(['x'], 'scan-001.jpg', { type: 'image/jpeg' });
    // The camera accept path passes the scan-capture budget so
    // budget-clamped captures are NOT re-downscaled.
    expect(canSkipNormalization({ width: 3200, height: 2400 }, jpeg, SCAN_CAPTURE_LONG_EDGE)).toBe(
      true,
    );
    expect(canSkipNormalization({ width: 3600, height: 2700 }, jpeg, SCAN_CAPTURE_LONG_EDGE)).toBe(
      true,
    );
    // Over budget still normalizes, whatever the budget.
    expect(canSkipNormalization({ width: 4000, height: 3000 }, jpeg, SCAN_CAPTURE_LONG_EDGE)).toBe(
      false,
    );
  });

  it('canSkipNormalization keeps PNGs and oversized frames on the full path', () => {
    const png = new File(['x'], 'shot.png', { type: 'image/png' });
    const extPng = new File(['x'], 'shot.PNG', { type: '' });
    const jpeg = new File(['x'], 'big.jpg', { type: 'image/jpeg' });
    expect(canSkipNormalization({ width: 1280, height: 960 }, png)).toBe(false);
    expect(canSkipNormalization({ width: 1280, height: 960 }, extPng)).toBe(false);
    expect(canSkipNormalization({ width: 4000, height: 3000 }, jpeg)).toBe(false);
    expect(canSkipNormalization({ width: 1280, height: 960 }, png, SCAN_CAPTURE_LONG_EDGE)).toBe(
      false,
    );
  });
});

describe('CameraCapture auto-capture (motion-gated shutter)', () => {
  /** RGBA frame where every pixel is the same gray `value`. */
  const grayFrame = (value: number, pixels: number): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(pixels * 4);
    for (let i = 0; i < pixels; i += 1) {
      data[i * 4] = value;
      data[i * 4 + 1] = value;
      data[i * 4 + 2] = value;
      data[i * 4 + 3] = 255;
    }
    return data;
  };

  /** Pixels in the stability canvas for the default 1920×1080 stream. */
  const stabPixels = (videoW = 1920, videoH = 1080): number => {
    const long = Math.max(videoW, videoH);
    const w = Math.max(1, Math.round((videoW * AUTO_CAPTURE_STABLE_EDGE) / long));
    const h = Math.max(1, Math.round((videoH * AUTO_CAPTURE_STABLE_EDGE) / long));
    return w * h;
  };

  interface FakeCanvasStub {
    /** `null` → default all-zero frames. */
    setProvider: (fn: ((call: number) => Uint8ClampedArray) | null) => void;
  }

  /**
   * jsdom has no canvas 2D context: installs fake canvas/video plumbing
   * so the live tick can draw, read pixels, and encode. `getImageData`
   * serves frames from the test-controlled provider (one call per
   * stability tick — the detection tick never reads pixels).
   */
  function installFakeCanvas(videoW = 1920, videoH = 1080): FakeCanvasStub {
    let calls = 0;
    let provider: ((call: number) => Uint8ClampedArray) | null = null;
    const fakeCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
        calls += 1;
        return { data: provider !== null ? provider(calls) : grayFrame(0, w * h) };
      }),
    };
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
      value: () => fakeCtx,
      configurable: true,
    });
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'toBlob', {
      value: (cb: (b: Blob | null) => void) => cb(new Blob(['jpeg'], { type: 'image/jpeg' })),
      configurable: true,
    });
    Object.defineProperty(window.HTMLVideoElement.prototype, 'videoWidth', {
      value: videoW,
      configurable: true,
    });
    Object.defineProperty(window.HTMLVideoElement.prototype, 'videoHeight', {
      value: videoH,
      configurable: true,
    });
    return {
      setProvider: (fn) => {
        calls = 0;
        provider = fn;
      },
    };
  }

  function restoreFakeCanvas() {
    const canvasProto = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    delete canvasProto['getContext'];
    delete canvasProto['toBlob'];
    const videoProto = window.HTMLVideoElement.prototype as unknown as Record<string, unknown>;
    delete videoProto['videoWidth'];
    delete videoProto['videoHeight'];
  }

  const queuedThumbs = () =>
    document.querySelectorAll('[aria-label="Pages captured this session"] img').length;

  /** Advances fake timers AND drains the microtask chains they start. */
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
  };

  /**
   * The dock renders synchronously, so the shutter is in the DOM before
   * `getUserMedia` resolves. `findBy*` is unusable here (its first check
   * is timer-deferred, and nothing advances the fake clock), so assert
   * synchronously and flush the getUserMedia → live chain by hand.
   */
  const liveCamera = async () => {
    screen.getByLabelText('Capture page');
    await act(async () => {
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
  };

  /** Alternating 40/41 frames: SAD 1 (stable — real sensors have noise). */
  const steadyProvider = (pixels: number) => (call: number) =>
    grayFrame(call % 2 === 0 ? 40 : 41, pixels);

  beforeEach(() => {
    URL.createObjectURL = vi.fn(
      () => 'blob:capture-thumb',
    ) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  });

  it('frameMeanSad/toGrayLuma: the stability math behind the gate', () => {
    // Pin the documented threshold: stable ticks sit at/below this mean
    // gray-level diff; SAD 0 (static feed) counts as stable.
    expect(AUTO_CAPTURE_SAD_THRESHOLD).toBe(2);
    const gray40 = toGrayLuma(grayFrame(40, 4), 2, 2);
    expect([...gray40]).toEqual([40, 40, 40, 40]);
    expect(frameMeanSad(gray40, toGrayLuma(grayFrame(40, 4), 2, 2))).toBe(0);
    expect(frameMeanSad(gray40, toGrayLuma(grayFrame(41, 4), 2, 2))).toBe(1);
    expect(frameMeanSad(gray40, toGrayLuma(grayFrame(200, 4), 2, 2))).toBe(160);
    // Mismatched/incomparable frames are maximally unstable.
    expect(frameMeanSad(gray40, new Uint8Array(0))).toBe(Number.POSITIVE_INFINITY);
    expect(frameMeanSad(gray40, new Uint8Array(3))).toBe(Number.POSITIVE_INFINITY);
  });

  it('fires the existing shutter after 3 consecutive stable ticks, without detection', async () => {
    vi.useFakeTimers();
    try {
      const pixels = stabPixels();
      const stub = installFakeCanvas();
      stub.setProvider(steadyProvider(pixels));
      mockMedia({ getUserMedia: async () => fakeStream });
      const onScanAccept = vi.fn();
      render(
        <CameraCapture
          onImportFiles={noopImport}
          onScanAccept={onScanAccept}
          onRetake={noop}
          onDone={noop}
          onBuildNow={noop}
          sessionPages={[]}
        />,
      );
      await liveCamera();
      // Tick 1 is the baseline only — nothing queued.
      await advance(500);
      expect(queuedThumbs()).toBe(0);
      // Ticks 2-3: two stable ticks, still short of N=3.
      await advance(1000);
      expect(queuedThumbs()).toBe(0);
      // Tick 4: third consecutive stable tick → the shutter fires and the
      // capture lands in the session strip (queued for review, never
      // committed straight to the page collection).
      await advance(500);
      expect(queuedThumbs()).toBe(1);
      expect(screen.getByAltText('Captured page 1: scan-001.jpg')).toBeTruthy();
      expect(onScanAccept).not.toHaveBeenCalled();
    } finally {
      restoreFakeCanvas();
      vi.useRealTimers();
    }
  });

  it('spaces auto-fires by the 1.5s cooldown', async () => {
    vi.useFakeTimers();
    try {
      const pixels = stabPixels();
      const stub = installFakeCanvas();
      stub.setProvider(steadyProvider(pixels));
      mockMedia({ getUserMedia: async () => fakeStream });
      render(
        <CameraCapture
          onImportFiles={noopImport}
          onScanAccept={noop}
          onRetake={noop}
          onDone={noop}
          onBuildNow={noop}
          sessionPages={[]}
        />,
      );
      await liveCamera();
      await advance(2000); // First fire at the 4th tick.
      expect(queuedThumbs()).toBe(1);
      // A fully stable stream re-arms: the counter restarts after a fire
      // (2 stable ticks at t=3000 — short of N), and the cooldown holds
      // until 1.5s after the previous shot.
      await advance(1000);
      expect(queuedThumbs()).toBe(1);
      await advance(500); // t=3500: 3 stable ticks AND cooldown elapsed.
      expect(queuedThumbs()).toBe(2);
    } finally {
      restoreFakeCanvas();
      vi.useRealTimers();
    }
  });

  it('motion resets the stability counter (the page must be held still)', async () => {
    vi.useFakeTimers();
    try {
      const pixels = stabPixels();
      const stub = installFakeCanvas();
      stub.setProvider((call) =>
        call === 3 ? grayFrame(200, pixels) : grayFrame(call % 2 === 0 ? 40 : 41, pixels),
      );
      mockMedia({ getUserMedia: async () => fakeStream });
      render(
        <CameraCapture
          onImportFiles={noopImport}
          onScanAccept={noop}
          onRetake={noop}
          onDone={noop}
          onBuildNow={noop}
          sessionPages={[]}
        />,
      );
      await liveCamera();
      await advance(2000); // One unstable tick at t=1500 breaks the run.
      expect(queuedThumbs()).toBe(0);
      // Three fresh stable ticks (t=2500..3500) fire the shutter.
      await advance(1500);
      expect(queuedThumbs()).toBe(1);
    } finally {
      restoreFakeCanvas();
      vi.useRealTimers();
    }
  });

  it('fires on a bit-identical (static) stream after N stable ticks', async () => {
    vi.useFakeTimers();
    try {
      const pixels = stabPixels();
      const stub = installFakeCanvas();
      // SAD exactly 0 forever: a synthetic/static feed (like the E2E
      // fake Y4M camera) counts as stable — bounded by cooldown + toggle.
      stub.setProvider(() => grayFrame(40, pixels));
      mockMedia({ getUserMedia: async () => fakeStream });
      const onScanAccept = vi.fn();
      render(
        <CameraCapture
          onImportFiles={noopImport}
          onScanAccept={onScanAccept}
          onRetake={noop}
          onDone={noop}
          onBuildNow={noop}
          sessionPages={[]}
        />,
      );
      await liveCamera();
      await advance(5000);
      // Baseline tick + 3 stable ticks fire at ~1.5s, cooldown spaces the
      // next fire at ~3s: at least one auto-capture by t=5s.
      expect(queuedThumbs()).toBeGreaterThanOrEqual(1);
    } finally {
      restoreFakeCanvas();
      vi.useRealTimers();
    }
  });

  it('the toggle turns auto-capture off; the manual shutter still works', async () => {
    vi.useFakeTimers();
    try {
      const pixels = stabPixels();
      const stub = installFakeCanvas();
      stub.setProvider(steadyProvider(pixels));
      mockMedia({ getUserMedia: async () => fakeStream });
      render(
        <CameraCapture
          onImportFiles={noopImport}
          onScanAccept={noop}
          onRetake={noop}
          onDone={noop}
          onBuildNow={noop}
          sessionPages={[]}
        />,
      );
      await liveCamera();
      const toggle = screen.getByLabelText('Auto capture');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(toggle.getAttribute('data-auto-capture')).toBe('off');
      // A fully stable stream no longer fires anything.
      await advance(5000);
      expect(queuedThumbs()).toBe(0);
      // The manual shutter always works.
      fireEvent.click(screen.getByLabelText('Capture page'));
      await act(async () => {
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      });
      expect(queuedThumbs()).toBe(1);
    } finally {
      restoreFakeCanvas();
      vi.useRealTimers();
    }
  });
});
