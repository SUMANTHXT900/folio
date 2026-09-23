/**
 * Camera capture — an INPUT SOURCE for the Images → PDF page collection,
 * not a separate pipeline. Captures become `File`s entering the same
 * `useImagePages` collection as uploads (source: 'camera').
 *
 * Lifecycle: one `MediaStream` per session, opened on mount, stopped on
 * Done/close/unmount. No frames retained — only captured Files.
 * Camera is optional: every failure explains itself and leaves the
 * file-upload path fully working.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorBlock } from '../components/ui';

type CameraStatus = 'starting' | 'live' | 'failed';

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

export function CameraCapture({
  onCapture,
  onRetake,
  onDone,
  capturedCount,
}: {
  /** A captured page (caller adds it to the shared collection). */
  onCapture: (file: File) => void;
  /** Drops the most recent capture of this session. */
  onRetake: () => void;
  /** Leaves camera mode (stream stopped first). */
  onDone: () => void;
  /** Captures taken this session (display only). */
  capturedCount: number;
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

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-ink-700 dark:text-paper-100">
          Scan with camera
          {capturedCount > 0 && (
            <span className="ml-2 rounded-full bg-forest-500/15 px-2 py-0.5 text-xs text-forest-600 dark:text-forest-300">
              {capturedCount} captured
            </span>
          )}
        </p>
        <button
          onClick={leave}
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
          <div className="overflow-hidden rounded-xl bg-ink-950">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="aspect-[4/3] w-full object-cover"
              style={facing === 'user' ? { transform: 'scaleX(-1)' } : undefined}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={() => void capture()} disabled={capturing} className="flex-1">
              {capturing ? 'Capturing…' : 'Capture page'}
            </Button>
            <Button variant="ghost" onClick={onRetake} disabled={capturedCount === 0}>
              Retake
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <button
              onClick={() => {
                setDeviceId('');
                setFacing((f) => (f === 'environment' ? 'user' : 'environment'));
              }}
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
              Captures join the same page list below.
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
