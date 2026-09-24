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
import { buildVideoConstraints } from './cameraConstraints';
import { SCANNER_MODES, useScanProcessor, type ScannerMode } from './scan/useScanProcessor';

const MODE_LABELS: Record<ScannerMode, string> = {
  original: 'Original',
  document: 'Document',
  grayscale: 'Grayscale',
  blackwhite: 'B&W',
};

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
  onScanAccept,
  onRetake,
  onDone,
  sessionPages,
}: {
  /** A directly captured page (Original mode — v1.9 path, no worker). */
  onCapture: (file: File) => void;
  /** An accepted scan (processed file + optional original to retain). */
  onScanAccept: (entry: { file: File; original: File | null; name: string }) => void;
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

  // Document scanner (M3): capture → worker → review state machine.
  // `original` mode bypasses it entirely (v1.9 direct capture).
  const scan = useScanProcessor();

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
          video: buildVideoConstraints({ facing: mode, deviceId: exactDevice }),
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
        if (videoTrack && typeof videoTrack.getSettings === 'function') {
          // Negotiated reality, not the request: ideals may or may not
          // hold. Debug-level only (never an error, never user-facing).
          const s = videoTrack.getSettings();
          console.debug(
            `[folio-camera] negotiated ${s.width ?? '?'}x${s.height ?? '?'}@${s.frameRate ?? '?'}fps` +
              (s.deviceId ? ` device=${s.deviceId.slice(0, 8)}` : ''),
          );
        }
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
  // A camera switch also resets scan state (fresh worker, no stale jobs).
  // scan.reset is a stable callback; start is the documented trigger.
  const resetScan = scan.reset;
  useEffect(() => {
    resetScan();
    void start(facing, deviceId);
    return () => {
      genRef.current += 1;
      detachEnded();
      stopStream(streamRef.current);
      streamRef.current = null;
      trackRef.current = null;
      resetScan();
      if (focusTimer.current !== null) {
        window.clearTimeout(focusTimer.current);
        focusTimer.current = null;
      }
    };
    // Restart only when the requested source changes — never on capture.
  }, [facing, deviceId, resetScan, start]);

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
    resetScan();
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

  /**
   * Shutter: captures the full-res frame, then either hands it straight
   * to the collection (Original mode — v1.9 path, no worker) or sends it
   * to the scan worker for processing + review.
   */
  const captureFrame = async (): Promise<File | null> => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || capturing) return null;
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
      return new File([blob], name, { type: 'image/jpeg' });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Capture failed.');
      return null;
    } finally {
      setCapturing(false);
    }
  };

  const capture = async () => {
    const file = await captureFrame();
    if (file === null) return;
    if (scan.mode === 'original') {
      onCapture(file);
    } else {
      scan.processCapture(file, scan.mode);
    }
  };

  const acceptReview = (useProcessed: boolean) => {
    const accepted = scan.accept(useProcessed);
    if (accepted === null) return;
    onScanAccept(accepted);
  };

  /**
   * Low-res live tick (~160px, best-effort): guidance only. Skipped
   * while a capture scan or review is active (latest-frame semantics
   * live in the hook); live corners are NEVER reused for the final scan.
   */
  useEffect(() => {
    if (status !== 'live' || scan.mode === 'original') return;
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (
        video === null ||
        video.videoWidth === 0 ||
        scan.processing ||
        scan.pending !== null ||
        document.hidden
      ) {
        return;
      }
      const scale = 160 / Math.max(video.videoWidth, video.videoHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          canvas.width = 0;
          canvas.height = 0;
          if (blob !== null) scan.requestLive(blob);
        },
        'image/jpeg',
        0.7,
      );
    }, 500);
    return () => window.clearInterval(id);
    // Stable primitives only: the scan object identity changes per render.
  }, [status, scan.mode, scan.processing, scan.pending, scan.requestLive]);

  const ratio = aspect.w / aspect.h;

  return (
    <Card>
      {/* CameraTopBar: close | title | view + device controls. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={leave}
          aria-label="Done scanning"
          className="rounded-lg px-2 py-1.5 text-xs font-medium text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-700 min-h-[36px]"
        >
          ‹ Done
        </button>
        <p className="min-w-0 flex-1 text-sm font-medium text-ink-700 dark:text-paper-100">
          Scan document
          {sessionPages.length > 0 && (
            <span className="ml-2 rounded-full bg-forest-500/15 px-2 py-0.5 text-xs text-forest-600 dark:text-forest-300">
              {sessionPages.length} captured
            </span>
          )}
        </p>
        <button
          onClick={() => setGrid((g) => !g)}
          aria-label={grid ? 'Hide alignment grid' : 'Show alignment grid'}
          aria-pressed={grid}
          title="Alignment grid"
          className={`flex h-9 w-9 items-center justify-center rounded-full border transition-colors ${
            grid
              ? 'border-brass-400/50 text-brass-600 dark:text-brass-300'
              : 'border-paper-300 text-ink-500 dark:border-ink-700 dark:text-ink-300'
          }`}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <path d="M4 4h16v16H4zM4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16" />
          </svg>
        </button>
        <button
          onClick={() => {
            setDeviceId('');
            setFacing((f) => (f === 'environment' ? 'user' : 'environment'));
          }}
          aria-label="Switch camera"
          title="Switch camera"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-paper-300 text-ink-500 transition-colors hover:border-brass-400/40 hover:text-ink-900 dark:border-ink-700 dark:text-ink-300 dark:hover:text-paper-100"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </button>
        {devices.length > 1 && (
          <select
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            className="h-9 rounded-lg border border-paper-300 bg-transparent px-2 text-xs text-ink-500 dark:border-ink-700 dark:text-ink-300"
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
          {/* Capture mode: Original bypasses the scan worker (v1.9 direct
              capture); Document/Grayscale/B&W process through it. */}
          <div
            className="mb-3 flex gap-1 rounded-xl border border-paper-300 p-1 dark:border-ink-700"
            role="group"
            aria-label="Capture mode"
          >
            {SCANNER_MODES.map((value) => {
              const label = MODE_LABELS[value];
              return (
                <button
                  key={value}
                  onClick={() => scan.setMode(value)}
                  aria-label={`${label} scan mode`}
                  aria-pressed={scan.mode === value}
                  disabled={scan.processing || scan.pending !== null}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-xs transition-colors disabled:opacity-40 ${
                    scan.mode === value
                      ? 'bg-ink-900 text-paper-50 dark:bg-paper-100 dark:text-ink-900'
                      : 'text-ink-500 hover:bg-paper-200 dark:text-ink-300 dark:hover:bg-ink-700'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
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
              {/* Detection pill: low-res worker verdict, framing aid only —
                  never the final transform geometry. */}
              {scan.mode !== 'original' && (
                <p
                  aria-hidden
                  data-detection-pill
                  className={`pointer-events-none absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full px-3 py-1 text-[11px] ${
                    scan.liveDetected
                      ? 'bg-forest-600/90 font-medium text-white'
                      : 'bg-ink-900/70 text-paper-50'
                  }`}
                >
                  {scan.liveDetected ? 'Document detected ✓' : 'Frame the page in the guide'}
                </p>
              )}
              {scan.processing && (
                <div className="absolute inset-0 flex items-center justify-center bg-ink-950/60">
                  <p className="rounded-full bg-ink-900/85 px-4 py-2 text-sm text-paper-50">
                    Processing scan…
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Screen-reader mirror of the in-viewport detection pill. */}
          {scan.mode !== 'original' && (
            <span className="sr-only" role="status">
              {scan.liveDetected ? 'Document detected — capture when ready' : 'Framing guide'}
            </span>
          )}

          {/* Review: pending scan decision. Session state only — nothing
              enters the page collection until Accept. */}
          {scan.pending !== null && (
            <div className="mt-3 rounded-2xl border border-brass-400/40 bg-paper-50 p-3 dark:bg-ink-800/60">
              <div className="flex gap-3">
                <img
                  src={scan.pending.previewUrl}
                  alt={
                    scan.pending.result.status === 'processed'
                      ? `Processed scan preview: ${scan.pending.original.name}`
                      : `Original capture preview: ${scan.pending.original.name}`
                  }
                  className="h-28 w-20 shrink-0 rounded-lg border border-paper-300 object-contain dark:border-ink-700"
                />
                <div className="min-w-0 flex-1">
                  {scan.pending.result.status === 'processed' && (
                    <p className="text-sm font-medium text-ink-700 dark:text-paper-100">
                      Scan ready — perspective-corrected
                    </p>
                  )}
                  {scan.pending.result.status === 'original' && (
                    <p className="text-sm font-medium text-ink-700 dark:text-paper-100">
                      No reliable document boundary found
                    </p>
                  )}
                  {scan.pending.result.status === 'error' && (
                    <p className="text-sm font-medium text-ink-700 dark:text-paper-100">
                      Scanner unavailable
                    </p>
                  )}
                  <p className="mt-1 text-xs text-ink-400 dark:text-ink-300">
                    {scan.pending.result.status === 'processed' &&
                      'The corrected scan is shown. The original photo is kept for fallback.'}
                    {scan.pending.result.status === 'original' &&
                      'Use the original photo as the page, or retake.'}
                    {scan.pending.result.status === 'error' &&
                      'Use the original photo, or retry the scan.'}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {scan.pending.result.status === 'processed' && (
                  <Button onClick={() => acceptReview(true)}>Use scan</Button>
                )}
                <Button
                  variant={scan.pending.result.status === 'processed' ? 'ghost' : 'primary'}
                  onClick={() => acceptReview(false)}
                >
                  Use original
                </Button>
                {scan.pending.result.status === 'error' && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const current = scan.pending;
                      if (current !== null) scan.processCapture(current.original, scan.mode);
                    }}
                  >
                    Retry
                  </Button>
                )}
                <Button variant="ghost" onClick={() => scan.discard()}>
                  Retake
                </Button>
              </div>
            </div>
          )}

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

          {/* Camera dock: torch · shutter · retake on row one (mobile),
              zoom spans row two; desktop composes one centered cluster
              (torch · wide zoom · shutter · retake). Torch/zoom render
              ONLY when the active track reports them; a rejected apply
              disables the control with a note. Safe-area padded. */}
          <div
            role="group"
            aria-label="Camera controls"
            className="mt-3 grid grid-cols-[auto_1fr_auto] items-center gap-3 pb-[env(safe-area-inset-bottom)] sm:flex sm:justify-center"
          >
            {caps.torch && !torchDead && (
              <button
                onClick={() => void toggleTorch()}
                aria-label={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
                aria-pressed={torchOn}
                title="Flashlight"
                className={`flex h-11 w-11 items-center justify-center rounded-full border transition-colors sm:order-1 ${
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
            <button
              onClick={() => void capture()}
              disabled={capturing || scan.processing || scan.pending !== null}
              aria-label={capturing || scan.processing ? 'Capturing page' : 'Capture page'}
              className="mx-auto flex h-16 w-16 items-center justify-center justify-self-center rounded-full border-4 border-paper-300 bg-paper-100 transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 dark:border-ink-600 dark:bg-ink-800 sm:order-3 sm:mx-2"
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
              className="flex h-11 min-w-11 items-center justify-center justify-self-end rounded-xl border border-paper-300 px-3 text-xs text-ink-500 transition-colors hover:border-brass-400/40 disabled:opacity-30 dark:border-ink-700 dark:text-ink-300 sm:order-4"
            >
              Retake
            </button>
            {caps.zoom !== null && !zoomDead && zoom !== null && (
              <label className="col-span-3 flex h-11 min-w-0 items-center gap-2 rounded-xl border border-paper-300 px-3 dark:border-ink-700 sm:order-2 sm:col-span-1 sm:w-72 sm:flex-none">
                <span className="text-xs text-ink-500 dark:text-ink-300">Zoom</span>
                <input
                  type="range"
                  min={caps.zoom.min}
                  max={caps.zoom.max}
                  step={caps.zoom.step}
                  value={zoom}
                  onChange={(e) => void applyZoom(Number(e.target.value))}
                  aria-label={`Camera zoom, ${zoom.toFixed(1)} times`}
                  aria-valuetext={`${zoom.toFixed(1)} times zoom`}
                  className="min-w-0 flex-1 accent-brass-500"
                />
                <span
                  aria-hidden
                  className="font-mono text-xs text-ink-500 tabular-nums dark:text-ink-300"
                >
                  {zoom.toFixed(1)}×
                </span>
              </label>
            )}
          </div>
          {controlNote !== null && (
            <p role="status" className="mt-2 text-xs text-ink-400 dark:text-ink-300">
              {controlNote}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
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
