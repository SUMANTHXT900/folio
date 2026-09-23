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
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorBlock } from '../components/ui';

type CameraStatus = 'starting' | 'live' | 'failed';

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
  const counterRef = useRef(0);
  const [status, setStatus] = useState<CameraStatus>('starting');
  const [failure, setFailure] = useState<string | null>(null);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [capturing, setCapturing] = useState(false);
  const [grid, setGrid] = useState(false);
  // Real frame aspect (letterboxed, never cropped). Defaults to 4:3
  // until the stream reports dimensions; tracks orientation changes.
  const [aspect, setAspect] = useState({ w: 4, h: 3 });

  const start = useCallback(async (mode: 'environment' | 'user', exactDevice: string) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setFailure(failureMessage(new DOMException('unsupported', 'NotSupportedError')));
      setStatus('failed');
      return;
    }
    stopStream(streamRef.current);
    streamRef.current = null;
    setStatus('starting');
    setFailure(null);
    try {
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: exactDevice ? { deviceId: { exact: exactDevice } } : { facingMode: { ideal: mode } },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      setDevices(all.filter((d) => d.kind === 'videoinput'));
      setStatus('live');
    } catch (error) {
      stopStream(streamRef.current);
      streamRef.current = null;
      setFailure(failureMessage(error));
      setStatus('failed');
    }
  }, []);

  // Open on mount / facing change; stop on unmount.
  useEffect(() => {
    void start(facing, deviceId);
    return () => {
      stopStream(streamRef.current);
      streamRef.current = null;
    };
    // Restart only when the requested source changes — never on capture.
  }, [facing, deviceId]);

  const syncAspect = useCallback(() => {
    const video = videoRef.current;
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      setAspect({ w: video.videoWidth, h: video.videoHeight });
    }
  }, []);

  const leave = () => {
    stopStream(streamRef.current);
    streamRef.current = null;
    onDone();
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

      {status === 'failed' && failure && (
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

      {status !== 'failed' && (
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

          {/* Shutter row: grid toggle, capture, retake. */}
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
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
