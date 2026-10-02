/**
 * Scan processor hook: capture → worker → review state machine for the
 * document scanner (M3).
 *
 * Owns NO pixels in React state — only handles, URLs, and result
 * metadata. One `ScanWorkerClient` per hook instance (lazy WASM load on
 * first processing request — or earlier via `warm()` at camera start,
 * so init overlaps viewfinder startup instead of the first live tick —
 * terminated on reset/unmount).
 *
 * Generation safety: every async continuation checks the session
 * generation. `reset()` (Done / unmount / camera switch) bumps it and
 * terminates the worker — stale results are dropped before they can
 * create pages, replace previews, or resurrect sessions. Rapid captures
 * discard the previous pending review (latest wins).
 *
 * Live detection: `requestLive()` sends the LATEST frame only through
 * the detect-only path (status `detected`, no warp/encode, no bytes);
 * calls while a live request, capture scan, or review is active are
 * skipped (no queue of stale frames). Live corners are guidance ONLY —
 * the shutter always runs a fresh full-resolution detection.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScanWorkerClient,
  type ScanCorner,
  type ScanRewrapResult,
  type ScanResult,
  type ScanWorkerFactory,
} from './scanWorkerClient';

/**
 * The hardened scanner has ONE capture experience (product decision):
 * document scans in normal color. There is no UI mode selector — the
 * core pipeline mode is fixed at the color path (`CORE_MODE`).
 */
const CORE_MODE = 'original' as const;

/**
 * Warmup payload (5-5): the canonical 1×1 transparent PNG. It decodes
 * and detects (exercising the real worker path) with negligible pixel
 * cost; the point is WASM init + worker boot, whose latency then
 * overlaps camera startup instead of the first live tick / shutter.
 * A corrupt payload would still warm identically (init precedes
 * process) — the result is discarded either way.
 */
const WARMUP_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x60, 0x00, 0x02, 0x00,
  0x00, 0x05, 0x00, 0x01, 0xe9, 0xfa, 0xdc, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

export interface PendingReview {
  /** Original full-res capture (retained for Use original / retry). */
  original: File;
  /** Review preview URL (processed bytes, or original on fallback/error). */
  previewUrl: string;
  result: ScanResult;
}

/**
 * Crop-verify rewarp plumbing (Agent B contract, consumed directly):
 * `client.rewrapScan(original, quad)` re-warps the full-res capture with
 * an operator-adjusted quad in full-res capture pixel coords and resolves
 * `{bytes, width, height}`; it rejects when the glue refuses the quad.
 * Both verify call sites treat rejection as "keep the auto result".
 */
type RewrapScanFn = (original: Uint8Array, quad: ScanCorner[]) => Promise<ScanRewrapResult>;

function rewrapOf(client: ScanWorkerClient): RewrapScanFn {
  return client.rewrapScan.bind(client);
}

/**
 * Preview budget: debounced verify previews are downscaled to ≤800px on
 * the long edge; full resolution crosses the worker only on Confirm.
 */
const VERIFY_PREVIEW_LONG_EDGE = 800;
/** Confirm never hangs the verify screen: a slow rewarp falls back to the auto result. */
const REWRAP_TIMEOUT_MS = 30000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let id = 0;
  const timeout = new Promise<never>((_, reject) => {
    id = window.setTimeout(() => reject(new Error('scan rewarp timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(id));
}

/**
 * Builds the debounced preview payload: downscales `original` on a
 * canvas to the preview budget and maps the full-res quad into the
 * downscaled space. Returns null when decode/encode is unavailable —
 * the preview is best-effort, the overlay stays authoritative.
 */
async function downscaleForPreview(
  original: File,
  result: ScanResult,
  quad: ScanCorner[],
): Promise<{ bytes: Uint8Array; quad: ScanCorner[] } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(original);
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    if (srcW <= 0 || srcH <= 0) return null;
    const scale = Math.min(1, VERIFY_PREVIEW_LONG_EDGE / Math.max(srcW, srcH));
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));
    // Quad space is the capture pixel space (result.width/height); the
    // decoded bitmap is the same frame, mapped defensively in case the
    // glue ever reports dims from a different stage.
    const toBitmapX = result.width > 0 ? srcW / result.width : 1;
    const toBitmapY = result.height > 0 ? srcH / result.height : 1;
    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(bitmap, 0, 0, dstW, dstH);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.8),
    );
    canvas.width = 0;
    canvas.height = 0;
    if (blob === null) return null;
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      quad: quad.map((p) => ({ x: p.x * toBitmapX * scale, y: p.y * toBitmapY * scale })),
    };
  } catch {
    return null;
  } finally {
    try {
      bitmap?.close();
    } catch {
      // Release best-effort.
    }
  }
}

export interface AcceptedScan {
  file: File;
  /** Pre-scan capture to retain (processed accepts only). */
  original: File | null;
  name: string;
}

export function useScanProcessor(createWorker?: ScanWorkerFactory) {
  const clientRef = useRef<ScanWorkerClient | null>(null);
  const genRef = useRef(0);
  const livePendingRef = useRef(false);
  const warmedGenRef = useRef(-1);
  const [processing, setProcessing] = useState(false);
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [liveDetected, setLiveDetected] = useState(false);
  const pendingRef = useRef<PendingReview | null>(null);
  pendingRef.current = pending;

  // Crop-verify (Agent C surface): a processed capture opens the verify
  // screen FIRST (original photo + adjustable quad overlay). Confirm
  // re-warps at full resolution and drops into the existing review;
  // Cancel keeps the auto result untouched. Fallback (`original`) and
  // error reviews never open verify — their paths are unchanged.
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyPreviewUrl, setVerifyPreviewUrl] = useState<string | null>(null);
  const [verifyPreviewPending, setVerifyPreviewPending] = useState(false);
  const [rewrapping, setRewrapping] = useState(false);
  const verifyOpenRef = useRef(false);
  verifyOpenRef.current = verifyOpen;
  const verifyPreviewUrlRef = useRef<string | null>(null);
  verifyPreviewUrlRef.current = verifyPreviewUrl;
  // Latest-wins token for debounced previews: superseded responses never
  // install (mirrors the review latest-wins discipline).
  const previewTokenRef = useRef(0);

  const client = (): ScanWorkerClient => {
    if (clientRef.current === null) {
      clientRef.current =
        createWorker === undefined ? new ScanWorkerClient() : new ScanWorkerClient(createWorker);
    }
    return clientRef.current;
  };

  const revokePending = useCallback((review: PendingReview | null) => {
    if (review?.previewUrl) URL.revokeObjectURL(review.previewUrl);
  }, []);

  /** Releases the debounced preview URL (verify-session scoped). */
  const revokeVerifyPreview = useCallback(() => {
    if (verifyPreviewUrlRef.current !== null) {
      URL.revokeObjectURL(verifyPreviewUrlRef.current);
      verifyPreviewUrlRef.current = null;
      setVerifyPreviewUrl(null);
    }
  }, []);

  /** Leaves verify: invalidates in-flight previews, drops flags, frees the preview URL. Pending untouched. */
  const closeVerify = useCallback(() => {
    previewTokenRef.current += 1;
    setVerifyPreviewPending(false);
    setRewrapping(false);
    setVerifyOpen(false);
    revokeVerifyPreview();
  }, [revokeVerifyPreview]);

  /** Invalidates the session: stale results dropped, worker terminated. */
  const reset = useCallback(() => {
    genRef.current += 1;
    livePendingRef.current = false;
    warmedGenRef.current = -1;
    revokePending(pendingRef.current);
    setPending(null);
    setProcessing(false);
    setLiveDetected(false);
    closeVerify();
    try {
      clientRef.current?.terminate();
    } catch {
      // Best effort.
    }
    clientRef.current = null;
  }, [closeVerify, revokePending]);

  useEffect(() => {
    return () => {
      genRef.current += 1;
      revokePending(pendingRef.current);
      revokeVerifyPreview();
      try {
        clientRef.current?.terminate();
      } catch {
        // Best effort.
      }
      clientRef.current = null;
    };
  }, [revokePending, revokeVerifyPreview]);

  /**
   * Sends a full-res capture for processing. Previous pending review is
   * discarded (latest wins). Resolves into review state — never directly
   * into the page collection.
   */
  const processCapture = useCallback(
    (original: File) => {
      const gen = genRef.current;
      revokePending(pendingRef.current);
      setPending(null);
      // A new capture supersedes any verify session (latest wins).
      closeVerify();
      setLiveDetected(false);
      setProcessing(true);
      void (async () => {
        try {
          const bytes = new Uint8Array(await original.arrayBuffer());
          const result = await client().process(bytes, CORE_MODE);
          if (genRef.current !== gen) return; // Stale: drop silently.
          const previewBlob =
            result.status === 'processed' && result.bytes !== null
              ? new Blob([result.bytes as unknown as BlobPart], { type: 'image/jpeg' })
              : original;
          setPending({ original, previewUrl: URL.createObjectURL(previewBlob), result });
          // Processed captures verify FIRST (dims guard the contain
          // mapping); fallback/error reviews keep their existing paths.
          // The verify screen owns the original-photo URL itself
          // (mount-scoped, revoked on unmount) — no hook URL here, so
          // the review accept/discard accounting is unchanged.
          if (result.status === 'processed' && result.width > 0 && result.height > 0) {
            setVerifyOpen(true);
          }
        } catch {
          if (genRef.current !== gen) return;
          setPending({
            original,
            previewUrl: URL.createObjectURL(original),
            result: {
              status: 'error',
              jobId: 'local',
              width: 0,
              height: 0,
              mode: CORE_MODE,
              corners: null,
              confidence: 0,
              reason: null,
              code: 'scan-failed',
              message: 'Scan processing failed.',
              bytes: null,
              wallMs: 0,
            },
          });
        } finally {
          if (genRef.current === gen) setProcessing(false);
        }
      })();
    },
    [closeVerify, revokePending],
  );

  /** Accepts the review: returns files for the page collection. */
  const accept = useCallback(
    (useProcessed: boolean): AcceptedScan | null => {
      const review = pendingRef.current;
      if (review === null) return null;
      revokePending(review);
      setPending(null);
      closeVerify();
      if (useProcessed && review.result.status === 'processed' && review.result.bytes !== null) {
        return {
          file: new File([review.result.bytes as unknown as BlobPart], review.original.name, {
            type: 'image/jpeg',
          }),
          original: review.original,
          name: review.original.name,
        };
      }
      return { file: review.original, original: null, name: review.original.name };
    },
    [closeVerify, revokePending],
  );

  /** Discards the pending review (Retake): accepted pages untouched. */
  const discard = useCallback(() => {
    revokePending(pendingRef.current);
    setPending(null);
    closeVerify();
  }, [closeVerify, revokePending]);

  /**
   * Latest-frame live detection tick. Skipped while a live request, a
   * capture scan, or a review is active — never queued.
   */
  const requestLive = useCallback((frame: Blob) => {
    if (livePendingRef.current) return;
    const gen = genRef.current;
    livePendingRef.current = true;
    void (async () => {
      try {
        const bytes = new Uint8Array(await frame.arrayBuffer());
        // Client is created lazily here: first live tick loads WASM.
        // detectOnly: guidance needs corners, never warped bytes.
        const result = await client().process(bytes, 'original', true);
        if (genRef.current !== gen) return;
        setLiveDetected(result.status === 'detected' && result.corners !== null);
      } catch {
        if (genRef.current === gen) setLiveDetected(false);
      } finally {
        livePendingRef.current = false;
      }
    })();
  }, []);

  /**
   * Warms the scan worker at camera start (5-5): boots the worker + WASM
   * with a 1×1 detect-only job so init overlaps viewfinder startup
   * instead of the first live tick / shutter press. Generation-guarded
   * like every other continuation (a reset before completion drops the
   * result), errors swallowed (warmup never surfaces UI state), and one
   * shot per session generation (repeat calls are no-ops). Touches no
   * review state: `processing` stays false, `pending` stays null.
   */
  const warm = useCallback(() => {
    const gen = genRef.current;
    if (warmedGenRef.current === gen) return;
    warmedGenRef.current = gen;
    void (async () => {
      try {
        // Fresh exact-range copy: process() transfers (neuters) its
        // input, and the module-level payload must stay intact for the
        // next session's warmup.
        const result = await client().process(WARMUP_PNG.slice(), CORE_MODE, true);
        if (genRef.current !== gen) return; // Stale: drop silently.
        void result;
      } catch {
        // Warmup is best-effort: the first real job retries init.
      }
    })();
  }, []);

  /**
   * Debounced verify preview (CropEditor release / 300ms idle): re-warps
   * a ≤800px downscale of the original with the adjusted quad and shows
   * the result beside the overlay. Best-effort and latest-wins: failures
   * or superseded responses leave the overlay authoritative. Full
   * resolution crosses the worker only on Confirm.
   */
  const requestVerifyPreview = useCallback((quad: ScanCorner[]) => {
    const review = pendingRef.current;
    if (review === null || review.result.status !== 'processed' || quad.length !== 4) return;
    if (!verifyOpenRef.current) return;
    const worker = clientRef.current;
    // No worker (reset raced the debounce): no preview, overlay only.
    if (worker === null) return;
    const rewrap = rewrapOf(worker);
    const token = (previewTokenRef.current += 1);
    const gen = genRef.current;
    setVerifyPreviewPending(true);
    void (async () => {
      try {
        const scaled = await downscaleForPreview(review.original, review.result, quad);
        if (
          scaled === null ||
          previewTokenRef.current !== token ||
          genRef.current !== gen ||
          !verifyOpenRef.current
        ) {
          return;
        }
        const out = await rewrap(scaled.bytes, scaled.quad);
        if (previewTokenRef.current !== token || genRef.current !== gen || !verifyOpenRef.current) {
          return;
        }
        const url = URL.createObjectURL(
          new Blob([out.bytes as unknown as BlobPart], { type: 'image/jpeg' }),
        );
        const prev = verifyPreviewUrlRef.current;
        verifyPreviewUrlRef.current = url;
        setVerifyPreviewUrl(url);
        if (prev !== null) URL.revokeObjectURL(prev);
      } catch {
        // Preview is best-effort: the overlay stays authoritative.
      } finally {
        if (previewTokenRef.current === token && genRef.current === gen) {
          setVerifyPreviewPending(false);
        }
      }
    })();
  }, []);

  /**
   * Verify Cancel/Back: returns to the existing review panel with the
   * auto result untouched (Cancel is disabled while Confirm is in
   * flight, so no race with the rewarp continuation).
   */
  const cancelVerify = useCallback(() => {
    previewTokenRef.current += 1;
    setVerifyPreviewPending(false);
    revokeVerifyPreview();
    setVerifyOpen(false);
  }, [revokeVerifyPreview]);

  /**
   * Verify Confirm: re-warps the FULL-RES original with the adjusted
   * quad and replaces the pending processed bytes, then drops into the
   * existing review panel (unchanged semantics). Any failure — worker
   * error, glue refusal, timeout — keeps the untouched auto result and
   * still lands on the review. Generation-guarded like every other
   * continuation.
   */
  const confirmVerify = useCallback(
    (quad: ScanCorner[]) => {
      const review = pendingRef.current;
      if (review === null || review.result.status !== 'processed' || quad.length !== 4) return;
      const worker = clientRef.current;
      if (worker === null) {
        // Worker gone (reset raced Confirm): keep the auto result.
        cancelVerify();
        return;
      }
      const rewrap = rewrapOf(worker);
      const gen = genRef.current;
      previewTokenRef.current += 1;
      setVerifyPreviewPending(false);
      setRewrapping(true);
      void (async () => {
        try {
          // Fresh exact-range bytes: transfer neuters the buffer, so the
          // retained original File is re-read (never a shared view).
          const bytes = new Uint8Array(await review.original.arrayBuffer());
          if (genRef.current !== gen) return;
          const quadCopy = quad.map((p) => ({ x: p.x, y: p.y }));
          const out = await withTimeout(rewrap(bytes, quadCopy), REWRAP_TIMEOUT_MS);
          if (genRef.current !== gen) return;
          const current = pendingRef.current;
          if (current === null) return;
          const url = URL.createObjectURL(
            new Blob([out.bytes as unknown as BlobPart], { type: 'image/jpeg' }),
          );
          URL.revokeObjectURL(current.previewUrl);
          setPending({
            original: current.original,
            previewUrl: url,
            result: {
              ...current.result,
              bytes: out.bytes,
              width: out.width,
              height: out.height,
              corners: quadCopy,
            },
          });
        } catch {
          // Rewarp failure keeps the auto result — verify still closes
          // and the existing review shows what detection produced.
        } finally {
          // Stale (reset/discarded mid-flight): cleanup already ran.
          if (genRef.current === gen) closeVerify();
        }
      })();
    },
    [cancelVerify, closeVerify],
  );

  return {
    processing,
    pending,
    liveDetected,
    processCapture,
    accept,
    discard,
    requestLive,
    reset,
    warm,
    verifyOpen,
    verifyPreviewUrl,
    verifyPreviewPending,
    rewrapping,
    requestVerifyPreview,
    confirmVerify,
    cancelVerify,
  };
}
