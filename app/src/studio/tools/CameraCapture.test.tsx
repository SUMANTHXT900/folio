/**
 * Scanner camera tests with mocked mediaDevices (no hardware in CI).
 *
 * Covers: permission-denied failure copy + retry, successful stream with
 * scanner overlay, grid toggle, session strip rendering, Done lifecycle
 * (tracks stopped, onDone called). Real frame capture and capability
 * controls are manual-device-matrix only (Phase 3 adds capability tests).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraCapture } from './CameraCapture';

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
        sessionPages={[]}
      />,
    );
    await screen.findByLabelText('Capture page');
    expect(screen.getByLabelText('Import images from files')).toBeTruthy();
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
        sessionPages={[{ id: 's1', previewUrl: 'blob:s1', name: 'scan-001.jpg' }]}
      />,
    );
    await screen.findByLabelText('Capture page');
    const cta = screen.getByLabelText('Finish scanning and view pages');
    expect(cta.textContent).toContain('View pages (1)');
    fireEvent.click(cta);
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
