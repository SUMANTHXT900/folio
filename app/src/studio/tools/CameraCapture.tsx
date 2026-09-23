/**
 * Document-scanner camera — an INPUT SOURCE for the Images → PDF page
 * collection, not a separate pipeline. Captures become `File`s entering
 * the same `useImagePages` collection as uploads (source: 'camera').
 *
 * Phase 2 scope (presentation only): full-ratio letterboxed preview
 * (never cropped), framing-guide overlay with corner markers + dim mask,
 * 3×3 grid toggle, session thumbnail strip, shutter-style capture.
 * NO hardware capabilities here (no getCapabilities/applyConstraints,
 * no zoom/torch/focus) — Phase 3. NO edge detection/perspective
 * correction — v2.0. The guide is a framing aid, not detected edges.
 *
 * Lifecycle: one `MediaStream` per session, opened on mount, stopped on
 * Done/close/unmount. No frames retained — only captured Files.
 *
 * State machine (local, explicit — no ambiguous "stream exists but dead"
 * states): `starting` → `live` → (`disconnected` | `preview-blocked` |
 * `failed`), with `live` re-entered via Try again. Every async
 * continuation is generation-guarded: only the current generation may
 * install state or a stream; stale resolutions stop their own stream
 * and touch nothing (B1). Track `ended` → `disconnected` (B2);
 * `devicechange` refreshes the picker and disconnects a vanished active
 * device; `play()` rejection → `preview-blocked`, never a frozen frame
 * presented as live (B3).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorBlock } from '../components/ui';
import {
  NO_CAPABILITIES,
  readTrackCapabilities,
  requestContinuousModes,
  type CameraCapabilities,
} from './cameraCapabilities';

type CameraStatus = 'starting' | 'live' | 'failed' | 'disconnected' | 'preview-blocked';

export interface SessionThumb {
  id: string;
  previewUrl: string;
  name: string;
}

function failureMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was denied. Allow it in the browser address bar — or add images with the file picker instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. Use the file picker to add images instead.';
    case 'NotReadableError':
      return 'The camera is busy (another app or tab is using it). Close it there and try again — or use the file picker.';
    default:
      return 'The camera could not be started on this browser. Use the file picker to add images instead.';
  }
}

function stopStream(stream: MediaStream | null) {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
}

/**
 * Framing guide overlay: corner markers, dimmed surround, optional 3×3
 * grid. Purely visual (`pointer-events-none`) — it never touches the
 * captured image. Not document detection; just a framing aid.
 */
function ScannerOverlay({ grid }: { grid: boolean }) {
  const corners = [
    'left-0 top-0 border-l-4 border-t-4 rounded-tl-lg',
    'right-0 top-0 border-r-4 border-t-4 rounded-tr-lg',
    'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-lg',
    'bottom-0 right-0 border-b-4 border-r-4 rounded-br-lg',
  ];
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0" data-scanner-overlay>
      {/* Dimmed surround: four masks around the guide rect (inset 10%/7%). */}
      <div className="absolute inset-x-0 top-0 h-[7%] bg-black/55" />
      <div className="absolute inset-x-0 bottom-0 h-[7%] bg-black/55" />
      <div className="absolute bottom-[7%] left-0 top-[7%] w-[10%] bg-black/55" />
      <div className="absolute bottom-[7%] right-0 top-[7%] w-[10%] bg-black/55" />
      {/* Guide frame + corner markers. */}
      <div className="absolute inset-x-[10%] inset-y-[7%]">
        <div className="absolute inset-0 rounded-lg border border-white/40" />
        {corners.map((pos) => (
          <span key={pos} className={`absolute h-8 w-8 border-brass-300 ${pos}`} />
        ))}
        {grid && (
          <div className="absolute inset-0" data-scanner-grid>
            <span className="absolute bottom-0 left-1/3 top-0 w-px bg-white/35" />
            <span className="absolute bottom-0 left-2/3 top-0 w-px bg-white/35" />
            <span className="absolute left-0 right-0 top-1/3 h-px bg-white/35" />
            <span className="absolute left-0 right-0 top-2/3 h-px bg-white/35" />
          </div>
        )}
      </div>
    </div>
  );
}

export function CameraCapture({
  onCapture,
  onRetake,
  onDone,
  sessionPages,
}: {
  /** A captured page (caller adds it to the shared collection). */
  onCapture: (file: File) => void;
  /** Drops the most recent capture of the current session. */
  onRetake: () => void;
  /** Leaves camera mode (stream stopped first). */
  onDone: () => void;
  /** This session's captures (preview URLs only — strip is not a collection). */
  sessionPages: SessionThumb[];
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const counterRef = useRef(0);
  const focusTimer = useRef<number | null>(null);
  const [status, setStatus] = useState<CameraStatus>('starting');
  const [failure, setFailure] = useState<string | null>(null);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [capturing, setCapturing] = useState(false);
  const [grid, setGrid] = useState(false);
  // Hardware capabilities of the ACTIVE track only — recalculated on
  // every (re)start so switching cameras never shows stale controls.
  const [caps, setCaps] = useState<CameraCapabilities>(NO_CAPABILITIES);
  const [zoom, setZoom] = useState<number | null>(null);
  const [zoomDead, setZoomDead] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchDead, setTorchDead] = useState(false);
  const [controlNote, setControlNote] = useState<string | null>(null);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  // Real frame aspect (letterboxed, never cropped). Defaults to 4:3
  // until the stream reports dimensions; tracks orientation changes.
  const [aspect, setAspect] = useState({ w: 4, h: 3 });

  // Generation guard (B1): every start() takes a generation; async
  // continuations that arrive stale stop their own stream and install
  // nothing. Mirrors for closures that outlive renders.
  const genRef = useRef(0);
  const statusRef = useRef<CameraStatus>('starting');
  statusRef.current = status;
  const deviceIdRef = useRef(deviceId);
  deviceIdRef.current = deviceId;
  // Detach for the current track-ended listener (B2).
  const endedCleanup = useRef<(() => void) | null>(null);
  const detachEnded = () => {
    endedCleanup.current?.();
    endedCleanup.current = null;
  };

  /** Installs the disconnected state: hardware released, caps cleared. */
  const markDisconnected = useCallback((message: string) => {
    detachEnded();
    stopStream(streamRef.current);
    streamRef.current = null;
    trackRef.current = null;
    setCaps(NO_CAPABILITIES);
    setZoom(null);
    setTorchOn(false);
    setFailure(message);
    setStatus('disconnected');
  }, []);

  const start = useCallback(
    async (mode: 'environment' | 'user', exactDevice: string) => {
      const gen = genRef.current + 1;
      genRef.current = gen;
      const isCurrent = () => genRef.current === gen;
      if (!navigator.mediaDevices?.getUserMedia) {
        setFailure(failureMessage(new DOMException('unsupported', 'NotSupportedError')));
        setStatus('failed');
        return;
      }
      detachEnded();
      stopStream(streamRef.current);
      streamRef.current = null;
      trackRef.current = null;
      // Fresh capability state per session: never carry controls over from
      // the previous camera.
      setCaps(NO_CAPABILITIES);
      setZoom(null);
      setZoomDead(false);
      setTorchOn(false);
      setTorchDead(false);
      setControlNote(null);
      setFocusPoint(null);
      setStatus('starting');
      setFailure(null);
      try {
        const constraints: MediaStreamConstraints = {
          audio: false,
          video: exactDevice
            ? { deviceId: { exact: exactDevice } }
            : { facingMode: { ideal: mode } },
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (!isCurrent()) {
          // Stale resolution (B1): stop it, install nothing.
          stopStream(stream);
          return;
        }
        streamRef.current = stream;
        const videoTrack = stream.getVideoTracks()[0] ?? null;
        trackRef.current = videoTrack;
        const detected = readTrackCapabilities(videoTrack);
        setCaps(detected);
        if (detected.zoom !== null) setZoom(detected.zoom.min);
        // Silent best-effort: continuous focus/exposure where reported.
        void requestContinuousModes(videoTrack);
        // Unexpected track death (B2): unplug, OS revoke, browser kill.
        if (videoTrack && typeof videoTrack.addEventListener === 'function') {
          const onEnded = () => {
            if (!isCurrent()) return;
            markDisconnected(
              'The camera disconnected. Reconnect it and try again — your pages are safe.',
            );
          };
          videoTrack.addEventListener('ended', onEnded);
          endedCleanup.current = () => videoTrack.removeEventListener('ended', onEnded);
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          try {
            await video.play();
          } catch (playError) {
            // Preview never started (B3): release hardware, say so, offer
            // retry. Never present a frozen frame as a live camera.
            if (!isCurrent()) {
              stopStream(stream);
              return;
            }
            detachEnded();
            stopStream(streamRef.current);
            streamRef.current = null;
            trackRef.current = null;
            setCaps(NO_CAPABILITIES);
            const blocked =
              playError instanceof DOMException && playError.name === 'NotAllowedError';
            setFailure(
              blocked
                ? 'Video preview was blocked by the browser (autoplay policy). Tap Try again — that tap counts as interaction.'
                : 'Video preview could not start on this browser. Try again, or use the file picker.',
            );
            setStatus('preview-blocked');
            return;
          }
        }
        const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (!isCurrent()) return;
        setDevices(all.filter((d) => d.kind === 'videoinput'));
        setStatus('live');
      } catch (error) {
        if (!isCurrent()) return;
        detachEnded();
        stopStream(streamRef.current);
        streamRef.current = null;
        trackRef.current = null;
        setFailure(failureMessage(error));
        setStatus('failed');
      }
    },
    [markDisconnected],
  );

  // Open on mount / facing change; stop + invalidate on unmount.
  useEffect(() => {
    void start(facing, deviceId);
    return () => {
      genRef.current += 1;
      detachEnded();
      stopStream(streamRef.current);
      streamRef.current = null;
      trackRef.current = null;
      if (focusTimer.current !== null) {
        window.clearTimeout(focusTimer.current);
        focusTimer.current = null;
      }
    };
    // Restart only when the requested source changes — never on capture.
  }, [facing, deviceId]);

  // Device plug/unplug: refresh the picker; if the explicitly selected
  // device vanished mid-session, move to the disconnected state instead
  // of showing a dead camera. Never restarts the stream just because a
  // device was added.
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md || typeof md.addEventListener !== 'function') return;
    const onDeviceChange = () => {
      void (async () => {
        const all = await md.enumerateDevices().catch(() => []);
        const videoInputs = all.filter((d) => d.kind === 'videoinput');
        setDevices(videoInputs);
        const wanted = deviceIdRef.current;
        if (
          wanted &&
          statusRef.current !== 'starting' &&
          !videoInputs.some((d) => d.deviceId === wanted)
        ) {
          markDisconnected(
            'The selected camera is no longer available. Choose another camera or try again.',
          );
        }
      })();
    };
    md.addEventListener('devicechange', onDeviceChange);
    return () => {
      md.removeEventListener?.('devicechange', onDeviceChange);
    };
  }, [markDisconnected]);

  const syncAspect = useCallback(() => {
    const video = videoRef.current;
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      setAspect({ w: video.videoWidth, h: video.videoHeight });
    }
  }, []);

  const leave = () => {
    genRef.current += 1;
    detachEnded();
    stopStream(streamRef.current);
    streamRef.current = null;
    trackRef.current = null;
    onDone();
  };

  /**
   * Zoom through the lens, never CSS: applies the track's own range.
   * A rejection disables the control with a note — reporting a zoom
   * capability never promised it would apply.
   */
  const applyZoom = async (value: number) => {
    const track = trackRef.current;
    if (!track || caps.zoom === null) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] });
      setZoom(value);
    } catch {
      setZoomDead(true);
      setControlNote('Zoom is not adjustable on this camera right now.');
    }
  };

  /** Torch toggle through constraints; rejection disables it with a note. */
  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track || !caps.torch) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchDead(true);
      setControlNote('The flashlight is not available on this camera right now.');
    }
  };

  /**
   * Tap-to-focus, only when the track reports single-shot AF: triggers a
   * real refocus cycle and marks the tap point while it runs. Without
   * that capability taps do nothing — no fake focus feedback.
   */
  const tapToFocus = (e: React.MouseEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || !caps.supportsTapToFocus) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setFocusPoint({
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    });
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => setFocusPoint(null), 900);
    track
      .applyConstraints({ advanced: [{ focusMode: 'single-shot' } as MediaTrackConstraintSet] })
      .catch(() => undefined);
  };

  const capture = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || capturing) return;
    setCapturing(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('2D canvas unavailable for capture.');
      // Front camera: un-mirror so text reads correctly.
      if (facing === 'user') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.92),
      );
      canvas.width = 0;
      canvas.height = 0;
      if (blob === null) throw new Error('Capture encode failed.');
      counterRef.current += 1;
      const name = `scan-${String(counterRef.current).padStart(3, '0')}.jpg`;
      onCapture(new File([blob], name, { type: 'image/jpeg' }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Capture failed.');
    } finally {
      setCapturing(false);
    }
  };

  const ratio = aspect.w / aspect.h;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-ink-700 dark:text-paper-100">
          Scan document
          {sessionPages.length > 0 && (
            <span className="ml-2 rounded-full bg-forest-500/15 px-2 py-0.5 text-xs text-forest-600 dark:text-forest-300">
              {sessionPages.length} captured
            </span>
          )}
        </p>
        <button
          onClick={leave}
          aria-label="Done scanning"
          className="rounded-lg px-2 py-1 text-xs text-ink-400 transition-colors hover:bg-paper-200 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-700"
        >
          Done
        </button>
      </div>

      {status === 'starting' && (
        <div className="flex aspect-[4/3] items-center justify-center rounded-xl bg-paper-200/60 dark:bg-ink-900/60">
          <p className="text-sm text-ink-400 dark:text-ink-300">Starting camera…</p>
        </div>
      )}

      {(status === 'failed' || status === 'disconnected' || status === 'preview-blocked') &&
        failure && (
          <div className="space-y-3">
            <ErrorBlock error={new Error(failure)} />
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => void start(facing, deviceId)}>
                Try again
              </Button>
              <Button variant="ghost" onClick={leave}>
                Back to pages
              </Button>
            </div>
          </div>
        )}

      {status !== 'failed' && status !== 'disconnected' && status !== 'preview-blocked' && (
        <div className={status === 'starting' ? 'hidden' : ''}>
          {/* Viewport: exact frame aspect, letterboxed — the full frame
              stays visible and matches the captured image. */}
          <div className="flex justify-center">
            <div
              className="relative w-full overflow-hidden rounded-xl bg-ink-950"
              style={{
                aspectRatio: `${aspect.w} / ${aspect.h}`,
                maxHeight: '62vh',
                width: ratio < 1 ? `min(100%, calc(62vh * ${ratio}))` : '100%',
              }}
              onClick={tapToFocus}
            >
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                onLoadedMetadata={syncAspect}
                onResize={syncAspect}
                className="absolute inset-0 h-full w-full object-contain"
                style={facing === 'user' ? { transform: 'scaleX(-1)' } : undefined}
              />
              <ScannerOverlay grid={grid} />
              {/* Tap-to-focus marker: positional feedback for a requested
                  refocus cycle — rendered only when actually requested. */}
              {focusPoint !== null && (
                <span
                  aria-hidden
                  data-focus-point
                  className="absolute h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brass-300"
                  style={{ left: `${focusPoint.x}%`, top: `${focusPoint.y}%` }}
                />
              )}
            </div>
          </div>

          {/* Session strip: previews only, newest last with a brass ring. */}
          {sessionPages.length > 0 && (
            <div
              className="mt-3 flex gap-2 overflow-x-auto pb-1"
              aria-label="Pages captured this session"
            >
              {sessionPages.map((thumb, i) => (
                <div
                  key={thumb.id}
                  className={`relative h-16 w-12 shrink-0 overflow-hidden rounded-lg border bg-ink-950 ${
                    i === sessionPages.length - 1
                      ? 'border-brass-400 ring-2 ring-brass-400/40'
                      : 'border-paper-300 dark:border-ink-700'
                  }`}
                  title={thumb.name}
                >
                  {thumb.previewUrl ? (
                    <img
                      src={thumb.previewUrl}
                      alt={`Captured page ${i + 1}: ${thumb.name}`}
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="h-full w-full animate-pulse" />
                  )}
                  <span className="absolute bottom-0.5 left-1 rounded bg-ink-900/80 px-1 font-mono text-[10px] text-paper-50">
                    {i + 1}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Shutter row: grid, capability controls, capture, retake.
              Torch/zoom render ONLY when the active track reports them;
              a rejected apply disables the control with a note. */}
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => setGrid((g) => !g)}
              aria-label={grid ? 'Hide alignment grid' : 'Show alignment grid'}
              aria-pressed={grid}
              title="Alignment grid"
              className={`flex h-11 min-w-11 items-center justify-center rounded-xl border px-3 text-xs transition-colors ${
                grid
                  ? 'border-brass-400/50 text-brass-600 dark:text-brass-300'
                  : 'border-paper-300 text-ink-500 dark:border-ink-700 dark:text-ink-300'
              }`}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <path d="M4 4h16v16H4zM4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16" />
              </svg>
            </button>
            {caps.torch && !torchDead && (
              <button
                onClick={() => void toggleTorch()}
                aria-label={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
                aria-pressed={torchOn}
                title="Flashlight"
                className={`flex h-11 min-w-11 items-center justify-center rounded-xl border px-3 text-xs transition-colors ${
                  torchOn
                    ? 'border-brass-400/50 text-brass-600 dark:text-brass-300'
                    : 'border-paper-300 text-ink-500 dark:border-ink-700 dark:text-ink-300'
                }`}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z" />
                </svg>
              </button>
            )}
            {caps.zoom !== null && !zoomDead && zoom !== null && (
              <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-paper-300 px-3 dark:border-ink-700">
                <span className="text-xs text-ink-500 dark:text-ink-300">Zoom</span>
                <input
                  type="range"
                  min={caps.zoom.min}
                  max={caps.zoom.max}
                  step={caps.zoom.step}
                  value={zoom}
                  onChange={(e) => void applyZoom(Number(e.target.value))}
                  aria-label={`Camera zoom, ${zoom.toFixed(1)} times`}
                  className="min-w-0 flex-1 accent-brass-500"
                />
                <span className="font-mono text-xs text-ink-500 tabular-nums dark:text-ink-300">
                  {zoom.toFixed(1)}×
                </span>
              </label>
            )}
            <button
              onClick={() => void capture()}
              disabled={capturing}
              aria-label={capturing ? 'Capturing page' : 'Capture page'}
              className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border-4 border-paper-300 bg-paper-100 transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 dark:border-ink-600 dark:bg-ink-800"
            >
              <span
                aria-hidden
                className={`h-10 w-10 rounded-full transition-colors ${
                  capturing ? 'bg-brass-400' : 'bg-brass-500'
                }`}
              />
            </button>
            <button
              onClick={onRetake}
              disabled={sessionPages.length === 0}
              aria-label="Retake last capture"
              title="Retake last capture"
              className="flex h-11 min-w-11 items-center justify-center rounded-xl border border-paper-300 px-3 text-xs text-ink-500 transition-colors hover:border-brass-400/40 disabled:opacity-30 dark:border-ink-700 dark:text-ink-300"
            >
              Retake
            </button>
          </div>
          {controlNote !== null && (
            <p role="status" className="mt-2 text-xs text-ink-400 dark:text-ink-300">
              {controlNote}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <button
              onClick={() => {
                setDeviceId('');
                setFacing((f) => (f === 'environment' ? 'user' : 'environment'));
              }}
              aria-label="Switch camera"
              className="rounded-lg border border-paper-300 px-3 py-1.5 text-xs text-ink-500 transition-colors hover:border-brass-400/40 hover:text-ink-900 dark:border-ink-700 dark:text-ink-300 dark:hover:text-paper-100"
            >
              Switch camera
            </button>
            {devices.length > 1 && (
              <select
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                className="rounded-lg border border-paper-300 bg-transparent px-2 py-1.5 text-xs text-ink-500 dark:border-ink-700 dark:text-ink-300"
                aria-label="Choose camera"
              >
                <option value="">Auto</option>
                {devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </select>
            )}
            <span className="text-xs text-ink-400 dark:text-ink-300">
              Frame the page in the guide — captures join the page list below.
              {caps.supportsTapToFocus ? ' Tap the preview to refocus.' : ''}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
