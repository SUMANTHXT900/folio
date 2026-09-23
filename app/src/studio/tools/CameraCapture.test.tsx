/**
 * Scanner camera tests with mocked mediaDevices (no hardware in CI).
 *
 * Covers: permission-denied failure copy + retry, successful stream with
 * scanner overlay, grid toggle, session strip rendering, Done lifecycle
 * (tracks stopped, onDone called). Real frame capture and capability
 * controls are manual-device-matrix only (Phase 3 adds capability tests).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraCapture } from './CameraCapture';

const stopTrack = vi.fn();
const fakeStream = { getTracks: () => [{ stop: stopTrack, kind: 'video' }] };

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

describe('CameraCapture failure states', () => {
  it('maps permission denial to friendly copy with retry + back actions', async () => {
    const media = mockMedia({
      getUserMedia: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    });
    const onDone = vi.fn();
    render(<CameraCapture onCapture={noop} onRetake={noop} onDone={onDone} sessionPages={[]} />);
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
    render(<CameraCapture onCapture={noop} onRetake={noop} onDone={noop} sessionPages={[]} />);
    await screen.findByText(/No camera was found/);
  });
});

describe('CameraCapture scanner UI', () => {
  it('shows overlay, grid toggle, strip, and stops tracks on Done', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    const onDone = vi.fn();
    const { unmount } = render(
      <CameraCapture
        onCapture={noop}
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
    expect(screen.getByLabelText('Retake last capture')).toBeTruthy();
    // Done stops the stream and leaves.
    fireEvent.click(screen.getByLabelText('Done scanning'));
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('stops the stream on unmount', async () => {
    mockMedia({ getUserMedia: async () => fakeStream });
    const { unmount } = render(
      <CameraCapture onCapture={noop} onRetake={noop} onDone={noop} sessionPages={[]} />,
    );
    await screen.findByLabelText('Capture page');
    unmount();
    expect(stopTrack).toHaveBeenCalled();
  });
});
