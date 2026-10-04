/**
 * ScanicCapture — camera session + result-FIRST review queue for document scanning.
 *
 * Detection + warp run on the main thread through the real `scanic` package
 * (classical Canny pipeline; DocCornerNet ML only when the user opts in per
 * capture, with vendored same-origin assets — see `public/assets/scanic-ml/`).
 * Corner *types* come from the worker agent's barrel (`./scan/index`), the
 * single source of truth; the queue runtime here is intentionally inline
 * (main-thread `scanDocument`/`extractDocument` per capture) so the review UI
 * works standalone — swapping the internals onto `useScanicProcessor` later
 * must keep the DOM contract below byte-for-byte.
 *
 * E2E DATA CONTRACT (do not rename):
 * - root `[data-scanner-root]`, shutter `[data-scan-capture]`,
 *   queue `[data-scan-queue]` with header `Page i of N`,
 *   result `[data-crop-result]` + `[data-crop-result-img]`,
 *   handles `[data-crop-handle="tl|tr|br|bl"]` (role=slider, arrow-key
 *   steppable via scanic's keyboard mode), review CTA `[data-review-cta]`
 *   (`Review N pages` / `View N pages`), progress `[data-review-progress]`
 *   (aria-label `i of N reviewed`).
 * - Queue button labels are EXACT: "Looks good", "Adjust corners", "Apply",
 *   "Use original", "Discard", "Reset to auto", "Build PDF", "Back to camera".
 *
 * Binary ownership: originals live as File handles in refs/state (never
 * re-encoded, never base64); only object-URL strings enter React state, and
 * every URL is revoked on discard/commit/unmount. Warped commits are full-res
 * PNGs from `extractDocument(..., { output: 'canvas' })`.
 *
 * Corner editor: scanic `createCornerEditor` with a Folio skin (brass accent,
 * ink surface, paper handles). scanic's own toolbar is disabled and replaced
 * by Folio buttons with the exact E2E labels; the editor surface is portaled
 * to `document.body` and is NEVER rendered inside an `AnimatePresence`.
 * `injectStyles` keeps scanic's default (its stylesheet positions the canvas +
 * handles; the skin arrives through `theme` vars + `classNames`) — an inline
 * copy of that MIT stylesheet was deliberately not vendored here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createCornerEditor, extractDocument, scanDocument } from 'scanic';
import type { CornerEditor } from 'scanic';
import type { ScanicCorners } from './scan/index';

/** Self-hosted (same-origin) ML detector assets — ML is strictly opt-in. */
export const SCANIC_ML_ASSET_BASE_URL = '/assets/scanic-ml/';

/** E2E short keys for the four corner handles. */
export const SCANIC_HANDLE_KEYS = ['tl', 'tr', 'br', 'bl'] as const;
export type ScanicHandleKey = (typeof SCANIC_HANDLE_KEYS)[number];

type ScanicCornerName = keyof ScanicCorners;
const HANDLE_FOR_CORNER: Record<ScanicCornerName, ScanicHandleKey> = {
  topLeft: 'tl',
  topRight: 'tr',
  bottomRight: 'br',
  bottomLeft: 'bl',
};
const CORNER_LABEL: Record<ScanicCornerName, string> = {
  topLeft: 'Top-left corner',
  topRight: 'Top-right corner',
  bottomRight: 'Bottom-right corner',
  bottomLeft: 'Bottom-left corner',
};

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

/**
 * Totally-ordered E2E-safe handle enhancement: scanic renders its own DOM
 * handle buttons (`.scanic-handle`, `data-corner="topLeft"|…`, arrow-key
 * nudge + Enter/Escape built in). This layer adds the Folio/E2E contract
 * attributes on top without touching scanic's behavior.
 */
function enhanceEditorHandles(
  host: HTMLElement,
  corners: ScanicCorners,
  w: number,
  h: number,
): void {
  const buttons = host.querySelectorAll<HTMLButtonElement>('.scanic-handle');
  buttons.forEach((btn) => {
    const name = btn.dataset.corner as ScanicCornerName | undefined;
    if (name === undefined || HANDLE_FOR_CORNER[name] === undefined) return;
    const point = corners[name];
    const pctX = w > 0 ? Math.round((point.x / w) * 100) : 0;
    const pctY = h > 0 ? Math.round((point.y / h) * 100) : 0;
    btn.setAttribute('data-crop-handle', HANDLE_FOR_CORNER[name]);
    btn.setAttribute('role', 'slider');
    btn.setAttribute('aria-label', CORNER_LABEL[name]);
    btn.setAttribute('aria-valuemin', '0');
    btn.setAttribute('aria-valuemax', '100');
    btn.setAttribute('aria-valuenow', String(pctX));
    btn.setAttribute('aria-valuetext', `${pctX} percent across, ${pctY} percent down`);
    if (btn.tabIndex < 0) btn.tabIndex = 0;
  });
}

/* ------------------------------------------------------------------ */
/* Corner editor surface (portaled; never inside AnimatePresence)       */
/* ------------------------------------------------------------------ */

function CornerEditorSurface({
  image,
  imageWidth,
  imageHeight,
  initialCorners,
  autoAvailable,
  onApply,
  onClose,
}: {
  image: HTMLImageElement;
  imageWidth: number;
  imageHeight: number;
  initialCorners: ScanicCorners;
  /** False when there is no detection baseline to reseed from. */
  autoAvailable: boolean;
  onApply: (corners: ScanicCorners) => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CornerEditor | null>(null);
  const onApplyRef = useRef(onApply);
  const onCloseRef = useRef(onClose);
  onApplyRef.current = onApply;
  onCloseRef.current = onClose;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const editor = createCornerEditor({
      container: host,
      image,
      corners: initialCorners,
      magnifier: { enabled: true },
      // Folio renders its own toolbar below (exact E2E labels + 44px targets).
      toolbar: { enabled: false },
      theme: {
        accent: '#c97a1f',
        edgeColor: '#c97a1f',
        handleColor: '#fdfbf7',
        handleRingColor: '#c97a1f',
        mask: 'rgba(23, 19, 14, 0.55)',
        surface: '#1e1913',
        surfaceColor: '#fdfbf7',
      },
      classNames: { root: 'folio-scanic-editor' },
      handleHitArea: 44,
      keyboard: true,
      onChange: (corners) => enhanceEditorHandles(host, corners, imageWidth, imageHeight),
      onConfirm: (corners) => onApplyRef.current(corners),
      onCancel: () => onCloseRef.current(),
    });
    editorRef.current = editor;
    enhanceEditorHandles(host, editor.getCorners(), imageWidth, imageHeight);
    host.querySelector<HTMLButtonElement>('.scanic-handle')?.focus();
    return () => {
      editor.destroy();
      editorRef.current = null;
    };
    // Mount-once per opening (parent remounts via key); initialCorners is the seed.
  }, [image]);

  return (
    <div
      className="flex max-h-[100dvh] w-full max-w-2xl flex-col gap-3 overflow-y-auto rounded-2xl border border-paper-300/70 bg-paper-50 p-4 shadow-soft sm:p-5 dark:border-ink-700 dark:bg-ink-800"
      role="dialog"
      aria-modal="true"
      aria-label="Adjust document corners"
    >
      <div
        ref={hostRef}
        className="relative w-full overflow-hidden rounded-xl bg-ink-950"
        style={{ minHeight: 240 }}
      />
      <p className="text-xs text-ink-400 dark:text-ink-300">
        Drag a handle or focus one and use the arrow keys (Shift for larger steps). Enter applies,
        Escape closes.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            const editor = editorRef.current;
            if (editor) onApplyRef.current(editor.confirm());
          }}
          className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-medium text-paper-50 transition-colors hover:bg-ink-800 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200"
        >
          Apply
        </button>
        <button
          type="button"
          disabled={!autoAvailable}
          title={autoAvailable ? 'Reseed from auto-detection' : 'No auto-detection for this page'}
          onClick={() => {
            const editor = editorRef.current;
            const host = hostRef.current;
            if (!editor || !host) return;
            editor.reset();
            enhanceEditorHandles(host, editor.getCorners(), imageWidth, imageHeight);
          }}
          className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-800"
        >
          Reset to auto
        </button>
        <button
          type="button"
          aria-label="Close corner editor"
          onClick={() => editorRef.current?.cancel()}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-300 px-4 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-800"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ScanicCapture                                                       */
/* ------------------------------------------------------------------ */

export default function ScanicCapture({ onCommit, onExit, startIndex = 0 }: ScanicCaptureProps) {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [phase, setPhase] = useState<Phase>('camera');
  const [reviewIndex, setReviewIndex] = useState(0);
  const [editorEntryId, setEditorEntryId] = useState<number | null>(null);
  const [camState, setCamState] = useState<CameraState>('requesting');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [paused, setPaused] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [warping, setWarping] = useState(false);
  const [mlPreferred, setMlPreferred] = useState(false);

  const idRef = useRef(0);
  const entriesRef = useRef<QueueEntry[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const imageElsRef = useRef(new Map<number, HTMLImageElement>());
  const warpedBlobsRef = useRef(new Map<number, Blob>());
  const objectUrlsRef = useRef(new Set<string>());
  const mlPreferredRef = useRef(mlPreferred);
  mlPreferredRef.current = mlPreferred;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
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

  /* ---------------- detection (classical default, ML opt-in per call) ---------------- */

  const detectEntry = useCallback(async (id: number, photoUrl: string, ml: boolean) => {
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
          ? {
              ...e,
              imageWidth: w,
              imageHeight: h,
              note: ml ? 'Loading on-device ML detector…' : null,
            }
          : e,
      ),
    );
    try {
      const result = ml
        ? await scanDocument(el, {
            detector: 'ml',
            ml: { assetBaseUrl: SCANIC_ML_ASSET_BASE_URL },
          })
        : await scanDocument(el, { detector: 'classical' });
      if (!mountedRef.current) return;
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                ...e,
                status: 'ready' as const,
                corners: result.corners,
                note:
                  result.corners === null
                    ? 'Auto-detect found no page — the full frame will be used. Adjust corners to crop manually.'
                    : null,
              }
            : e,
        ),
      );
    } catch {
      // ML can fail (model fetch, ORT runtime); fall back to classical once,
      // honestly labelled. Classical failure degrades to full-frame.
      if (!mountedRef.current) return;
      if (ml) {
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
      void detectEntry(id, photoUrl, mlPreferredRef.current);
      return position;
    },
    [detectEntry, trackUrl],
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
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing } },
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
      setCardError(null);
      const img = imageElsRef.current.get(entry.id);
      const corners =
        entry.corners ??
        (entry.imageWidth > 0 ? fullFrameCorners(entry.imageWidth, entry.imageHeight) : null);
      if (!img || !corners) {
        setCardError('Warp needs the decoded image — use the original instead.');
        return;
      }
      setWarping(true);
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
        if (mountedRef.current) setWarping(false);
      }
    },
    [markDecision, revokeUrl, trackUrl],
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

  const editorEntry =
    editorEntryId !== null ? (queue.find((e) => e.id === editorEntryId) ?? null) : null;
  const editorImage = editorEntry ? (imageElsRef.current.get(editorEntry.id) ?? null) : null;

  const cameraHelp =
    camState === 'insecure'
      ? 'Camera needs a secure connection (HTTPS or localhost). You can add image files instead — they never leave this device.'
      : camState === 'denied'
        ? 'Camera access was denied. Folio only uses the camera while this scanner is open. Allow access in the browser site settings and retry — or add image files instead.'
        : camState === 'unavailable'
          ? 'No camera is available on this device or browser. Add image files instead — they stay on this device.'
          : null;

  return (
    <div
      data-scanner-root
      className="overflow-hidden rounded-2xl border border-paper-300/70 bg-paper-50/85 shadow-soft dark:border-ink-700 dark:bg-ink-800/60"
    >
      {/* header */}
      <div className="flex items-center gap-2 border-b border-paper-200/70 px-4 py-3 dark:border-ink-700/70">
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
          data-ml-detector
          aria-pressed={mlPreferred}
          title={
            mlPreferred
              ? 'ML detector on (opt-in, self-hosted model)'
              : 'Classical detector (default, fully on-device)'
          }
          onClick={() => setMlPreferred((v) => !v)}
          className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-colors ${
            mlPreferred
              ? 'border-brass-400/60 bg-brass-400/[0.12] text-brass-600 dark:text-brass-300'
              : 'border-paper-300 text-ink-500 hover:bg-paper-200 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-700'
          }`}
        >
          <span aria-hidden>{mlPreferred ? '◆' : '◇'}</span>
          ML detector
        </button>
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
        className="flex items-center gap-2 overflow-x-auto border-b border-paper-200/70 px-4 py-2.5 dark:border-ink-700/70"
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
        <div className="space-y-3 p-4">
          {camState === 'live' || camState === 'requesting' ? (
            <div className="relative overflow-hidden rounded-xl bg-ink-950">
              <video
                ref={videoRef}
                muted
                playsInline
                autoPlay
                aria-label="Camera preview"
                className="mx-auto max-h-[70dvh] w-full object-contain"
              />
              {camState === 'requesting' && (
                <p
                  role="status"
                  className="absolute inset-0 flex items-center justify-center text-sm text-paper-100"
                >
                  Starting camera…
                </p>
              )}
              {paused && (
                <p
                  role="status"
                  className="absolute inset-x-0 top-2 text-center text-xs text-paper-100/80"
                >
                  Paused (tab hidden) — preview resumes when you return.
                </p>
              )}
              <div className="absolute right-2 top-2 flex gap-2">
                <button
                  type="button"
                  aria-label="Switch camera"
                  onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-ink-950/60 px-3 text-sm text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80"
                >
                  ⇄
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
            <div className="rounded-xl border border-dashed border-paper-300 px-4 py-6 text-center dark:border-ink-700">
              <p className="text-sm text-ink-500 dark:text-ink-300">{cameraHelp}</p>
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
            {mlPreferred && (
              <p className="text-center text-[11px] text-ink-400 dark:text-ink-300">
                ML detector on: the model loads on first use from this device (self-hosted, no CDN).
              </p>
            )}
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
      )}

      {phase === 'review' && current !== null && (
        <div data-scan-queue className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-sm font-medium text-ink-700 dark:text-paper-100">
              Page {safeIndex + 1} of {queue.length}
            </p>
            <p
              data-review-progress
              aria-label={`${reviewedCount} of ${queue.length} reviewed`}
              className="text-xs tabular-nums text-ink-400 dark:text-ink-300"
            >
              {reviewedCount} of {queue.length} reviewed
            </p>
          </div>

          <div data-crop-result className="relative overflow-hidden rounded-xl bg-ink-950">
            {current.status === 'detecting' ? (
              <p
                role="status"
                className="flex min-h-56 items-center justify-center text-sm text-paper-100"
              >
                Preparing…
              </p>
            ) : (
              <img
                data-crop-result-img
                src={current.warpedUrl ?? current.photoUrl}
                alt={`Scan page ${safeIndex + 1}`}
                className="mx-auto max-h-[60dvh] w-full object-contain"
              />
            )}
          </div>
          {current.note !== null && current.status === 'ready' && (
            <p className="text-xs text-ink-400 dark:text-ink-300">{current.note}</p>
          )}
          {cardError !== null && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {cardError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={current.status !== 'ready' || warping}
              onClick={() => void acceptWarped(current)}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-medium text-paper-50 transition-colors hover:bg-ink-800 disabled:cursor-wait disabled:opacity-50 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200"
            >
              {warping ? 'Preparing…' : 'Looks good'}
            </button>
            <button
              type="button"
              disabled={current.status !== 'ready' || warping}
              onClick={() => setEditorEntryId(current.id)}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              Adjust corners
            </button>
            <button
              type="button"
              disabled={current.status !== 'ready' || warping}
              onClick={() => markDecision(current.id, 'original')}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              Use original
            </button>
            <button
              type="button"
              disabled={warping}
              onClick={() => discardEntry(current.id)}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-red-600/30 px-5 py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:hover:bg-red-950/30"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="space-y-3 p-4 text-center">
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

      {/* Portaled editor surface — a sibling here, mounted on document.body, never in AnimatePresence. */}
      {editorEntry !== null &&
        editorImage !== null &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-ink-950/70 p-4 backdrop-blur-sm">
            <CornerEditorSurface
              key={editorEntry.id}
              image={editorImage}
              imageWidth={editorEntry.imageWidth}
              imageHeight={editorEntry.imageHeight}
              initialCorners={
                editorEntry.corners ??
                fullFrameCorners(
                  Math.max(1, editorEntry.imageWidth),
                  Math.max(1, editorEntry.imageHeight),
                )
              }
              autoAvailable={editorEntry.corners !== null}
              onApply={(corners) => {
                setEntries((prev) =>
                  prev.map((e) => (e.id === editorEntry.id ? { ...e, corners } : e)),
                );
                setEditorEntryId(null);
              }}
              onClose={() => setEditorEntryId(null)}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
