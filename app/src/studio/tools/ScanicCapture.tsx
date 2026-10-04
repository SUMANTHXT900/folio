/**
 * ScanicCapture — camera session + result-FIRST review queue for document scanning.
 *
 * Full-screen takeover: the scanner root is portaled to `document.body` as a
 * `fixed inset-0 z-50` surface (Folio paper/ink theme) with body scroll-lock
 * while mounted. The camera phase leads with a full-bleed viewfinder — no
 * scroll needed to find it. The portal is NEVER wrapped in AnimatePresence.
 *
 * Detection is ML-first (self-hosted same-origin assets under
 * `public/assets/scanic-ml/`), classical only as an honest fallback when the
 * ML detector throws. Corner *types* come from the worker agent's barrel
 * (`./scan/index`), the single source of truth; the queue runtime here is
 * intentionally inline (main-thread `scanDocument`/`extractDocument` per
 * capture) so the review UI works standalone — swapping the internals onto
 * `useScanicProcessor` later must keep the DOM contract below byte-for-byte.
 *
 * Preview vs detection: the <video> preview pixels are NEVER the detection
 * input — detection runs on the captured still through scanic's own internal
 * downscale (`scanDocument` scales to detection size itself). Preview
 * resolution (up to 1080p) only affects what the user sees.
 *
 * Mirror invariant: the front-camera preview is CSS-mirrored (`scaleX(-1)`,
 * industry standard) for a natural selfie feel, but captured frames are
 * ALWAYS unmirrored — `canvas drawImage(video)` reads raw camera pixels,
 * never the CSS transform. The back camera is never mirrored.
 *
 * E2E DATA CONTRACT (do not rename):
 * - root `[data-scanner-root]` (+ `data-detector="ml"`), shutter
 *   `[data-scan-capture]` (rendered only when live), queue
 *   `[data-scan-queue]` with header `Page i of N`, result
 *   `[data-crop-result]` + `[data-crop-result-img]`, handles
 *   `[data-crop-handle="tl|tr|br|bl"]` (role=slider, arrow-key
 *   steppable via scanic's keyboard mode), review CTA `[data-review-cta]`
 *   (`Review N pages` / `View N pages`), progress `[data-review-progress]`
 *   (aria-label `i of N reviewed`), finder `[data-finder-frame]` +
 *   `[data-finder-status]`, mirror `[data-mirror-toggle]` (aria-pressed).
 * - Queue button labels are EXACT: "Looks good", "Adjust corners", "Apply",
 *   "Use original", "Discard", "Reset to auto", "Build PDF",
 *   "Back to camera", "Re-detect".
 *
 * Binary ownership: originals live as File handles in refs/state (never
 * re-encoded, never base64); only object-URL strings enter React state, and
 * every URL is revoked on discard/commit/unmount. Warped commits are full-res
 * PNGs from `extractDocument(..., { output: 'canvas' })`.
 *
 * Corner adjust lives in `./ScanicReview` (dependency-free handles on the
 * overlay coordinate space, same E2E labels + 44px targets); this file owns
 * queue/camera/commit only and re-warps on every Apply so previews stay
 * reactive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { extractDocument, scanDocument } from 'scanic';
import type { ScanicCorners } from './scan/index';
import {
  DEFAULT_DETECTOR,
  ML_ASSET_BASE_URL as POLICY_ML_ASSET_BASE_URL,
} from './scan/detectorPolicy';
import ScanicReview from './ScanicReview';

/** Self-hosted (same-origin) ML detector assets — ML is the default (re-exported policy value; kept here for test compat). */
export const SCANIC_ML_ASSET_BASE_URL = POLICY_ML_ASSET_BASE_URL;

/** E2E short keys for the four corner handles. */
export const SCANIC_HANDLE_KEYS = ['tl', 'tr', 'br', 'bl'] as const;
export type ScanicHandleKey = (typeof SCANIC_HANDLE_KEYS)[number];

/** `scan-NNN.jpg` collection names (capture order; engine sniffs magic bytes). */
export function formatScanName(index: number): string {
  return `scan-${String(index + 1).padStart(3, '0')}.jpg`;
}

export interface ScanicCommittedPage {
  file: File;
  name: string;
}

export interface ScanicCaptureProps {
  /** Receives accepted pages in capture order (warped PNG or original File). */
  onCommit: (pages: ScanicCommittedPage[]) => void;
  /** Leaves the scanner without committing (Back in ImagesTool). */
  onExit: () => void;
  /** Offset for `scan-NNN.jpg` numbering (existing camera pages). */
  startIndex?: number;
}

type CameraState = 'requesting' | 'live' | 'denied' | 'unavailable' | 'insecure';
type Phase = 'camera' | 'review' | 'done';

interface QueueEntry {
  id: number;
  original: File;
  photoUrl: string;
  imageWidth: number;
  imageHeight: number;
  /** Detection baseline in image-space pixels; null while detecting/failed. */
  corners: ScanicCorners | null;
  warpedUrl: string | null;
  status: 'detecting' | 'ready';
  decision: 'pending' | 'warped' | 'original';
  note: string | null;
}

function fullFrameCorners(w: number, h: number): ScanicCorners {
  return {
    topLeft: { x: 0, y: 0 },
    topRight: { x: w, y: 0 },
    bottomRight: { x: w, y: h },
    bottomLeft: { x: 0, y: h },
  };
}

/** Loads an <img> for scanic; resolves unloaded on watchdog so jsdom never hangs. */
function loadImage(
  url: string,
  timeoutMs = 8000,
): Promise<{ el: HTMLImageElement; w: number; h: number }> {
  return new Promise((resolve) => {
    const el = new Image();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve({ el, w: el.naturalWidth || el.width || 0, h: el.naturalHeight || el.height || 0 });
    };
    const timer = window.setTimeout(done, timeoutMs);
    el.onload = () => {
      window.clearTimeout(timer);
      done();
    };
    el.onerror = () => {
      window.clearTimeout(timer);
      done();
    };
    el.src = url;
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      if (typeof canvas.toBlob !== 'function') {
        resolve(null);
        return;
      }
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/* ScanicCapture                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* ScanicCapture                                                       */
/* ------------------------------------------------------------------ */

export default function ScanicCapture({ onCommit, onExit, startIndex = 0 }: ScanicCaptureProps) {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [phase, setPhase] = useState<Phase>('camera');
  const [reviewIndex, setReviewIndex] = useState(0);
  const [camState, setCamState] = useState<CameraState>('requesting');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [mirrored, setMirrored] = useState(true);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [paused, setPaused] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [redetecting, setRedetecting] = useState(false);
  /** Single-flight warp guard (the review child has no busy prop). */
  const warpingRef = useRef(false);

  const idRef = useRef(0);
  const entriesRef = useRef<QueueEntry[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const imageElsRef = useRef(new Map<number, HTMLImageElement>());
  const warpedBlobsRef = useRef(new Map<number, Blob>());
  const objectUrlsRef = useRef(new Set<string>());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    };
  }, []);

  // Full-screen takeover: lock body scroll while the scanner is mounted so
  // the in-page document never scrolls behind the fixed surface.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Ref mirror: decisions schedule phase transitions AFTER setEntries, so the
  // updaters themselves stay pure (StrictMode double-invokes updaters).
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const trackUrl = useCallback((url: string): string => {
    objectUrlsRef.current.add(url);
    return url;
  }, []);
  const revokeUrl = useCallback((url: string | null) => {
    if (url !== null && objectUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
  }, []);

  /* Queue derived state: discarded entries leave the queue immediately. */
  const queue = entries;
  const pendingCount = queue.filter((e) => e.decision === 'pending').length;
  const reviewedCount = queue.length - pendingCount;
  const accepted = queue.filter((e) => e.decision !== 'pending');
  const safeIndex = queue.length === 0 ? 0 : Math.min(reviewIndex, queue.length - 1);
  const current = queue[safeIndex] ?? null;
  // Front-camera preview is mirrored by default (industry standard); the back
  // camera is never mirrored. Captured frames ignore this entirely (see
  // captureFrame: drawImage reads raw pixels, not the CSS transform).
  const previewMirrored = facing === 'user' && mirrored;

  /* ---------------- detection (ML default, classical fallback) ---------------- */

  const detectEntry = useCallback(async (id: number, photoUrl: string) => {
    const { el, w, h } = await loadImage(photoUrl);
    if (!mountedRef.current) return;
    if (w === 0 || h === 0) {
      imageElsRef.current.set(id, el);
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                ...e,
                imageWidth: 0,
                imageHeight: 0,
                status: 'ready' as const,
                note: 'Could not decode this image — the full frame will be used.',
              }
            : e,
        ),
      );
      return;
    }
    imageElsRef.current.set(id, el);
    setEntries((prev) =>
      prev.map((e) =>
        e.id === id
          ? { ...e, imageWidth: w, imageHeight: h, note: 'Loading on-device ML detector…' }
          : e,
      ),
    );
    try {
      // ML-first: DocCornerNet via vendored same-origin assets. Preview pixels
      // are never the detection input — scanic downscales internally, so the
      // high-res viewfinder only affects what the user sees.
      // Null-means-missed (not just throws): when ML succeeds but finds no
      // quad, classical gets one attempt — it sees different features and
      // regularly catches what ML passes over (and vice versa). Only when
      // BOTH find nothing does the page settle croppable full-frame.
      const result = await scanDocument(el, {
        detector: DEFAULT_DETECTOR,
        ml: { assetBaseUrl: SCANIC_ML_ASSET_BASE_URL },
      });
      if (!mountedRef.current) return;
      if (result.corners !== null) {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === id
              ? { ...e, status: 'ready' as const, corners: result.corners, note: null }
              : e,
          ),
        );
        return;
      }
      const second = await scanDocument(el, { detector: 'classical' });
      if (!mountedRef.current) return;
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                ...e,
                status: 'ready' as const,
                corners: second.corners,
                note:
                  second.corners === null
                    ? 'Auto-detect found no page — the full frame will be used. Adjust corners to crop manually.'
                    : 'ML found no page — classical detection placed this outline; adjust freely.',
              }
            : e,
        ),
      );
    } catch {
      // ML can fail (model fetch, ORT runtime); fall back to classical once,
      // honestly labelled. Classical failure degrades to full-frame.
      if (!mountedRef.current) return;
      try {
        const fallback = await scanDocument(el, { detector: 'classical' });
        if (!mountedRef.current) return;
        setEntries((prev) =>
          prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  status: 'ready' as const,
                  corners: fallback.corners,
                  note: 'ML detector unavailable — used on-device classical detection instead.',
                }
              : e,
          ),
        );
        return;
      } catch {
        if (!mountedRef.current) return;
      }
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                ...e,
                status: 'ready' as const,
                corners: null,
                note: 'Auto-detect failed on this image — the full frame will be used.',
              }
            : e,
        ),
      );
    }
  }, []);

  /**
   * Enqueues an untouched original File for detection. Returns the queue
   * position (worker-hook seam: same name, same shape as `./scan/index`).
   */
  const enqueueCapture = useCallback(
    (file: File): number => {
      const id = idRef.current + 1;
      idRef.current = id;
      let photoUrl = '';
      try {
        photoUrl = trackUrl(URL.createObjectURL(file));
      } catch {
        photoUrl = '';
      }
      const position = entriesRef.current.length;
      const next = [
        ...entriesRef.current,
        {
          id,
          original: file,
          photoUrl,
          imageWidth: 0,
          imageHeight: 0,
          corners: null,
          warpedUrl: null,
          status: 'detecting' as const,
          decision: 'pending' as const,
          note: null,
        },
      ];
      entriesRef.current = next;
      setEntries(next);
      void detectEntry(id, photoUrl);
      return position;
    },
    [detectEntry, trackUrl],
  );

  const redetectEntry = useCallback(
    async (entry: QueueEntry) => {
      setRedetecting(true);
      setCardError(null);
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id
            ? { ...e, status: 'detecting' as const, note: 'Re-running on-device ML detection…' }
            : e,
        ),
      );
      try {
        await detectEntry(entry.id, entry.photoUrl);
      } finally {
        if (mountedRef.current) setRedetecting(false);
      }
    },
    [detectEntry],
  );

  /* ---------------- camera session ---------------- */

  const stopTracks = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    if (phase !== 'camera' || paused) return;
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setCamState('insecure');
      return;
    }
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setCamState('unavailable');
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    setCamState('requesting');
    (async () => {
      try {
        const front = facing === 'user';
        stream = await navigator.mediaDevices.getUserMedia({
          video: front
            ? {
                facingMode: { ideal: facing },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              }
            : {
                facingMode: { ideal: facing },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
              },
          audio: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          try {
            await video.play();
          } catch {
            // Autoplay policy: the user taps the shutter; play resumes then.
          }
        }
        const track = stream.getVideoTracks()[0];
        // Continuous focus effort where available — silent no-op otherwise.
        try {
          await track?.applyConstraints({
            advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
          });
        } catch {
          // Unsupported on this browser/device — fixed focus still scans.
        }
        let supportsTorch = false;
        try {
          const caps = track?.getCapabilities?.() as
            (MediaTrackCapabilities & { torch?: boolean }) | undefined;
          supportsTorch = caps?.torch === true;
        } catch {
          supportsTorch = false;
        }
        if (!cancelled) {
          setTorchSupported(supportsTorch);
          setTorchOn(false);
          setCamState('live');
        }
      } catch (e) {
        if (cancelled) return;
        const name = e instanceof DOMException ? e.name : e instanceof Error ? e.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') setCamState('denied');
        else setCamState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        if (streamRef.current === stream) streamRef.current = null;
      }
    };
  }, [phase, facing, paused, retryNonce]);

  // Leaving the camera view (review/done) releases the camera; returning resumes.
  useEffect(() => {
    if (phase !== 'camera') {
      stopTracks();
      setTorchOn(false);
    }
  }, [phase, stopTracks]);

  // Tab-hidden pause: stop tracks while hidden, resume on visible.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (document.hidden) {
        stopTracks();
        setPaused(true);
      } else {
        setPaused(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [stopTracks]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  }, [torchOn]);

  const captureFrame = useCallback(async () => {
    const video = videoRef.current;
    setCaptureError(null);
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setCaptureError('Camera is not ready yet — wait for the preview, then try again.');
      return;
    }
    try {
      await video.play().catch(() => undefined);
    } catch {
      // Play failure still leaves the last frame drawable in most browsers.
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setCaptureError('Could not read a camera frame on this browser — add an image file instead.');
      return;
    }
    // Unmirrored invariant: drawImage reads raw camera pixels, never the CSS
    // `scaleX(-1)` preview transform — captures are always true-to-scene.
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        if (typeof canvas.toBlob !== 'function') {
          resolve(null);
          return;
        }
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92);
      } catch {
        resolve(null);
      }
    });
    if (!mountedRef.current) return;
    if (!blob) {
      setCaptureError('Could not capture a frame — try again or add an image file instead.');
      return;
    }
    // Untouched original from here on: the queue never re-encodes it.
    const file = new File([blob], `capture-${idRef.current + 1}.jpg`, { type: 'image/jpeg' });
    enqueueCapture(file);
  }, [enqueueCapture]);

  const addFilesInstead = useCallback(
    (files: File[]) => {
      const images = files.filter(
        (f) => f.type === 'image/jpeg' || f.type === 'image/png' || /\.(jpe?g|png)$/i.test(f.name),
      );
      for (const file of images) enqueueCapture(file);
    },
    [enqueueCapture],
  );

  /* ---------------- review decisions ---------------- */

  const goToReview = useCallback(
    (index?: number) => {
      const firstPending = queue.findIndex((e) => e.decision === 'pending');
      setReviewIndex(index ?? (firstPending >= 0 ? firstPending : 0));
      setPhase('review');
    },
    [queue],
  );

  const advanceAfterDecision = useCallback((decidedId: number, nextQueue: QueueEntry[]) => {
    const remaining = nextQueue.filter((e) => e.decision === 'pending');
    if (remaining.length === 0) {
      setPhase(nextQueue.length === 0 ? 'camera' : 'done');
      return;
    }
    const at = nextQueue.findIndex((e) => e.id === decidedId);
    const after = nextQueue.slice(at + 1).find((e) => e.decision === 'pending');
    const before = nextQueue.slice(0, at).find((e) => e.decision === 'pending');
    const target = after ?? before;
    if (target) setReviewIndex(nextQueue.findIndex((e) => e.id === target.id));
  }, []);

  const markDecision = useCallback(
    (id: number, decision: 'warped' | 'original') => {
      const next = entriesRef.current.map((e) => (e.id === id ? { ...e, decision } : e));
      entriesRef.current = next;
      setEntries(next);
      setTimeout(() => {
        if (mountedRef.current) advanceAfterDecision(id, next);
      }, 0);
    },
    [advanceAfterDecision],
  );

  const acceptWarped = useCallback(
    async (entry: QueueEntry) => {
      // Single-flight guard: the review child has no busy prop, so a second
      // Looks-good while the first warp is in flight must not advance past
      // the next pending page. (Decision check alone is insufficient: the
      // decision only flips after the warp resolves.)
      if (warpingRef.current) return;
      if (entriesRef.current.find((e) => e.id === entry.id)?.decision !== 'pending') return;
      warpingRef.current = true;
      setCardError(null);
      const img = imageElsRef.current.get(entry.id);
      const corners =
        entry.corners ??
        (entry.imageWidth > 0 ? fullFrameCorners(entry.imageWidth, entry.imageHeight) : null);
      if (!img || !corners) {
        warpingRef.current = false;
        setCardError('Warp needs the decoded image — use the original instead.');
        return;
      }
      try {
        const result = await extractDocument(img, corners, { output: 'canvas' });
        const canvas = result.output as HTMLCanvasElement | null;
        if (!canvas) throw new Error('no canvas');
        const blob = await canvasToPng(canvas);
        if (!blob) throw new Error('no png');
        if (!mountedRef.current) return;
        warpedBlobsRef.current.set(entry.id, blob);
        revokeUrl(entry.warpedUrl);
        const url = trackUrl(URL.createObjectURL(blob));
        setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, warpedUrl: url } : e)));
        markDecision(entry.id, 'warped');
      } catch {
        if (mountedRef.current)
          setCardError(
            'Warp failed on this page — nothing was committed. Use the original instead.',
          );
      } finally {
        warpingRef.current = false;
      }
    },
    [markDecision, revokeUrl, trackUrl],
  );

  /**
   * Re-warp after an adjust Apply (or any corner change): same warp as
   * acceptWarped but commits NO decision — the fresh `warpedUrl` re-renders
   * the overlay outline + result preview reactively. Decisions stay pending
   * so Looks-good / Use-original still apply afterwards.
   */
  const rewrapEntry = useCallback(
    async (id: number, corners: ScanicCorners) => {
      const entry = entriesRef.current.find((e) => e.id === id);
      const img = imageElsRef.current.get(id);
      if (!entry || !img) return;
      setCardError(null);
      try {
        const result = await extractDocument(img, corners, { output: 'canvas' });
        const canvas = result.output as HTMLCanvasElement | null;
        if (!canvas) throw new Error('no canvas');
        const blob = await canvasToPng(canvas);
        if (!blob) throw new Error('no png');
        if (!mountedRef.current) return;
        warpedBlobsRef.current.set(id, blob);
        revokeUrl(entriesRef.current.find((e) => e.id === id)?.warpedUrl ?? null);
        const url = trackUrl(URL.createObjectURL(blob));
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, corners, warpedUrl: url } : e)),
        );
      } catch {
        if (mountedRef.current)
          setCardError('Warp failed on this page — nothing changed. Use the original instead.');
      }
    },
    [revokeUrl, trackUrl],
  );

  const discardEntry = useCallback(
    (id: number) => {
      const target = entriesRef.current.find((e) => e.id === id);
      if (target) {
        revokeUrl(target.photoUrl);
        revokeUrl(target.warpedUrl);
        warpedBlobsRef.current.delete(id);
        imageElsRef.current.delete(id);
      }
      const next = entriesRef.current.filter((e) => e.id !== id);
      entriesRef.current = next;
      setEntries(next);
      setTimeout(() => {
        if (!mountedRef.current) return;
        if (next.length === 0) setPhase('camera');
        else setReviewIndex((i) => Math.min(i, next.length - 1));
      }, 0);
    },
    [revokeUrl],
  );

  const buildPdf = useCallback(() => {
    const pages: ScanicCommittedPage[] = accepted.map((entry, i) => {
      const name = formatScanName(startIndex + i);
      if (entry.decision === 'warped') {
        const blob = warpedBlobsRef.current.get(entry.id);
        if (blob) return { file: new File([blob], name, { type: 'image/png' }), name };
      }
      // "Use original": the queued File, byte-identical — renamed, never re-encoded.
      return {
        file: new File([entry.original], name, {
          type: entry.original.type || 'image/jpeg',
        }),
        name,
      };
    });
    onCommit(pages);
    onExit();
  }, [accepted, onCommit, onExit, startIndex]);

  const cameraHelp =
    camState === 'insecure'
      ? 'Camera needs a secure connection (HTTPS or localhost). You can add image files instead — they never leave this device.'
      : camState === 'denied'
        ? 'Camera access was denied. Folio only uses the camera while this scanner is open. Allow access in the browser site settings and retry — or add image files instead.'
        : camState === 'unavailable'
          ? 'No camera is available on this device or browser. Add image files instead — they stay on this device.'
          : null;

  const finderStatus =
    camState === 'requesting'
      ? 'Starting camera…'
      : paused
        ? 'Paused (tab hidden) — preview resumes when you return.'
        : 'Point at the page';

  // NOTE(Agent F): the review phase below stays inline until
  // `ScanicReview.tsx` lands (another agent's new file — never created here).
  // When it exists, replace the `[data-scan-queue]` block with
  // `<ScanicReview photoUrl imageWidth imageHeight corners warpedUrl
  //   detecting note pageLabel progressLabel onLooksGood
  //   onAdjustApply onUseOriginal onDiscard onRedetect redetecting />`
  // keeping the E2E contract and exact button labels below.
  const content = (
    <div
      data-scanner-root
      data-detector={DEFAULT_DETECTOR}
      className="fixed inset-0 z-50 flex max-h-[100dvh] flex-col overflow-hidden bg-paper-50 text-ink-900 dark:bg-ink-900 dark:text-paper-100"
    >
      {/* header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-paper-200/70 bg-paper-50/95 px-4 py-3 dark:border-ink-700/70 dark:bg-ink-900/95">
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-semibold tracking-tight text-ink-900 dark:text-paper-100">
            {phase === 'camera'
              ? 'Scan documents'
              : phase === 'review'
                ? 'Review scans'
                : 'Scan complete'}
          </p>
          <p className="truncate text-xs text-ink-400 dark:text-ink-300">
            {phase === 'camera'
              ? 'Capture pages, then review each auto-crop.'
              : phase === 'review'
                ? 'Looks good keeps the auto-crop; original keeps the photo untouched.'
                : `${accepted.length} page${accepted.length === 1 ? '' : 's'} accepted`}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close scanner"
          onClick={onExit}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-300 px-3 py-2 text-sm text-ink-500 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-700"
        >
          ✕
        </button>
      </div>

      {/* session strip — always rendered */}
      <div
        data-scan-strip
        className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-paper-200/70 bg-paper-50/95 px-4 py-2.5 dark:border-ink-700/70 dark:bg-ink-900/95"
      >
        {queue.length === 0 ? (
          <p className="text-xs text-ink-400 dark:text-ink-300">
            No pages yet — capture or add images.
          </p>
        ) : (
          queue.map((entry, i) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => goToReview(i)}
              aria-label={`Review page ${i + 1}${entry.decision !== 'pending' ? ` (${entry.decision === 'warped' ? 'auto-crop kept' : 'original kept'})` : ''}`}
              className={`relative h-14 w-11 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                current?.id === entry.id && phase === 'review'
                  ? 'border-brass-400'
                  : 'border-paper-200 dark:border-ink-700'
              }`}
            >
              {entry.photoUrl ? (
                <img src={entry.photoUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center bg-paper-200 text-[10px] text-ink-400 dark:bg-ink-700">
                  {i + 1}
                </span>
              )}
              {entry.status === 'detecting' && (
                <span className="absolute inset-0 flex items-center justify-center bg-ink-950/50 text-[9px] font-medium text-paper-50">
                  …
                </span>
              )}
              {entry.decision !== 'pending' && (
                <span className="absolute inset-x-0 bottom-0 bg-forest-500/90 py-0.5 text-center text-[9px] font-semibold text-white">
                  ✓
                </span>
              )}
            </button>
          ))
        )}
      </div>

      {phase === 'camera' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {camState === 'live' || camState === 'requesting' ? (
            <div className="relative min-h-0 flex-1 overflow-hidden bg-ink-950">
              <video
                ref={videoRef}
                muted
                playsInline
                autoPlay
                aria-label="Camera preview"
                style={previewMirrored ? { transform: 'scaleX(-1)' } : undefined}
                className="absolute inset-0 h-full w-full object-cover"
              />
              {/* Finder guidance frame: rounded-rect overlay with corner ticks. */}
              <div
                data-finder-frame
                aria-hidden
                className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 sm:p-10"
              >
                <div className="relative h-full max-h-[70dvh] w-full max-w-md rounded-2xl">
                  <span className="absolute left-0 top-0 h-9 w-9 rounded-tl-2xl border-l-4 border-t-4 border-paper-50/90" />
                  <span className="absolute right-0 top-0 h-9 w-9 rounded-tr-2xl border-r-4 border-t-4 border-paper-50/90" />
                  <span className="absolute bottom-0 left-0 h-9 w-9 rounded-bl-2xl border-b-4 border-l-4 border-paper-50/90" />
                  <span className="absolute bottom-0 right-0 h-9 w-9 rounded-br-2xl border-b-4 border-r-4 border-paper-50/90" />
                </div>
              </div>
              <p
                data-finder-status
                role="status"
                className="absolute inset-x-0 bottom-3 px-4 text-center text-sm font-medium text-paper-50 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
              >
                {finderStatus}
              </p>
              <div className="absolute right-2 top-2 flex gap-2">
                <button
                  type="button"
                  aria-label="Switch camera"
                  onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-ink-950/60 px-3 text-sm text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80"
                >
                  ⇄
                </button>
                <button
                  type="button"
                  data-mirror-toggle
                  aria-pressed={mirrored}
                  aria-label="Mirror front-camera preview"
                  title={
                    mirrored
                      ? 'Front preview mirrored (captures stay unmirrored)'
                      : 'Front preview unmirrored'
                  }
                  onClick={() => setMirrored((v) => !v)}
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-ink-950/60 px-3 text-sm text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80"
                >
                  {mirrored ? '◐' : '◑'}
                </button>
                {torchSupported && (
                  <button
                    type="button"
                    aria-label="Toggle torch"
                    aria-pressed={torchOn}
                    onClick={() => void toggleTorch()}
                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-ink-950/60 px-3 text-sm text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80"
                  >
                    {torchOn ? '🔦' : '💡'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="mx-4 mt-4 rounded-xl border border-dashed border-paper-300 px-4 py-6 text-center dark:border-ink-700">
              <p
                data-finder-status
                role="status"
                className="text-sm text-ink-500 dark:text-ink-300"
              >
                {cameraHelp}
              </p>
              {camState === 'denied' && (
                <button
                  type="button"
                  onClick={() => setRetryNonce((n) => n + 1)}
                  className="mt-3 inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
                >
                  Retry camera
                </button>
              )}
            </div>
          )}

          <div className="shrink-0 space-y-2 overflow-y-auto bg-paper-50 px-4 py-3 dark:bg-ink-900">
            {camState === 'live' && (
              <div className="flex items-center justify-center">
                <button
                  type="button"
                  data-scan-capture
                  aria-label="Capture page"
                  onClick={() => void captureFrame()}
                  className="inline-flex h-[76px] w-[76px] items-center justify-center rounded-full border-4 border-brass-400/70 bg-ink-900 text-paper-50 shadow-soft transition-transform active:scale-95 dark:bg-paper-50 dark:text-ink-900"
                >
                  <span aria-hidden className="h-12 w-12 rounded-full bg-brass-400" />
                </button>
              </div>
            )}
            {captureError !== null && (
              <p role="alert" className="text-center text-xs text-red-600 dark:text-red-400">
                {captureError}
              </p>
            )}

            <div className="flex flex-col items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                multiple
                className="hidden"
                aria-label="Add image files instead"
                onChange={(e) => {
                  addFilesInstead(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
              >
                Add image files instead
              </button>
              <p className="text-center text-[11px] text-ink-400 dark:text-ink-300">
                On-device ML auto-crop — images never leave this device.
              </p>
              {queue.length > 0 && (
                <button
                  type="button"
                  data-review-cta
                  onClick={() => goToReview()}
                  className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-medium text-paper-50 transition-colors hover:bg-ink-800 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200"
                >
                  {pendingCount > 0 ? `Review ${pendingCount} pages` : `View ${queue.length} pages`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === 'review' && current !== null && (
        <div data-scan-queue className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {cardError !== null && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {cardError}
            </p>
          )}
          <ScanicReview
            key={current.id}
            photoUrl={current.photoUrl}
            imageWidth={current.imageWidth}
            imageHeight={current.imageHeight}
            corners={current.corners}
            warpedUrl={current.warpedUrl}
            detecting={current.status === 'detecting'}
            note={current.note}
            pageLabel={`Page ${safeIndex + 1} of ${queue.length}`}
            progressLabel={`${reviewedCount} of ${queue.length} reviewed`}
            onLooksGood={() => void acceptWarped(current)}
            onAdjustApply={(corners) => void rewrapEntry(current.id, corners)}
            onUseOriginal={() => markDecision(current.id, 'original')}
            onDiscard={() => discardEntry(current.id)}
            onRedetect={() => void redetectEntry(current)}
            redetecting={redetecting}
          />
        </div>
      )}

      {phase === 'done' && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-center">
          <p className="font-display text-lg font-semibold tracking-tight text-ink-900 dark:text-paper-100">
            {accepted.length > 0 ? 'All pages ready' : 'No pages kept'}
          </p>
          <p
            data-review-progress
            aria-label={`${accepted.length} of ${accepted.length} reviewed`}
            className="text-xs text-ink-400 dark:text-ink-300"
          >
            {accepted.length} of {accepted.length} reviewed
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              disabled={accepted.length === 0}
              onClick={buildPdf}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-medium text-paper-50 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200"
            >
              Build PDF
            </button>
            <button
              type="button"
              onClick={() => setPhase('camera')}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              Back to camera
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // Single body portal carries the full-screen root (mounted on
  // document.body, never in AnimatePresence). Corner adjust lives inside
  // the review component, not in a separate overlay.
  if (typeof document !== 'undefined' && document.body) {
    return createPortal(content, document.body);
  }
  return content;
}
