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
 *   `[data-scan-capture]` (rendered only when live), gallery thumb
 *   `[data-scan-gallery]` (last queued thumb, jumps to review), mode pill
 *   `[data-scan-mode]` (`Manual` default / `Auto capture`), queue
 *   `[data-scan-queue]` with header `Page i of N`, result
 *   `[data-crop-result]` + `[data-crop-result-img]`, handles
 *   `[data-crop-handle="tl|tr|br|bl"]` (role=slider, arrow-key
 *   steppable via scanic's keyboard mode), review CTA `[data-review-cta]`
 *   (`View N pages` — every queued page is implicitly accepted, no pending),
 *   progress `[data-review-progress]` (aria-label `i of N viewed`, visited
 *   count — INTENTIONAL contract change from `reviewed`), pager
 *   `[data-page-prev]` / `[data-page-next]` (44px, disabled at ends),
 *   finder `[data-finder-frame]` + `[data-finder-status]`, mirror
 *   `[data-mirror-toggle]` (aria-pressed), filmstrip `[data-scan-filmstrip]`
 *   + `[data-film-thumb]` (numbered, tap jumps) + `[data-scan-add]` (back
 *   to camera), batch bar `[data-batch-bar]` (`Discard scans` ghost /
 *   `Next` primary, gated on >=1 page).
 * - Queue button labels are EXACT: "Adjust corners", "Apply",
 *   "Use original" (toggle warped <-> original), "Discard", "Reset to auto",
 *   "Build PDF", "Back to camera", "Re-detect", "Previous page",
 *   "Next page", "Next", "Discard scans". No "Looks good" exists anywhere —
 *   seeing a fine page is enough to move on (implicit accept).
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
  warmMlDetector,
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

/* ------------------------------------------------------------------ */
/* Auto capture (SAD stability shutter)                                */
/* ------------------------------------------------------------------ */

/**
 * Preview sampling grid for the stability shutter — tiny on purpose: the
 * <video> preview pixels are NEVER the detection input, and here they are
 * only a steadiness signal, so 48x27 grayscale is plenty.
 */
export const AUTO_CAPTURE_SAMPLE_W = 48;
export const AUTO_CAPTURE_SAMPLE_H = 27;
/** Mean per-pixel absolute difference at/below which a tick counts as steady. */
export const AUTO_CAPTURE_MEAN_THRESHOLD = 12;
/** Consecutive steady ticks required before the shutter fires. */
export const AUTO_CAPTURE_STABLE_TICKS_REQUIRED = 4;
/** Sampling cadence while auto mode is armed. */
export const AUTO_CAPTURE_TICK_MS = 300;
/** Minimum spacing between two auto shutter fires (static frames included). */
export const AUTO_CAPTURE_COOLDOWN_MS = 1500;
/**
 * Minimum time the "Scanning… hold steady" pill stays visible after the last
 * detection settles. Detection often resolves in ~200ms — faster than anyone
 * can read — so without a dwell the working state flashes past unreadably.
 */
export const SCAN_STATUS_DWELL_MS = 800;

/**
 * Sum of absolute differences between two equal-length grayscale frames.
 * Length mismatch (or anything unreadable) is maximally different.
 */
export function grayscaleSAD(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sad = 0;
  for (let i = 0; i < a.length; i += 1) sad += Math.abs(a[i] - b[i]);
  return sad;
}

/**
 * Steady when the mean per-pixel difference is within threshold — a
 * perfectly static preview (SAD 0) counts as steady; the cooldown (not this
 * comparator) is what bounds repeat fires on a frozen frame.
 */
export function isStableFrame(
  sad: number,
  pixelCount: number,
  meanThreshold: number = AUTO_CAPTURE_MEAN_THRESHOLD,
): boolean {
  if (!Number.isFinite(sad) || pixelCount <= 0) return false;
  return sad / pixelCount <= meanThreshold;
}

/**
 * Fire only after N consecutive steady ticks AND outside the cooldown window
 * since the last fire (manual or auto). `lastFireMs` null = never fired.
 */
export function shouldAutoFire(
  stableTicks: number,
  nowMs: number,
  lastFireMs: number | null,
  requiredTicks: number = AUTO_CAPTURE_STABLE_TICKS_REQUIRED,
  cooldownMs: number = AUTO_CAPTURE_COOLDOWN_MS,
): boolean {
  if (stableTicks < requiredTicks) return false;
  if (lastFireMs === null) return true;
  return nowMs - lastFireMs >= cooldownMs;
}

/** Downscaled grayscale snapshot of the live preview; null when unreadable. */
function samplePreviewGrayscale(video: HTMLVideoElement): Uint8Array | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = AUTO_CAPTURE_SAMPLE_W;
    canvas.height = AUTO_CAPTURE_SAMPLE_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, AUTO_CAPTURE_SAMPLE_W, AUTO_CAPTURE_SAMPLE_H);
    const data = ctx.getImageData(0, 0, AUTO_CAPTURE_SAMPLE_W, AUTO_CAPTURE_SAMPLE_H).data;
    const gray = new Uint8Array(AUTO_CAPTURE_SAMPLE_W * AUTO_CAPTURE_SAMPLE_H);
    for (let i = 0; i < gray.length; i += 1) {
      gray[i] = Math.round((data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3);
    }
    return gray;
  } catch {
    return null;
  }
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
  /**
   * Render verdict only (no pending — every queued page is implicitly
   * accepted): `warped` uses the warped PNG when available else the
   * original; `original` always uses the byte-identical original.
   * Defaults to `warped` (implicit accept with current crop).
   */
  decision: 'warped' | 'original';
  note: string | null;
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
  /** Manual (default) vs self-timed stability shutter. Manual NEVER auto-fires. */
  const [mode, setMode] = useState<'manual' | 'auto'>('manual');
  /**
   * Visited tracking (implicit-accept progress): viewing a page marks it
   * visited. `visitedTick` forces a rerender when the set grows (refs don't
   * render by themselves); progress = visited count of remaining pages.
   */
  const visitedIdsRef = useRef(new Set<number>());
  const [, setVisitedTick] = useState(0);
  /**
   * Eager-warp bookkeeping: which corner quad each entry's `warpedUrl` was
   * built for (`lastWarpedQuadRef`), and which quads an eager warp was
   * already attempted for (`eagerAttemptRef`, set synchronously before the
   * async warp so a re-render mid-warp cannot fire a duplicate). Both guard
   * the eager effect against re-warp loops; neither changes any decision.
   */
  const lastWarpedQuadRef = useRef(new Map<number, string>());
  const eagerAttemptRef = useRef(new Map<number, string>());

  const idRef = useRef(0);
  const entriesRef = useRef<QueueEntry[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const imageElsRef = useRef(new Map<number, HTMLImageElement>());
  const warpedBlobsRef = useRef(new Map<number, Blob>());
  const objectUrlsRef = useRef(new Set<string>());
  /** Last shutter time (manual or auto) — the auto cooldown gates on this. */
  const lastFireRef = useRef<number | null>(null);

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

  // Warm preload at scanner open: the ORT runtime + model bytes load while
  // the user frames the first page, so the first capture never pays the
  // load. Fire-and-forget; failure falls back silently per-entry.
  useEffect(() => {
    void warmMlDetector();
  }, []);

  const trackUrl = useCallback((url: string): string => {
    objectUrlsRef.current.add(url);
    return url;
  }, []);
  const revokeUrl = useCallback((url: string | null) => {
    if (url !== null && objectUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
  }, []);

  /* Queue derived state: discarded entries leave the queue immediately;
     implicit accept means every remaining page builds (no pending). */
  const queue = entries;
  const accepted = queue;
  const safeIndex = queue.length === 0 ? 0 : Math.min(reviewIndex, queue.length - 1);
  const current = queue[safeIndex] ?? null;
  const visitedCount = queue.filter((e) => visitedIdsRef.current.has(e.id)).length;
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
          decision: 'warped' as const,
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
        // Portrait ideals: phone cameras deliver tall frames — the
        // full-bleed viewfinder cover-crops in preview (standard viewfinder
        // behavior) while the capture path stores the full tall frame.
        stream = await navigator.mediaDevices.getUserMedia({
          video: front
            ? {
                facingMode: { ideal: facing },
                width: { ideal: 720 },
                height: { ideal: 1280 },
              }
            : {
                facingMode: { ideal: facing },
                width: { ideal: 1080 },
                height: { ideal: 1920 },
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

  /** Shutter tap: records the fire time so auto mode never double-fires. */
  const manualCapture = useCallback(() => {
    lastFireRef.current = Date.now();
    void captureFrame();
  }, [captureFrame]);

  // Auto capture: SAD-based stability shutter over tiny downscaled preview
  // frames. Armed ONLY in auto mode on the live camera view — manual mode
  // never reaches the sampler, so it can never auto-fire. Static previews
  // (SAD 0) count as steady but stay cooldown-bounded like any other fire.
  useEffect(() => {
    if (phase !== 'camera' || mode !== 'auto' || camState !== 'live') return;
    let cancelled = false;
    let prev: Uint8Array | null = null;
    let stable = 0;
    const id = window.setInterval(() => {
      if (cancelled || document.hidden) return;
      const video = videoRef.current;
      if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
      const gray = samplePreviewGrayscale(video);
      if (!gray) return;
      if (prev !== null) {
        const sad = grayscaleSAD(prev, gray);
        stable = isStableFrame(sad, gray.length) ? stable + 1 : 0;
        if (shouldAutoFire(stable, Date.now(), lastFireRef.current)) {
          lastFireRef.current = Date.now();
          stable = 0;
          void captureFrame();
        }
      }
      prev = gray;
    }, AUTO_CAPTURE_TICK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [phase, mode, camState, captureFrame]);

  const addFilesInstead = useCallback(
    (files: File[]) => {
      const images = files.filter(
        (f) => f.type === 'image/jpeg' || f.type === 'image/png' || /\.(jpe?g|png)$/i.test(f.name),
      );
      for (const file of images) enqueueCapture(file);
    },
    [enqueueCapture],
  );

  /* ---------------- review verdicts (implicit accept, toggle only) ---------------- */

  const goToReview = useCallback((index?: number) => {
    setReviewIndex(index ?? 0);
    setPhase('review');
  }, []);

  /**
   * `Use original` toggle: flips the current page's render verdict between
   * warped (implicit accept, warped PNG when available else original) and
   * original (byte-identical). Stays on the same page — no auto-advance.
   * StrictMode-safe: pure ref map + setEntries, no updater side effects.
   */
  const toggleVerdict = useCallback((id: number) => {
    const next: QueueEntry[] = entriesRef.current.map((e) =>
      e.id === id ? { ...e, decision: e.decision === 'original' ? 'warped' : 'original' } : e,
    );
    entriesRef.current = next;
    setEntries(next);
  }, []);

  /**
   * Re-warp after an adjust Apply (or any corner change): the fresh
   * `warpedUrl` re-renders the result preview reactively. The verdict stays
   * untouched (warped renders the fresh crop, original keeps the photo) —
   * no navigation, no decision change.
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
        lastWarpedQuadRef.current.set(id, JSON.stringify(corners));
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
        lastWarpedQuadRef.current.delete(id);
        eagerAttemptRef.current.delete(id);
        visitedIdsRef.current.delete(id);
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

  /**
   * Discard-all from the review batch bar: drops EVERYTHING back to the
   * camera, confirm-free. Revokes every queued URL so no blob leaks.
   */
  const discardAll = useCallback(() => {
    for (const entry of entriesRef.current) {
      revokeUrl(entry.photoUrl);
      revokeUrl(entry.warpedUrl);
      warpedBlobsRef.current.delete(entry.id);
      imageElsRef.current.delete(entry.id);
    }
    lastWarpedQuadRef.current.clear();
    eagerAttemptRef.current.clear();
    visitedIdsRef.current.clear();
    entriesRef.current = [];
    setEntries([]);
    setReviewIndex(0);
    setPhase('camera');
  }, [revokeUrl]);

  /**
   * EAGER warp: the review single canvas needs a `warpedUrl` the moment a
   * page has corners. When the review shows a ready page with corners whose
   * quad has no warp yet, re-warp immediately via the verdict-free
   * `rewrapEntry` core — no verdict change, ML-first / null-fallback /
   * commit paths untouched. Loop guard: one attempt per (entry, quad); skip
   * when the current `warpedUrl` was already built for these exact corners.
   * Runs for both verdicts so toggling back to warped is instant.
   */
  const eagerCornersKey = current?.corners ? JSON.stringify(current.corners) : null;
  useEffect(() => {
    if (phase !== 'review' || current === null || eagerCornersKey === null) return;
    if (current.status !== 'ready') return;
    if (current.corners === null) return;
    if (lastWarpedQuadRef.current.get(current.id) === eagerCornersKey) return;
    if (eagerAttemptRef.current.get(current.id) === eagerCornersKey) return;
    eagerAttemptRef.current.set(current.id, eagerCornersKey);
    void rewrapEntry(current.id, current.corners);
  }, [phase, current, eagerCornersKey, rewrapEntry]);

  /**
   * Visited marking: viewing a page (reviewIndex change incl. filmstrip tap,
   * pager buttons, and the initial show) marks it visited. Idempotent under
   * StrictMode double-effects (Set add is a no-op the second time, no tick).
   */
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (phase !== 'review' || currentId === null) return;
    if (visitedIdsRef.current.has(currentId)) return;
    visitedIdsRef.current.add(currentId);
    setVisitedTick((t) => t + 1);
  }, [phase, currentId, safeIndex]);

  const buildPdf = useCallback(() => {
    const pages: ScanicCommittedPage[] = accepted.map((entry, i) => {
      const name = formatScanName(startIndex + i);
      if (entry.decision !== 'original') {
        const blob = warpedBlobsRef.current.get(entry.id);
        if (blob) return { file: new File([blob], name, { type: 'image/png' }), name };
      }
      // Verdict `original`, or warped verdict with no warp yet: the queued
      // File, byte-identical — renamed, never re-encoded.
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

  const anyDetecting = queue.some((e) => e.status === 'detecting');
  const lastQueued = queue.length === 0 ? null : queue[queue.length - 1];

  // Minimum dwell for the working status: detection often settles in ~200ms
  // (warm ML session), faster than anyone can read — without a dwell the
  // "Scanning… hold steady" pill flashes past unreadably, and fast eyes (or
  // E2E) only ever see the idle text. The dwell keeps the working state
  // visible briefly AFTER the last settle; it never delays any action.
  const scanDwellUntilRef = useRef(0);
  const [, setDwellTick] = useState(0);
  useEffect(() => {
    // Empty queue (fresh open, discard-all): idle, never dwelling.
    if (queue.length === 0) {
      scanDwellUntilRef.current = 0;
      return;
    }
    if (queue.some((e) => e.status === 'detecting')) return;
    scanDwellUntilRef.current = Date.now() + SCAN_STATUS_DWELL_MS;
    // Repaint NOW: refs don't render by themselves, and with nothing else
    // scheduled the pill would freeze on the settle-time text (idle) for the
    // whole window. The trailing timeout repaints again at expiry.
    setDwellTick((t) => t + 1);
    const id = window.setTimeout(() => {
      if (mountedRef.current) setDwellTick((t) => t + 1);
    }, SCAN_STATUS_DWELL_MS + 50);
    return () => window.clearTimeout(id);
  }, [queue]);

  const finderStatus =
    camState === 'requesting'
      ? 'Starting camera…'
      : paused
        ? 'Paused (tab hidden) — preview resumes when you return.'
        : anyDetecting || Date.now() < scanDwellUntilRef.current
          ? 'Scanning… hold steady'
          : 'Point at the page';

  // Camera-phase flag: the camera is true full-bleed (video fills the
  // fixed surface edge-to-edge, chrome floats over it); review/done keep
  // the docked chrome. Single source for both strip variants below.
  const isCamera = phase === 'camera';
  // Session strip body — SAME thumbs/labels in both variants (floating
  // camera filmstrip + docked review/done strip); only the container
  // positioning differs by phase. Compact thumbs (h-14 w-11) keep 44px
  // targets in both.
  const stripBody =
    queue.length === 0 ? (
      <p
        className={
          isCamera ? 'text-xs text-paper-100/80' : 'text-xs text-ink-400 dark:text-ink-300'
        }
      >
        No pages yet — capture or add images.
      </p>
    ) : (
      queue.map((entry, i) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => goToReview(i)}
          aria-label={`Review page ${i + 1} (${entry.decision === 'warped' ? 'auto-crop kept' : 'original kept'})`}
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
        </button>
      ))
    );

  // Review phase: the single-page card is owned by `./ScanicReview` (props
  // below stay EXACT minus the removed Looks-good reliance); the pager +
  // filmstrip + batch bar underneath are owned here because the review
  // component renders the card only (never duplicates).
  const content = (
    <div
      data-scanner-root
      data-detector={DEFAULT_DETECTOR}
      className="fixed inset-0 z-50 flex max-h-[100dvh] flex-col overflow-hidden bg-paper-50 text-ink-900 dark:bg-ink-900 dark:text-paper-100"
    >
      {/* Top chrome: floating over the full-bleed video in camera phase
          (top scrim gradient, pointer-events-none except the controls),
          docked solid bar otherwise. Buttons/titles go light over video. */}
      <div
        className={
          isCamera
            ? 'pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-2 px-3 pb-6 pt-[max(0.5rem,env(safe-area-inset-top))]'
            : 'flex shrink-0 items-center gap-2 border-b border-paper-200/70 bg-paper-50/95 px-3 py-2 dark:border-ink-700/70 dark:bg-ink-900/95'
        }
      >
        {isCamera && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-ink-950/60 to-transparent"
          />
        )}
        <button
          type="button"
          aria-label="Close scanner"
          onClick={onExit}
          className={
            isCamera
              ? 'pointer-events-auto relative inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-50/20 bg-ink-950/60 px-3 py-2 text-sm text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80'
              : 'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-300 px-3 py-2 text-sm text-ink-500 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-700'
          }
        >
          ✕
        </button>
        <p
          className={
            isCamera
              ? 'relative min-w-0 flex-1 truncate text-center font-display text-sm font-semibold tracking-tight text-paper-50 drop-shadow'
              : 'min-w-0 flex-1 truncate text-center font-display text-sm font-semibold tracking-tight text-ink-900 dark:text-paper-100'
          }
        >
          Scan documents
        </p>
        {torchSupported ? (
          <button
            type="button"
            aria-label="Toggle torch"
            aria-pressed={torchOn}
            onClick={() => void toggleTorch()}
            className={
              isCamera
                ? 'pointer-events-auto relative inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-50/20 bg-ink-950/60 px-3 py-2 text-sm text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80'
                : 'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-300 px-3 py-2 text-sm text-ink-500 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-700'
            }
          >
            {torchOn ? '🔦' : '💡'}
          </button>
        ) : (
          <span aria-hidden className="min-h-[44px] min-w-[44px]" />
        )}
      </div>

      {/* Docked session strip for review/done — the camera phase uses the
          floating filmstrip inside the bottom overlay instead (same thumbs
          via stripBody above, always rendered so the slot never collapses). */}
      {!isCamera && (
        <div
          data-scan-strip
          className="flex h-20 shrink-0 items-center gap-2 overflow-x-auto border-b border-paper-200/70 bg-paper-50/95 px-4 py-2.5 dark:border-ink-700/70 dark:bg-ink-900/95"
        >
          {stripBody}
        </div>
      )}

      {isCamera && (
        // Full-bleed camera: the viewfinder is an absolute inset-0 layer of
        // the fixed surface with video object-cover filling it EXACTLY — no
        // aspect/max-w box, so black bars are impossible by construction.
        // All chrome (top bar, filmstrip, controls) floats over the video,
        // so captures can never shift layout by construction. dvh-safe: the
        // fixed root already tracks the dynamic viewport; bottom chrome pads
        // for the OS safe-area inset.
        <>
          <div className="absolute inset-0 z-0 overflow-hidden bg-ink-950">
            {camState === 'live' || camState === 'requesting' ? (
              <div data-viewfinder className="absolute inset-0 overflow-hidden bg-black">
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  autoPlay
                  aria-label="Camera preview"
                  style={previewMirrored ? { transform: 'scaleX(-1)' } : undefined}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                {/* Finder guidance frame: rounded-rect overlay with corner
                    ticks. Full-screen with top clearance for the floating
                    top bar + status pill; the bottom scrim stays translucent
                    so the corner ticks read through at the screen edges. */}
                <div
                  data-finder-frame
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 pt-24 sm:p-10 sm:pt-28"
                >
                  <div className="relative h-full w-full rounded-2xl">
                    <span className="absolute left-0 top-0 h-9 w-9 rounded-tl-2xl border-l-4 border-t-4 border-paper-50/90" />
                    <span className="absolute right-0 top-0 h-9 w-9 rounded-tr-2xl border-r-4 border-t-4 border-paper-50/90" />
                    <span className="absolute bottom-0 left-0 h-9 w-9 rounded-bl-2xl border-b-4 border-l-4 border-paper-50/90" />
                    <span className="absolute bottom-0 right-0 h-9 w-9 rounded-br-2xl border-b-4 border-r-4 border-paper-50/90" />
                  </div>
                </div>
                {/* Status pill rides top-center below the floating top bar so
                    the bottom overlay can never cover it. Dwell text logic
                    (finderStatus) is unchanged. */}
                <p
                  data-finder-status
                  role="status"
                  className="absolute left-1/2 top-24 max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-full bg-ink-950/70 px-4 py-2 text-center text-sm font-medium text-paper-50 backdrop-blur"
                >
                  {finderStatus}
                </p>
                <div className="absolute right-3 top-24 flex gap-2">
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
                </div>
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-ink-950 p-4 pb-72 pt-20">
                {/* No-preview fallback fills the same full-bleed slot (lifted
                    above the bottom overlay) so the controls never move
                    between camera states. */}
                <div className="rounded-xl border border-dashed border-paper-300 bg-paper-50 px-4 py-6 text-center dark:border-ink-700 dark:bg-ink-900">
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
              </div>
            )}
          </div>

          {/* Bottom overlay: floating filmstrip + controls over a bottom
              scrim (pointer-events-none except the controls). The strip keeps
              the same [data-scan-strip] thumbs, compact (h-16). The
              review-CTA slot stays reserved (min-h-[52px]) so the first
              capture never grows the overlay. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink-950/70 via-ink-950/30 to-transparent"
            />
            <div className="pointer-events-auto relative flex flex-col gap-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10">
              <div
                data-scan-strip
                className="flex h-16 shrink-0 items-center gap-2 overflow-x-auto py-1"
              >
                {stripBody}
              </div>
              {/* Manual/Auto segmented mode pill */}
              <div className="flex justify-center">
                <div
                  data-scan-mode
                  role="group"
                  aria-label="Capture mode"
                  className="inline-flex rounded-full border border-paper-50/25 bg-ink-950/60 p-1 backdrop-blur"
                >
                  <button
                    type="button"
                    aria-pressed={mode === 'manual'}
                    onClick={() => setMode('manual')}
                    className={`inline-flex min-h-[44px] items-center justify-center rounded-full px-5 text-sm font-medium transition-colors ${
                      mode === 'manual' ? 'bg-paper-50 text-ink-900' : 'text-paper-100/75'
                    }`}
                  >
                    Manual
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === 'auto'}
                    onClick={() => setMode('auto')}
                    className={`inline-flex min-h-[44px] items-center justify-center rounded-full px-5 text-sm font-medium transition-colors ${
                      mode === 'auto' ? 'bg-paper-50 text-ink-900' : 'text-paper-100/75'
                    }`}
                  >
                    Auto capture
                  </button>
                </div>
              </div>
              {mode === 'auto' && (
                <p className="text-center text-[11px] text-paper-100/75">
                  Hold steady over the page — the shutter fires itself.
                </p>
              )}

              {/* Bottom cluster: gallery thumb · big shutter · balance spacer */}
              <div className="flex items-center justify-between gap-4 px-2">
                <button
                  type="button"
                  data-scan-gallery
                  aria-label={
                    queue.length > 0 ? `Open review, ${queue.length} pages` : 'Open review'
                  }
                  disabled={queue.length === 0}
                  onClick={() => goToReview(queue.length - 1)}
                  className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-paper-50/25 bg-ink-950/60 text-paper-100 backdrop-blur transition-colors disabled:opacity-40"
                >
                  {lastQueued?.photoUrl ? (
                    <img src={lastQueued.photoUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span aria-hidden className="text-lg">
                      ▦
                    </span>
                  )}
                </button>
                {camState === 'live' ? (
                  <button
                    type="button"
                    data-scan-capture
                    aria-label="Capture page"
                    onClick={manualCapture}
                    className="inline-flex h-[76px] w-[76px] items-center justify-center rounded-full border-4 border-brass-400/70 bg-ink-900 text-paper-50 shadow-soft transition-transform active:scale-95 dark:bg-paper-50 dark:text-ink-900"
                  >
                    <span aria-hidden className="h-12 w-12 rounded-full bg-brass-400" />
                  </button>
                ) : (
                  <span aria-hidden className="h-[76px] w-[76px] shrink-0" />
                )}
                <span aria-hidden className="w-14 shrink-0" />
              </div>
              {captureError !== null && (
                <p role="alert" className="text-center text-xs text-red-300">
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
                  className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-50/25 bg-ink-950/60 px-5 py-2.5 text-sm font-medium text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80"
                >
                  Add image files instead
                </button>
                <p className="text-center text-[11px] text-paper-100/70">
                  On-device ML auto-crop — images never leave this device.
                </p>
                {/* Review-CTA slot: ALWAYS reserved at a fixed min-height so
                    the first capture never grows the overlay (and never moves
                    anything above it). The button itself stays queue-gated
                    per the E2E contract. */}
                <div className="flex min-h-[52px] items-center justify-center">
                  {queue.length > 0 && (
                    <button
                      type="button"
                      data-review-cta
                      onClick={() => goToReview()}
                      className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-paper-50 px-5 py-2.5 text-sm font-medium text-ink-900 transition-colors hover:bg-paper-200"
                    >
                      {`View ${queue.length} pages`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {phase === 'review' && current !== null && (
        <div data-scan-queue className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {cardError !== null && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {cardError}
            </p>
          )}
          {/* Pager beside the hero: prev/next page without any accept click. */}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              data-page-prev
              aria-label="Go to previous page"
              disabled={safeIndex <= 0}
              onClick={() => setReviewIndex((i) => Math.max(0, i - 1))}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              Previous page
            </button>
            <button
              type="button"
              data-page-next
              aria-label="Go to next page"
              disabled={safeIndex >= queue.length - 1}
              onClick={() => setReviewIndex((i) => Math.min(queue.length - 1, i + 1))}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              Next page
            </button>
          </div>
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
            progressLabel={`${visitedCount} of ${queue.length} viewed`}
            onAdjustApply={(corners) => void rewrapEntry(current.id, corners)}
            onUseOriginal={() => toggleVerdict(current.id)}
            onDiscard={() => discardEntry(current.id)}
            onRedetect={() => void redetectEntry(current)}
            redetecting={redetecting}
            verdict={current.decision}
          />
          {/* Review filmstrip (owned here — ScanicReview renders the single
              card only): numbered thumbs jump to a page, + returns to camera. */}
          <div
            data-scan-filmstrip
            aria-label="Scanned pages"
            className="flex items-center gap-2 overflow-x-auto py-1"
          >
            {queue.map((entry, i) => (
              <button
                key={entry.id}
                type="button"
                data-film-thumb
                aria-label={`Go to page ${i + 1} (${entry.decision === 'warped' ? 'auto-crop kept' : 'original kept'})`}
                aria-current={i === safeIndex}
                onClick={() => setReviewIndex(i)}
                className={`relative h-14 w-11 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                  i === safeIndex ? 'border-brass-400' : 'border-paper-200 dark:border-ink-700'
                }`}
              >
                {entry.photoUrl ? (
                  <img src={entry.photoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-paper-200 text-[10px] text-ink-400 dark:bg-ink-700">
                    {i + 1}
                  </span>
                )}
                <span className="absolute left-1 top-1 rounded-full bg-ink-950/70 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-paper-50">
                  {i + 1}
                </span>
              </button>
            ))}
            <button
              type="button"
              data-scan-add
              aria-label="Back to camera"
              onClick={() => setPhase('camera')}
              className="inline-flex h-14 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-dashed border-paper-300 px-3 text-sm font-medium text-ink-500 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-700"
            >
              + Add
            </button>
          </div>
          {/* Batch bar: discard-all (confirm-free, everything) vs Next.
              Next needs >=1 page (implicit accept — no per-page gate). */}
          <div
            data-batch-bar
            className="flex items-center justify-between gap-2 border-t border-paper-200/70 pt-3 dark:border-ink-700/70"
          >
            <button
              type="button"
              onClick={discardAll}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl px-5 py-2.5 text-sm font-medium text-ink-500 transition-colors hover:bg-paper-200 dark:text-ink-300 dark:hover:bg-ink-700"
            >
              Discard scans
            </button>
            <button
              type="button"
              disabled={queue.length === 0}
              onClick={() => setPhase('done')}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-medium text-paper-50 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-center">
          <p className="font-display text-lg font-semibold tracking-tight text-ink-900 dark:text-paper-100">
            {accepted.length > 0 ? 'All pages ready' : 'No pages kept'}
          </p>
          <p
            data-review-progress
            aria-label={`${visitedCount} of ${accepted.length} viewed`}
            className="text-xs text-ink-400 dark:text-ink-300"
          >
            {visitedCount} of {accepted.length} viewed
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
