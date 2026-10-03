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
 * Capture flow (capture-first, D30): the shutter QUEUES a capture
 * silently (brief background detect, thumb in the session strip) and the
 * camera stays live — NO modal, NO per-capture review, NO crop editor
 * inline under the viewfinder. Every queued capture is reviewed later,
 * one page at a time, in the full-screen review queue
 * (`ScanReviewQueue`), reached via the "Review N pages" CTA; unreviewed
 * entries at any exit commit as originals. The review is RESULT-FIRST
 * (2026-10-03 UX pass): the hero is the cropped preview, "Looks good"
 * commits it in one tap, "Adjust corners" opens the photo + quad editor,
 * and after the last page the end screen builds the PDF right there
 * (`onBuildNow`) instead of walking back to the Images tool.
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
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Button, ErrorBlock } from '../components/ui';
import {
  NO_CAPABILITIES,
  readTrackCapabilities,
  requestContinuousModes,
  type CameraCapabilities,
} from './cameraCapabilities';
import { buildVideoConstraints } from './cameraConstraints';
import {
  encodeBitmapToJpeg,
  EncodeWorkerUnavailableError,
  IMPORT_JPEG_QUALITY,
  isPngFile,
  MAX_IMPORT_LONG_EDGE,
  planNormalization,
} from './imageImport';
import { useContainBox } from './scanViewport';
import { ScanReviewQueue, type CropQuad } from './scan/CropEditor';
import { useScanProcessor, type ScanCommit } from './scan/useScanProcessor';

/** Import state for the scanner's image-picker flow. */
interface ImportState {
  total: number;
  completed: number;
  currentName: string;
}

const IMPORT_ACCEPT = 'image/jpeg,image/png,.jpg,.jpeg,.png';

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
    case 'AbortError':
      // AGENT11 copy (literal, short): interrupted request, actionable retry.
      return 'The camera request was interrupted. Try again, or use the file picker.';
    default:
      return 'The camera could not be started on this browser. Use the file picker to add images instead.';
  }
}

/** True only when the page is provably NOT in a secure context. */
function isInsecureContext(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      (window as unknown as { isSecureContext?: unknown }).isSecureContext === false
    );
  } catch {
    return false;
  }
}

// AGENT11 copy (literal, short): insecure-origin branch for missing/blocked camera.
const INSECURE_CONTEXT_MESSAGE =
  'Camera needs HTTPS or localhost. Use the file picker, or open this page over HTTPS or localhost.';

function stopStream(stream: MediaStream | null) {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
}

/**
 * Capture target dimensions (5-6): the frame is clamped to the shared
 * 2500px import/scan pixel budget ON the capture canvas, before any
 * scan bytes exist. Detection is unaffected (the worker downscales to
 * 800px either way — confidence is identical at both scales in the
 * `scan_bench` comparison). The tradeoff is deliberate and measured
 * (release, synthetic 12MP framing, min of 5):
 *
 * ```text
 * full 12MP input  → out 2435×2322 (5.65 MP), conf 0.82
 * pre-scaled input → out 1522×1451 (2.20 MP), conf 0.81–0.82
 * ```
 *
 * Warp output size follows input quad pixels until the 2500px cap
 * binds, so pre-scaling yields ~2.5× fewer output pixels — still ~10″
 * wide at 150 DPI, inside the project's documented budgets. Wall time
 * is detection-dominated on desktop CPU (color path ≈ unchanged;
 * enhance paths −30%, e.g. 12MP b/w 286ms → 194ms); the reliable wins
 * are memory (one 12MP RGB frame = 36 MB resident → 14 MB), worker
 * transfer bytes, and output JPEG size (157 KB → 65 KB). Absolute
 * browser/WASM wall time needs the device matrix (no E2E here).
 */
export function captureTargetDims(
  videoWidth: number,
  videoHeight: number,
): { width: number; height: number } {
  const target = planNormalization(
    { width: videoWidth, height: videoHeight },
    MAX_IMPORT_LONG_EDGE,
  );
  return target ?? { width: videoWidth, height: videoHeight };
}

/**
 * Fallback auto-accept fast path (5-4): the scan worker already
 * reported the capture's input dimensions (`result.width/height` on
 * `original` results), so the budget decision runs BEFORE any decode.
 * Within-budget JPEGs skip `prepareImportFile` entirely (zero decodes,
 * zero re-encodes — previously one decode + a possible re-encode);
 * PNGs and oversized frames still normalize through the full path.
 */
export function canSkipNormalization(dims: { width: number; height: number }, file: File): boolean {
  return planNormalization(dims, MAX_IMPORT_LONG_EDGE) === null && !isPngFile(file);
}

/**
 * Shutter encode offload (P2 item 11, finding 12): snapshots the live
 * frame and encodes it in the encode worker. Returns null when the
 * worker path is unavailable (or the frame cannot be snapshotted) so
 * the caller falls back to its main-thread canvas path; throws only
 * when the worker consumed the bitmap but failed — the same
 * user-visible outcome as the old `toBlob → null` failure.
 */
async function encodeShutterViaWorker(
  video: HTMLVideoElement,
  width: number,
  height: number,
  flipHorizontal: boolean,
): Promise<Uint8Array | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    if (typeof createImageBitmap !== 'function') return null;
    bitmap = await createImageBitmap(video);
  } catch {
    return null;
  }
  try {
    return await encodeBitmapToJpeg(bitmap, { width, height }, IMPORT_JPEG_QUALITY, flipHorizontal);
  } catch (error) {
    try {
      bitmap.close();
    } catch {
      // Release best-effort (neutered after a transfer).
    }
    if (error instanceof EncodeWorkerUnavailableError) return null;
    throw error;
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
  onScanAccept,
  onImportFiles,
  onRetake,
  onDone,
  onBuildNow,
  sessionPages,
}: {
  /** An accepted scan (processed file + optional original to retain). */
  onScanAccept: (entry: { file: File; original: File | null; name: string }) => void;
  /** Bulk import from the native picker; reports per-file progress. */
  onImportFiles: (
    files: File[],
    progress: (completed: number, total: number, name: string) => void,
    signal: AbortSignal,
  ) => Promise<{ added: number; failed: number; cancelled: boolean; firstError: string | null }>;
  /** Drops the most recent capture of the current session. */
  onRetake: () => void;
  /** Leaves camera mode (stream stopped first). */
  onDone: () => void;
  /** Review end "Build PDF": the parent wiring leaves camera mode. */
  onBuildNow: () => void;
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
  // Shutter-confirmation blink generation: each accepted capture bumps
  // this, remounting a one-shot opacity-only flash over the viewport.
  const [flash, setFlash] = useState(0);
  // Hardware capabilities of the ACTIVE track only — recalculated on
  // every (re)start so switching cameras never shows stale controls.
  const [caps, setCaps] = useState<CameraCapabilities>(NO_CAPABILITIES);
  const [torchOn, setTorchOn] = useState(false);
  const [torchDead, setTorchDead] = useState(false);
  const [controlNote, setControlNote] = useState<string | null>(null);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  // Real frame aspect. Source priority: negotiated track settings
  // (exact, available before first frame) → video element dims →
  // 3:4 fallback. Track settings win because `videoWidth` can lag
  // behind a camera switch while the old frame is still painted.
  const [aspect, setAspect] = useState({ w: 3, h: 4 });

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
  const facingRef = useRef(facing);
  facingRef.current = facing;
  // Detach for the current track-ended listener (B2).
  const endedCleanup = useRef<(() => void) | null>(null);
  const detachEnded = () => {
    endedCleanup.current?.();
    endedCleanup.current = null;
  };
  // Stable scan callbacks, extracted BEFORE `start` (its deps array
  // evaluates at definition — a later declaration would TDZ-crash).
  // A camera switch also resets scan state (fresh worker, no stale jobs).
  const resetScan = scan.reset;
  const warmScan = scan.warm;

  /** Installs the disconnected state: hardware released, caps cleared. */
  const markDisconnected = useCallback((message: string) => {
    detachEnded();
    stopStream(streamRef.current);
    streamRef.current = null;
    trackRef.current = null;
    setCaps(NO_CAPABILITIES);
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
        // `mediaDevices` missing almost always means an insecure origin
        // (plain HTTP): say so explicitly instead of the generic failure.
        setFailure(INSECURE_CONTEXT_MESSAGE);
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
          // Most reliable ratio source: the negotiated frame size itself.
          if (
            typeof s.width === 'number' &&
            typeof s.height === 'number' &&
            s.width > 0 &&
            s.height > 0
          ) {
            setAspect({ w: s.width, h: s.height });
          }
        }
        const detected = readTrackCapabilities(videoTrack);
        setCaps(detected);
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
        // Scan worker warmup (5-5): WASM init now overlaps viewfinder
        // time instead of the first live tick / shutter press. Best
        // effort and generation-guarded inside the hook; every start
        // path (mount, retry, camera switch) reaches this line, and the
        // hook makes repeat calls within a session no-ops.
        warmScan();
      } catch (error) {
        if (!isCurrent()) return;
        detachEnded();
        stopStream(streamRef.current);
        streamRef.current = null;
        trackRef.current = null;
        // Insecure origins fail inside getUserMedia too: prefer the
        // explicit HTTPS/localhost message over the per-error mapping.
        // Secure-context denials keep the existing permission mapping.
        setFailure(isInsecureContext() ? INSECURE_CONTEXT_MESSAGE : failureMessage(error));
        setStatus('failed');
      }
    },
    [markDisconnected, warmScan],
  );

  // Open on mount / facing change; stop + invalidate on unmount.
  // `start` is the documented trigger for both callbacks above.
  // (Declarations live above `start`, q.v.) A camera switch PRESERVES
  // queued captures (`keepQueue`) — flipping to the selfie camera must
  // never drop shots; only in-flight jobs die. The hook's own unmount
  // cleanup revokes whatever is left.
  useEffect(() => {
    resetScan({ keepQueue: true });
    void start(facing, deviceId);
    return () => {
      genRef.current += 1;
      detachEnded();
      stopStream(streamRef.current);
      streamRef.current = null;
      trackRef.current = null;
      resetScan({ keepQueue: true });
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

  // Tab-hidden stream pause (mobile battery/privacy): while the tab is
  // hidden the camera would hold hardware + the OS indicator for
  // nothing. Tracks are DISABLED on hide (no renegotiation, generation
  // untouched — the unmount/leave stop path still owns release) and
  // re-enabled with a preview resume on visible. Failed/disconnected
  // states never restart here.
  useEffect(() => {
    const pauseTracks = () => {
      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) {
          try {
            track.enabled = false;
          } catch {
            // Best-effort: a track without `enabled` stays live.
          }
        }
      }
      try {
        videoRef.current?.pause();
      } catch {
        // Best-effort: preview pause is not correctness-critical.
      }
    };
    const resumeTracks = () => {
      const stream = streamRef.current;
      if (!stream) {
        if (statusRef.current === 'live') void start(facingRef.current, deviceIdRef.current);
        return;
      }
      for (const track of stream.getTracks()) {
        try {
          track.enabled = true;
        } catch {
          // Best-effort (see pauseTracks).
        }
      }
      const video = videoRef.current;
      if (video && statusRef.current === 'live') {
        try {
          const played = video.play();
          if (played && typeof played.catch === 'function') played.catch(() => undefined);
        } catch {
          // A rejected resume keeps the retry path intact; never throws.
        }
      }
    };
    const onVisibility = () => {
      if (document.hidden) pauseTracks();
      else resumeTracks();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', pauseTracks);
    window.addEventListener('pageshow', resumeTracks);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', pauseTracks);
      window.removeEventListener('pageshow', resumeTracks);
    };
  }, [start]);

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
    // Unreviewed captures survive the exit: they commit as originals
    // (the photos were taken — shots are never dropped silently).
    for (const commit of scan.drainQueue()) onScanAccept(commit);
    resetScan();
    onDone();
  };

  // Escape exits the review queue first (unreviewed entries commit as
  // originals), then closes the scanner (same as Back): an obvious,
  // keyboard-accessible exit that never strands the user in a
  // full-screen camera — or in a full-screen queue.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (reviewRef.current !== null) exitReview();
      else leave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leave]);

  // Hard scroll lock while the scanner owns the screen: without it the
  // page behind can still be scrolled (revealing app chrome/nav) even on
  // top of a fixed overlay. Body is pinned at its current offset and
  // restored on exit — the standard mobile-safe modal lock.
  useEffect(() => {
    const scrollY = window.scrollY;
    const body = document.body;
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      if (scrollY !== 0) window.scrollTo(0, scrollY);
    };
  }, []);

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
   * Shutter: captures the frame ALREADY clamped to the 2500px budget
   * (5-6, see `captureTargetDims`), then queues it for the review
   * queue (`useScanProcessor.enqueueCapture`) — the queue entry carries
   * the capture dims as the quad coordinate space.
   *
   * The JPEG encode runs in `imageEncode.worker.ts` (P2 item 11) when
   * available: the frame is snapshotted via `createImageBitmap` (the
   * video keeps playing underneath) and the bitmap is transferred. Any
   * worker failure falls back to the original main-thread canvas path
   * below — the live video element still holds the frame, so the retry
   * re-reads it with identical pixels, quality (q0.95), and mirroring.
   * Both paths encode the BUDGET-CLAMPED size, never full sensor
   * resolution: a 12MP sensor frame becomes a ≤2500px JPEG either way.
   */
  const captureFrame = async (): Promise<{
    file: File;
    width: number;
    height: number;
  } | null> => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || capturing) return null;
    setCapturing(true);
    try {
      const target = captureTargetDims(video.videoWidth, video.videoHeight);
      const { width, height } = target;
      // Front camera: un-mirror so text reads correctly.
      const flipHorizontal = facing === 'user';
      const workerBytes = await encodeShutterViaWorker(video, width, height, flipHorizontal);
      let bytes: Uint8Array | null = workerBytes;
      if (bytes === null) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx === null) throw new Error('2D canvas unavailable for capture.');
        if (flipHorizontal) {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(video, 0, 0, width, height);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', IMPORT_JPEG_QUALITY),
        );
        canvas.width = 0;
        canvas.height = 0;
        if (blob === null) throw new Error('Capture encode failed.');
        bytes = new Uint8Array(await blob.arrayBuffer());
      }
      counterRef.current += 1;
      const name = `scan-${String(counterRef.current).padStart(3, '0')}.jpg`;
      return {
        file: new File([bytes as unknown as BlobPart], name, { type: 'image/jpeg' }),
        width,
        height,
      };
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Capture failed.');
      return null;
    } finally {
      setCapturing(false);
    }
  };

  const capture = async () => {
    const shot = await captureFrame();
    if (shot === null) return;
    setFlash((f) => f + 1);
    // Queued silently: the thumb lands in the session strip once the
    // brief background detect job reports — NO modal, NO review panel,
    // NO crop editor per capture. The camera stays live (rapid-fire
    // shooting is the point).
    scan.enqueueCapture(shot.file, { width: shot.width, height: shot.height });
  };

  // -- Review queue (THE review step) ----------------------------------
  // Every capture queues silently and is reviewed later, ONE page at a
  // time, in the full-screen `ScanReviewQueue`. Result-first (2026-10-03):
  // the hero is the CROPPED preview (requested on page entry), "Looks
  // good" commits the current quad in one tap, "Adjust corners" toggles
  // the photo + quad editor, "Use original" / trash stay one tap away.
  // The queue snapshots the queued ids when opened ("Page i of N" is
  // stable); an entry whose background detect is still running renders
  // "Preparing this page…" and appears automatically once ready (the
  // frozen contract gates `meta` on `state === 'ready'`). After the last
  // page resolves, the end screen builds the PDF directly (`onBuildNow`)
  // or returns to the camera. Back arrow exits the queue with every
  // unreviewed entry committed as an original (transient note).

  const [review, setReview] = useState<{ ids: number[]; index: number } | null>(null);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const queuedEntries = scan.queued;
  const pageCount = sessionPages.length + queuedEntries.length;
  const unreviewedCount = queuedEntries.length;
  // Self-explanatory CTA: unreviewed captures → "Review N pages"
  // (opens the review queue); an empty queue → "View N pages" and the
  // tap falls through to leaving camera mode (`leave` → `onDone`).
  const reviewCtaLabel =
    unreviewedCount > 0
      ? `Review ${unreviewedCount} page${unreviewedCount === 1 ? '' : 's'}`
      : `View ${pageCount} page${pageCount === 1 ? '' : 's'}`;
  // Session strip = committed session pages + queued captures (queue
  // thumbs reuse the entry preview URL — revoked on advance/discard/
  // exit). Newest last, brass ring on the newest.
  const stripPages = [
    ...sessionPages,
    ...queuedEntries.map((e) => ({
      id: `q${e.id}`,
      previewUrl: e.previewUrl,
      name: e.original.name,
    })),
  ];

  const currentEntry =
    review === null ? null : (queuedEntries.find((e) => e.id === review.ids[review.index]) ?? null);
  // Snapshot exhausted → the review end screen (Build PDF shortcut).
  const reviewComplete =
    review !== null && review.ids.length > 0 && review.index >= review.ids.length;
  // `meta` is meaningful ONLY when `state === 'ready'` (frozen contract);
  // until then the queue renders "Preparing this page…" for this entry.
  const currentReady = currentEntry !== null && currentEntry.state === 'ready';
  const entryView =
    currentEntry === null
      ? null
      : {
          id: currentEntry.id,
          ready: currentReady,
          photoUrl: currentEntry.previewUrl,
          imageWidth: currentReady ? (currentEntry.meta?.width ?? 0) : 0,
          imageHeight: currentReady ? (currentEntry.meta?.height ?? 0) : 0,
          initialCorners: currentReady ? (currentEntry.meta?.corners ?? null) : null,
        };

  const openReview = () => {
    if (queuedEntries.length > 0) {
      setReview({ ids: queuedEntries.map((e) => e.id), index: 0 });
    } else {
      leave();
    }
  };

  const advanceReview = () => {
    const r = reviewRef.current;
    if (r === null) return;
    if (r.index + 1 < r.ids.length) {
      setReview({ ids: r.ids, index: r.index + 1 });
    } else {
      // Last page resolved → the end screen: build the PDF here
      // (`onBuildNow`) or return to the camera. Never auto-leave.
      setReview({ ids: r.ids, index: r.ids.length });
    }
  };

  /** Queue back arrow: exit the queue; unreviewed entries commit as originals. */
  const exitReview = () => {
    setReview(null);
    const unreviewed = scan.queued;
    const drained = scan.drainQueue();
    for (const commit of drained) onScanAccept(commit);
    if (unreviewed.length > 0) {
      // Status is only meaningful for ready entries (frozen contract):
      // claim "no boundary found" only when every entry was ready.
      const readyStatuses = unreviewed.flatMap((e) =>
        e.state === 'ready' ? [e.meta?.status ?? null] : [],
      );
      setImportNote(
        readyStatuses.length === unreviewed.length &&
          readyStatuses.every((status) => status === 'original')
          ? 'Added as photo — no boundary found.'
          : 'Added as photo.',
      );
    }
  };

  const handleUseCrop = async (id: number, quad: CropQuad) => {
    const outcome = await scan.useCrop(
      id,
      quad.map((p) => ({ x: p.x, y: p.y })),
    );
    if (outcome === null) return; // Superseded (reset): nothing to commit.
    onScanAccept(outcome.commit);
    if (!outcome.applied) setImportNote("Couldn't apply the crop — added as photo.");
    advanceReview();
  };

  const handleUseOriginal = (id: number) => {
    const commit: ScanCommit | null = scan.useOriginal(id);
    if (commit !== null) onScanAccept(commit);
    advanceReview();
  };

  const handleDiscard = (id: number) => {
    scan.discardEntry(id);
    advanceReview();
  };

  // No auto-close effect on a missing entry: `useCrop`'s entry removal
  // and the advance land in separate React batches, and an effect
  // watching both would run once with the stale pairing ("entry gone,
  // review still on page i"). If the entry under review ever disappears
  // outside the reviewed actions, the surface renders nothing and the
  // next "Review N pages" tap re-snapshots the queue.

  /**
   * Low-res live tick (~320px long edge, best-effort): guidance only.
   * Raised from ~160px (2026-10-03) for a better live hit rate on busy
   * backgrounds — detection downscales internally, so the extra pixels
   * buy recall without changing the 500ms cadence. Skipped while a
   * capture scan or review is active (latest-frame semantics live in the
   * hook); live corners are NEVER reused for the final scan.
   *
   * One canvas is reused for every tick (5-5): the old code allocated +
   * released a canvas per 500ms tick, churning GC while the viewfinder
   * runs. The reused canvas stays at tick size (~320px, ~400 KB —
   * negligible to retain). A `busy` flag skips ticks while the previous
   * `toBlob` is still in flight instead of racing it (a re-sized canvas
   * mid-encode would blank the pending blob) — skipped ticks are pure
   * guidance loss, never correctness loss. All pre-existing guards
   * (processing / pending / hidden-tab) are unchanged.
   */
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveBusyRef = useRef(false);
  useEffect(() => {
    if (status !== 'live') return;
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (video === null || video.videoWidth === 0 || scan.processing || document.hidden) {
        return;
      }
      if (liveBusyRef.current) return; // Previous tick still encoding.
      const scale = 320 / Math.max(video.videoWidth, video.videoHeight);
      const tickWidth = Math.max(1, Math.round(video.videoWidth * scale));
      const tickHeight = Math.max(1, Math.round(video.videoHeight * scale));
      let canvas = liveCanvasRef.current;
      if (canvas === null) {
        canvas = document.createElement('canvas');
        liveCanvasRef.current = canvas;
      }
      // Re-sizing clears the bitmap — intended: a fresh frame is drawn
      // immediately below. Unchanged sizes skip the realloc.
      if (canvas.width !== tickWidth || canvas.height !== tickHeight) {
        canvas.width = tickWidth;
        canvas.height = tickHeight;
      }
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      liveBusyRef.current = true;
      canvas.toBlob(
        (blob) => {
          liveBusyRef.current = false;
          if (blob !== null) scan.requestLive(blob);
        },
        'image/jpeg',
        0.7,
      );
    }, 500);
    return () => window.clearInterval(id);
    // Stable primitives only: the scan object identity changes per render.
  }, [status, scan.processing, scan.requestLive]);

  const ratio = aspect.w / aspect.h;
  const viewport = useContainBox<HTMLDivElement>(ratio);

  // -- Import (native picker; pages commit one at a time) ---------------

  const [importState, setImportState] = useState<ImportState | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importAbortRef = useRef<AbortController | null>(null);

  // Import notes are transient confirmations over the viewport (not
  // layout): auto-dismiss so a stale pill never covers the framing
  // area. E2E reads the note immediately after accept — well inside
  // the window on a local worker.
  useEffect(() => {
    if (importNote === null) return;
    const id = window.setTimeout(() => setImportNote(null), 5000);
    return () => window.clearTimeout(id);
  }, [importNote]);

  const runImport = async (files: File[]) => {
    if (files.length === 0) return;
    const controller = new AbortController();
    importAbortRef.current = controller;
    setImportNote(null);
    setImportState({ total: files.length, completed: 0, currentName: '' });
    try {
      const summary = await onImportFiles(
        files,
        (completed, total, name) => setImportState({ total, completed, currentName: name }),
        controller.signal,
      );
      if (summary.cancelled) {
        setImportNote(`Import cancelled — kept ${summary.added} prepared image(s).`);
      } else if (summary.failed > 0) {
        setImportNote(
          summary.firstError !== null
            ? `Couldn't import ${summary.failed} image(s). First: ${summary.firstError}`
            : `Couldn't import ${summary.failed} image(s).`,
        );
      } else if (summary.added === 0) {
        setImportNote('No usable images were selected.');
      }
    } finally {
      importAbortRef.current = null;
      setImportState(null);
    }
  };

  const cancelImport = () => {
    importAbortRef.current?.abort();
  };

  return createPortal(
    <>
      {/* Desktop backdrop: dims the tool page behind the centered panel
          (mobile is full-bleed, so no backdrop is needed there). */}
      <div aria-hidden className="fixed inset-0 z-[55] hidden bg-ink-950/45 md:block" />
      <div
        data-scanner-root
        className={
          // Immersive surface: full-bleed on phones (covers app chrome),
          // centered bounded panel on desktop. Rendered via portal
          // (document.body) so `fixed` is viewport-true — an inline element
          // inside the route-transition transform would size to that
          // ancestor instead of the screen.
          'fixed inset-0 z-[60] flex flex-col overscroll-contain bg-paper-50 dark:bg-ink-950 ' +
          'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ' +
          'md:inset-auto md:left-1/2 md:top-1/2 md:h-[min(85vh,52rem)] md:w-[46rem] md:max-w-[94vw] ' +
          'md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:border-paper-300 ' +
          'md:pt-0 md:pb-0 md:shadow-2xl dark:md:border-ink-700'
        }
      >
        {/* CameraTopBar: back | title | import | grid | switch | device.
          Single row, never wraps: after the first capture the "Review
          N pages" CTA appears here, and a wrapping bar would steal ~44px
          from the viewfinder (real-phone report). The title truncates
          instead, and the bar scrolls horizontally on very narrow screens
          so every 44px target stays reachable without reflowing the
          viewfinder below. */}
        <div className="flex items-center gap-2 overflow-x-auto border-b border-paper-300/70 px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden dark:border-ink-800/70">
          <button
            onClick={leave}
            aria-label="Back to pages"
            title="Back to page list"
            className="flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-700"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Back
          </button>
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink-700 dark:text-paper-100">
            <span className="hidden min-[430px]:inline">Scan document</span>
            {pageCount > 0 && (
              <span className="rounded-full bg-forest-500/15 px-2 py-0.5 text-xs text-forest-600 dark:text-forest-300 min-[430px]:ml-2">
                {pageCount} captured
              </span>
            )}
          </p>
          {/* Import lives in the scanner bar: no scrolling to reach it. */}
          <input
            ref={importInputRef}
            type="file"
            accept={IMPORT_ACCEPT}
            multiple
            className="hidden"
            data-import-input
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void runImport(files);
            }}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={importState !== null}
            aria-label="Import images from files"
            className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg border border-paper-300 px-2.5 py-1.5 text-xs font-medium text-ink-600 transition-colors hover:border-brass-400/40 hover:text-ink-900 disabled:opacity-40 dark:border-ink-700 dark:text-ink-200 dark:hover:text-paper-100"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span className="hidden min-[400px]:inline">Import</span>
          </button>
          {/* Primary CTA once pages exist: with unreviewed captures it
              reads "Review N pages" and opens the one-page-at-a-time
              review queue; with an empty queue it reads "View N pages"
              and exits straight to the page-collection view (`onDone`). */}
          {pageCount > 0 && (
            <button
              onClick={openReview}
              data-review-cta
              aria-label={reviewCtaLabel}
              className="flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg bg-brass-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-brass-400 dark:bg-brass-400 dark:text-ink-900 dark:hover:bg-brass-300"
            >
              {reviewCtaLabel}
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          )}
          <button
            onClick={() => setGrid((g) => !g)}
            aria-label={grid ? 'Hide alignment grid' : 'Show alignment grid'}
            aria-pressed={grid}
            title="Alignment grid"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors ${
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
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-paper-300 text-ink-500 transition-colors hover:border-brass-400/40 hover:text-ink-900 dark:border-ink-700 dark:text-ink-300 dark:hover:text-paper-100"
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
          {/* Device picker lives at the bottom (with the focus hint), not
            in the top bar: on multi-camera phones a full select would
            force the bar onto two rows and shrink the viewfinder. */}
        </div>

        {/* Import progress: always visible (camera live OR failed), so the
          import path works even without a working camera. */}
        {importState !== null && (
          <div
            role="status"
            data-import-progress
            className="flex items-center gap-3 border-b border-paper-300/70 bg-brass-400/10 px-3 py-2 dark:border-ink-800/70"
          >
            <p className="min-w-0 flex-1 truncate text-xs text-ink-700 dark:text-paper-100">
              Preparing images… {importState.completed} of {importState.total}
              {importState.currentName ? ` · ${importState.currentName}` : ''}
            </p>
            <button
              onClick={cancelImport}
              className="rounded-lg border border-paper-300 px-2.5 py-1 text-[11px] font-medium text-ink-600 transition-colors hover:border-brass-400/40 dark:border-ink-700 dark:text-ink-200"
              aria-label="Cancel import"
            >
              Cancel
            </button>
          </div>
        )}
        {status === 'starting' && (
          <div className="flex aspect-[4/3] items-center justify-center rounded-xl bg-paper-200/60 dark:bg-ink-900/60">
            <p className="text-sm text-ink-400 dark:text-ink-300">Starting camera…</p>
          </div>
        )}

        {(status === 'failed' || status === 'disconnected' || status === 'preview-blocked') &&
          failure && (
            <div className="space-y-3 px-3 py-2">
              {importNote !== null && importState === null && (
                <p role="status" className="text-xs text-ink-400 dark:text-ink-300">
                  {importNote}
                </p>
              )}
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
          <div
            className={
              (status === 'starting' ? 'hidden ' : '') +
              // Landscape-compact (AGENT11, layout only): short-height
              // landscape phones give the viewfinder priority — tighter
              // gaps/padding, no behavior change.
              'relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2 landscape:gap-1 landscape:py-1'
            }
          >
            {/* Import note: floating pill over the viewport top, never an
              in-flow strip — a strip would push the viewport up after
              every capture (real-phone report). Auto-dismissed. */}
            <AnimatePresence>
              {importNote !== null && importState === null && (
                <motion.p
                  role="status"
                  data-import-note
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="pointer-events-none absolute inset-x-0 top-3 z-10 mx-auto w-fit max-w-[90%] rounded-full bg-ink-900/85 px-3 py-1 text-center text-[11px] text-paper-50 dark:bg-paper-100 dark:text-ink-900"
                >
                  {importNote}
                </motion.p>
              )}
            </AnimatePresence>
            {/* Viewport: the wrapper flexes to leftover space; the content
              box is MEASURED (see scanViewport.ts) so video and overlay
              always share the exact painted rect — zero letterbox bars by
              construction, guide always registered. Shrinks instead of
              pushing content off-screen when the strip/review appear. */}
            <div
              ref={viewport.ref}
              className="flex min-h-[12rem] flex-1 items-center justify-center landscape:min-h-[8rem]"
            >
              <div
                className="relative overflow-hidden rounded-xl bg-ink-950"
                style={
                  viewport.rect === null
                    ? { width: '100%', aspectRatio: `${aspect.w} / ${aspect.h}` }
                    : {
                        width: `${viewport.rect.w}px`,
                        height: `${viewport.rect.h}px`,
                      }
                }
                onClick={tapToFocus}
              >
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  autoPlay
                  onLoadedMetadata={syncAspect}
                  onResize={syncAspect}
                  className="absolute inset-0 h-full w-full"
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
                  never the final transform geometry. Mount is a 150ms
                  opacity-only fade; verdict swaps stay instant (no
                  continuous guide animation — battery). */}
                <motion.p
                  aria-hidden
                  data-detection-pill
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.15 }}
                  className={`pointer-events-none absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full px-3 py-1 text-[11px] ${
                    scan.liveDetected
                      ? 'bg-forest-600/90 font-medium text-white'
                      : 'bg-ink-900/70 text-paper-50'
                  }`}
                >
                  {scan.liveDetected
                    ? 'Document detected — capture when ready'
                    : 'Fit page inside guide, leave a small margin'}
                </motion.p>
                {/* Shutter-confirmation blink: one-shot opacity-only flash,
                  remounted per capture via `flash`. No geometry, no loop. */}
                {flash > 0 && (
                  <motion.span
                    key={flash}
                    aria-hidden
                    initial={{ opacity: 0.45 }}
                    animate={{ opacity: 0 }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="pointer-events-none absolute inset-0 bg-white"
                  />
                )}
                <AnimatePresence>
                  {scan.processing && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="absolute inset-0 flex items-center justify-center bg-ink-950/60"
                    >
                      <p className="rounded-full bg-ink-900/85 px-4 py-2 text-sm text-paper-50">
                        Processing scan…
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* Screen-reader mirror of the in-viewport detection pill. */}
            <span className="sr-only" role="status">
              {scan.liveDetected
                ? 'Document detected — capture when ready'
                : 'Fit page inside guide, leave a small margin'}
            </span>

            {/* Camera dock: three equal cells (torch · Capture · Undo) so the
              shutter sits truly centered. Torch renders ONLY when the active
              track reports it; a rejected apply disables the control with a
              note. Safe-area padded. (Zoom control removed — see BUGS F-11.) */}
            <div
              role="group"
              aria-label="Camera controls"
              className="mt-3 grid grid-cols-3 items-center gap-2 landscape:mt-1 landscape:gap-1 sm:flex sm:justify-center sm:gap-5"
            >
              <div className="flex justify-start sm:order-1">
                {caps.torch && !torchDead && (
                  <button
                    onClick={() => void toggleTorch()}
                    aria-label={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
                    aria-pressed={torchOn}
                    title="Flashlight"
                    className={`flex h-11 w-11 items-center justify-center rounded-full border transition-colors ${
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
              </div>
              <div className="flex flex-col items-center gap-1 sm:order-3 sm:mx-3">
                <button
                  onClick={() => void capture()}
                  disabled={capturing}
                  aria-label={capturing ? 'Capturing page' : 'Capture page'}
                  className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-paper-300 bg-paper-100 transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 dark:border-ink-600 dark:bg-ink-800"
                >
                  <span
                    aria-hidden
                    className={`h-10 w-10 rounded-full transition-colors ${
                      capturing ? 'bg-brass-400' : 'bg-brass-500'
                    }`}
                  />
                </button>
                <span className="text-[11px] font-medium text-ink-500 dark:text-ink-300">
                  Capture
                </span>
                {/* Steadiness hint (H-D research): the shutter has no
                  sharpness gate, so say what helps — hold the phone
                  still, then shoot. */}
                <span className="text-[11px] text-ink-400 dark:text-ink-300">Hold steady</span>
              </div>
              <div className="flex justify-end sm:order-4">
                <button
                  onClick={() => {
                    // Undo the LAST capture: a queued shot drops from the
                    // queue (never committed); otherwise the last
                    // committed session page.
                    const last = scan.queued[scan.queued.length - 1];
                    if (last !== undefined) scan.discardEntry(last.id);
                    else onRetake();
                  }}
                  disabled={sessionPages.length === 0 && scan.queued.length === 0}
                  aria-label="Undo last capture"
                  title="Discard the last capture"
                  className="flex h-11 min-w-11 items-center justify-center rounded-xl border border-paper-300 px-3 text-xs text-ink-500 transition-colors hover:border-brass-400/40 disabled:opacity-30 dark:border-ink-700 dark:text-ink-300"
                >
                  Undo
                </button>
              </div>
            </div>
            {controlNote !== null && (
              <p role="status" className="mt-2 text-xs text-ink-400 dark:text-ink-300">
                {controlNote}
              </p>
            )}

            {/* Session strip: previews only, newest last with a brass ring.
              Shows committed session pages AND queued captures (a queued
              shot is visible the moment its brief detect job lands).
              Lives at the very bottom (below the dock) with horizontal
              scroll only, so captured pages never squeeze the viewport.
              Compact cells + no extra safe-area padding (the root already
              carries it) keep the viewport stable once pages exist. */}
            {stripPages.length > 0 && (
              <div
                className="flex gap-1.5 overflow-x-auto landscape:gap-1"
                aria-label="Pages captured this session"
              >
                {stripPages.map((thumb, i) => (
                  <div
                    key={thumb.id}
                    className={`relative h-12 w-9 shrink-0 overflow-hidden rounded-lg border bg-ink-950 sm:h-16 sm:w-12 ${
                      i === stripPages.length - 1
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

            {(caps.supportsTapToFocus || devices.length > 1) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                {caps.supportsTapToFocus && (
                  <span className="text-xs text-ink-400 dark:text-ink-300">
                    Tap the preview to refocus.
                  </span>
                )}
                {devices.length > 1 && (
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="shrink-0 text-xs text-ink-400 dark:text-ink-300">Camera</span>
                    <select
                      value={deviceId}
                      onChange={(e) => setDeviceId(e.target.value)}
                      className="h-9 min-w-0 flex-1 rounded-lg border border-paper-300 bg-transparent px-2 text-xs text-ink-500 dark:border-ink-700 dark:text-ink-300"
                      aria-label="Choose camera"
                    >
                      <option value="">Auto</option>
                      {devices.map((d, i) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Camera ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {/* Review queue: the review step, full-screen and one page at a
        time. The surface portals itself to document.body (viewport-true,
        ABOVE the scanner root) and is never wrapped in AnimatePresence
        (known codebase footgun — it swallows direct portal children).
        `reviewComplete` keeps the surface up for the Build PDF end
        screen after the last page resolves. */}
      {review !== null && (currentEntry !== null || reviewComplete) && (
        <ScanReviewQueue
          pageIndex={Math.min(review.index + 1, review.ids.length)}
          pageCount={review.ids.length}
          entry={entryView}
          complete={reviewComplete}
          cropPreviewUrl={scan.cropPreviewUrl}
          cropPreviewPending={scan.cropPreviewPending}
          applying={scan.applying}
          onPreviewRequest={(quad) => {
            if (currentEntry !== null) scan.requestCropPreview(currentEntry.id, quad);
          }}
          onUseCrop={(quad) => {
            if (currentEntry !== null) void handleUseCrop(currentEntry.id, quad);
          }}
          onUseOriginal={() => {
            if (currentEntry !== null) handleUseOriginal(currentEntry.id);
          }}
          onDiscard={() => {
            if (currentEntry !== null) handleDiscard(currentEntry.id);
          }}
          onBack={exitReview}
          onBuildNow={onBuildNow}
        />
      )}
    </>,
    document.body,
  );
}
