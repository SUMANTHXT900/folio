/**
 * Scan processor hook: capture → REVIEW QUEUE for the document
 * scanner.
 *
 * Capture is queue-only (2026-10-02 follow-up user feedback: "let it
 * take its own time but get accurate results, process in background
 * while the user captures"). The shutter enqueues a capture INSTANTLY —
 * capture-order id, original File handle, preview URL of the original,
 * `state: 'queued'`, dims placeholder — and returns: NO worker call, no
 * decode, no waiting between shots. A single background drainer then
 * processes entries ONE at a time, in capture order: `queued` →
 * `processing` → `ready` (real detect metadata lands with `ready`; a
 * worker failure settles `ready` with `status: 'error'` + null corners,
 * so the shot stays a croppable photo — never lost). Captures taken
 * during a drain queue behind the active job; the camera stays live.
 *
 * The queue is reviewed later, ONE page at a time, in the full-screen
 * review queue (see `CropEditor.tsx`): "Use crop" (full-res rewrap →
 * commit processed page), "Use original" (commit as photo), "Discard"
 * (drop). Unreviewed entries at any scanner exit commit as originals.
 *
 * Owns NO pixels in React state — only handles, URLs, and result
 * metadata. The queue never holds decoded bytes: processed output bytes
 * are dropped after metadata extraction; every committed page is rebuilt
 * from the retained original File (rewrap) or committed as that File.
 * One `ScanWorkerClient` per hook instance (lazy WASM load on first
 * background drain — or earlier via `warm()` at camera start, so init
 * overlaps viewfinder startup — terminated on reset/unmount).
 *
 * Generation safety: every async continuation checks the session
 * generation (and an alive flag on unmount). `reset()` (Done / unmount /
 * camera switch with `keepQueue`) bumps it, invalidates the drainer
 * token, and terminates the worker — stale results are dropped before
 * they can settle entries, replace previews, or resurrect sessions. A
 * `keepQueue` reset returns in-flight entries to `queued` so the fresh
 * session reprocesses them instead of stranding them mid-`processing` —
 * rapid captures queue EVERY capture in order (never latest-wins: the
 * queue is the review backlog).
 *
 * Live detection: `requestLive()` sends the LATEST frame only through
 * the detect-only path (status `detected`, no warp/encode, no bytes);
 * calls while a live request is in flight are skipped (no queue of stale
 * frames). Live ticks YIELD to capture processing: while any entry is
 * queued/processing, ticks are skipped so the single worker drains the
 * capture backlog at full speed; guidance resumes when every entry is
 * `ready`. Live corners are guidance ONLY — the shutter always runs a
 * fresh full-resolution detection.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScanWorkerClient,
  type ScanCorner,
  type ScanRewrapResult,
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

/**
 * Detect metadata for a queued capture. Deliberately slimmer than
 * `ScanResult`: NO output bytes (memory discipline — the queue holds
 * File handles + metadata only) and the width/height are the FULL-RES
 * CAPTURE pixel dims (the quad coordinate space for rewrap), never the
 * worker's warp-output dims.
 */
export interface ScanEntryMeta {
  /** Pipeline verdict for the capture (`detected` is live-only). */
  status: 'processed' | 'original' | 'error';
  /** Full-res capture pixel dims — the quad coordinate space. */
  width: number;
  height: number;
  /** Auto-detected corners in capture pixels (processed only). */
  corners: ScanCorner[] | null;
}

/** One unreviewed capture in the review queue. */
export interface ScanQueueEntry {
  id: number;
  /** Original full-res capture (File handle — never decoded into state). */
  original: File;
  /** Object URL of the original photo (strip thumb + queue page). */
  previewUrl: string;
  /**
   * Background processing state (frozen contract for the review UI):
   * `queued` — captured, waiting behind the active job (or the drainer
   * hasn't picked it up yet); `processing` — its worker job is the ONE
   * active job; `ready` — settled, `meta` is meaningful NOW. At most one
   * entry is `processing` at a time; queue order is capture order.
   */
  state: 'queued' | 'processing' | 'ready';
  /** Detect metadata — a dims placeholder until `state === 'ready'`. */
  meta: ScanEntryMeta;
}

/** A queue decision resolved into a page-collection commit. */
export interface ScanCommit {
  file: File;
  /** Pre-scan capture to retain (cropped commits only). */
  original: File | null;
  name: string;
}

/** "Use crop" outcome: `applied` is false when the rewrap failed and the photo committed instead. */
export interface CropOutcome {
  commit: ScanCommit;
  applied: boolean;
}

/**
 * Crop-verify rewarp plumbing (Agent B contract, consumed directly):
 * `client.rewrapScan(original, quad)` re-warps the full-res capture with
 * an operator-adjusted quad in full-res capture pixel coords and resolves
 * `{bytes, width, height}`; it rejects when the glue refuses the quad.
 * Both call sites treat rejection as "commit the photo" (never a lost
 * page).
 */
type RewrapScanFn = (original: Uint8Array, quad: ScanCorner[]) => Promise<ScanRewrapResult>;

function rewrapOf(client: ScanWorkerClient): RewrapScanFn {
  return client.rewrapScan.bind(client);
}

/**
 * Preview budget: debounced queue previews are downscaled to ≤1600px on
 * the long edge (raised from 800, 2026-10-03 quality pass — the review
 * hero must look near-final, not mushy); full resolution crosses the
 * worker only on "Use crop".
 */
const VERIFY_PREVIEW_LONG_EDGE = 1600;
/** Preview encode quality: near-final look for the review hero. */
const VERIFY_PREVIEW_JPEG_QUALITY = 0.9;
/** "Use crop" never hangs the queue: a slow rewarp falls back to the photo. */
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
 * downscaled space. `dims` is the capture pixel space (the quad space —
 * NOT the worker's warp-output dims). Returns null when decode/encode is
 * unavailable — the preview is best-effort, the overlay stays
 * authoritative.
 */
async function downscaleForPreview(
  original: File,
  dims: { width: number; height: number },
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
    // Quad space is the capture pixel space; the decoded bitmap is the
    // same frame, mapped defensively in case dims ever report a
    // different stage.
    const toBitmapX = dims.width > 0 ? srcW / dims.width : 1;
    const toBitmapY = dims.height > 0 ? srcH / dims.height : 1;
    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(bitmap, 0, 0, dstW, dstH);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', VERIFY_PREVIEW_JPEG_QUALITY),
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

export function useScanProcessor(createWorker?: ScanWorkerFactory) {
  const clientRef = useRef<ScanWorkerClient | null>(null);
  const genRef = useRef(0);
  const aliveRef = useRef(true);
  const livePendingRef = useRef(false);
  const warmedGenRef = useRef(-1);
  const [processing, setProcessing] = useState(false);
  // Sequential drainer ownership: `drainingRef` = a loop is active;
  // `drainSeqRef` = token that invalidates a loop across reset/unmount
  // (a stale loop may never settle an entry or clear `processing`).
  const drainingRef = useRef(false);
  const drainSeqRef = useRef(0);
  const [queued, setQueued] = useState<ScanQueueEntry[]>([]);
  // The queue's imperative source of truth: mutations happen in event
  // handlers and async continuations, and follow-up calls (commit →
  // advance → exit drain) run BEFORE React re-renders. A render-lagged
  // ref mirror would make `drainQueue()` re-commit an entry that
  // `useOriginal` had already committed (E2E-caught double page). So
  // every mutation updates the ref SYNCHRONOUSLY and state mirrors it
  // for rendering. Never mutated inside a state updater (StrictMode
  // double-invokes those).
  const queuedRef = useRef<ScanQueueEntry[]>([]);
  const commitQueued = useCallback((next: ScanQueueEntry[]) => {
    queuedRef.current = next;
    setQueued(next);
  }, []);
  const [liveDetected, setLiveDetected] = useState(false);
  const nextIdRef = useRef(1);

  // Debounced crop preview (queue-page scoped): latest-wins token, one
  // preview URL at a time, invalidated on page advance / commit / exit.
  const [cropPreviewUrl, setCropPreviewUrl] = useState<string | null>(null);
  const [cropPreviewPending, setCropPreviewPending] = useState(false);
  const [applying, setApplying] = useState(false);
  const cropPreviewUrlRef = useRef<string | null>(null);
  cropPreviewUrlRef.current = cropPreviewUrl;
  const previewTokenRef = useRef(0);

  const client = (): ScanWorkerClient => {
    if (clientRef.current === null) {
      clientRef.current =
        createWorker === undefined ? new ScanWorkerClient() : new ScanWorkerClient(createWorker);
    }
    return clientRef.current;
  };

  /** Releases the debounced preview URL (queue-page scoped). */
  const revokeCropPreview = useCallback(() => {
    previewTokenRef.current += 1;
    setCropPreviewPending(false);
    if (cropPreviewUrlRef.current !== null) {
      URL.revokeObjectURL(cropPreviewUrlRef.current);
      cropPreviewUrlRef.current = null;
      setCropPreviewUrl(null);
    }
  }, []);

  /** Removes one entry and revokes its preview URL (advance/discard). */
  const removeEntry = useCallback(
    (id: number) => {
      const entry = queuedRef.current.find((e) => e.id === id);
      if (entry !== undefined) URL.revokeObjectURL(entry.previewUrl);
      commitQueued(queuedRef.current.filter((e) => e.id !== id));
      revokeCropPreview();
    },
    [commitQueued, revokeCropPreview],
  );

  /** Drops every entry (queue exit / full reset), revoking all preview URLs. */
  const clearQueue = useCallback(() => {
    for (const entry of queuedRef.current) URL.revokeObjectURL(entry.previewUrl);
    commitQueued([]);
    revokeCropPreview();
  }, [commitQueued, revokeCropPreview]);

  /**
   * Sequential background drainer: processes queued captures ONE worker
   * job at a time, in capture order. `queued → processing` before the
   * job; the result settles the entry `ready` with real metadata (quad
   * space = the entry's capture dims, never warp-output dims). Worker
   * failures settle `ready` with `status: 'error'` + null corners — the
   * capture stays a croppable photo, never a lost shot. A capture
   * enqueued mid-drain is picked up by the running loop; concurrent
   * drains are impossible (token-owned). `reset()`/unmount invalidate
   * the token, so a stale loop can neither settle entries nor clear
   * `processing`; every continuation after an await re-checks the
   * generation + alive guards and returns silently when superseded.
   */
  const drainPending = useCallback(async () => {
    if (drainingRef.current) return;
    const token = (drainSeqRef.current += 1);
    drainingRef.current = true;
    // `processing` === drainer busy (UI progress / live-tick gate).
    setProcessing(true);
    try {
      while (aliveRef.current && drainSeqRef.current === token) {
        const entry = queuedRef.current.find((e) => e.state === 'queued');
        if (entry === undefined) break;
        const gen = genRef.current;
        commitQueued(
          queuedRef.current.map((e) =>
            e.id === entry.id ? { ...e, state: 'processing' as const } : e,
          ),
        );
        let meta: ScanEntryMeta;
        try {
          const bytes = new Uint8Array(await entry.original.arrayBuffer());
          if (!aliveRef.current || genRef.current !== gen) return; // Stale: drop silently.
          const result = await client().process(bytes, CORE_MODE);
          if (!aliveRef.current || genRef.current !== gen) return; // Stale: drop silently.
          meta = {
            status:
              result.status === 'processed' || result.status === 'original'
                ? result.status
                : 'error',
            // Quad space is the CAPTURE pixel space (the entry's
            // placeholder dims). The worker reports warp-OUTPUT dims on
            // processed results — never seed the quad from those.
            width: entry.meta.width > 0 ? entry.meta.width : result.width,
            height: entry.meta.height > 0 ? entry.meta.height : result.height,
            corners: result.corners,
          };
        } catch {
          // Worker failure: the capture still settles as a croppable
          // photo (error metadata → 90% inset seed), never a lost shot.
          if (!aliveRef.current || genRef.current !== gen) return; // Stale: drop silently.
          meta = {
            status: 'error',
            width: entry.meta.width,
            height: entry.meta.height,
            corners: null,
          };
        }
        commitQueued(
          queuedRef.current.map((e) =>
            e.id === entry.id ? { ...e, state: 'ready' as const, meta } : e,
          ),
        );
      }
    } finally {
      // Only the owning (non-invalidated) loop clears the busy flag: a
      // reset-started drainer must not be stopped by a stale finally.
      if (drainSeqRef.current === token) {
        drainingRef.current = false;
        if (aliveRef.current) setProcessing(false);
      }
    }
  }, [commitQueued]);

  /**
   * Invalidates the session: stale results dropped, worker terminated.
   * `keepQueue` preserves already-queued captures across a camera switch
   * (the shots survive the hardware restart; in-flight jobs die and
   * their entries go back to `queued` for the fresh session).
   */
  const reset = useCallback(
    (opts?: { keepQueue?: boolean }) => {
      genRef.current += 1;
      livePendingRef.current = false;
      warmedGenRef.current = -1;
      // Invalidate any running drain loop: its continuations belong to
      // the dead generation and must neither settle entries nor touch
      // `processing`. The drainer below (keepQueue) owns a fresh token.
      drainSeqRef.current += 1;
      drainingRef.current = false;
      setProcessing(false);
      setApplying(false);
      setLiveDetected(false);
      if (opts?.keepQueue !== true) {
        clearQueue();
      } else {
        // Camera switch: queued shots survive, in-flight jobs die with
        // the worker. An entry caught mid-`processing` returns to
        // `queued` so the fresh session reprocesses it instead of
        // stranding it forever; `ready` entries are already settled.
        commitQueued(
          queuedRef.current.map((e) =>
            e.state === 'ready' ? e : { ...e, state: 'queued' as const },
          ),
        );
        revokeCropPreview();
      }
      try {
        clientRef.current?.terminate();
      } catch {
        // Best effort.
      }
      clientRef.current = null;
      if (opts?.keepQueue === true && queuedRef.current.some((e) => e.state === 'queued')) {
        void drainPending();
      }
    },
    [clearQueue, commitQueued, drainPending, revokeCropPreview],
  );

  // Alive flag: guards post-unmount continuations. It MUST be restored
  // on mount — React StrictMode double-invokes effects (mount → cleanup
  // → mount), so a cleanup-only flag would stay dead forever and every
  // queued capture would be silently dropped (real bug, E2E-caught).
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      genRef.current += 1;
      // Silently kill the drainer loop: the queue is cleared below, and
      // the token bump keeps a stale finally from touching state.
      drainSeqRef.current += 1;
      drainingRef.current = false;
      clearQueue();
      try {
        clientRef.current?.terminate();
      } catch {
        // Best effort.
      }
      clientRef.current = null;
    };
  }, [clearQueue]);

  /**
   * Shutter path — INSTANT. Queues the capture synchronously (capture-
   * order id, original File handle, preview URL, capture dims
   * placeholder) and kicks the background drainer; no worker call, no
   * decode, no waiting ever sits between the shutter and the next shot.
   * The drainer fills in real metadata later.
   */
  const enqueueCapture = useCallback(
    (original: File, dims: { width: number; height: number }) => {
      // Capture-order id assigned at shutter time: the queue (and strip)
      // stay in shooting order regardless of how long each job takes.
      const id = nextIdRef.current++;
      commitQueued(
        [
          ...queuedRef.current,
          {
            id,
            original,
            previewUrl: URL.createObjectURL(original),
            state: 'queued' as const,
            // Placeholder: the dims are already the quad space; `meta`
            // is meaningful only once `state === 'ready'` (error-shaped
            // seed so an accidental early read draws the 90% inset
            // rather than crashing).
            meta: {
              status: 'error' as const,
              width: dims.width,
              height: dims.height,
              corners: null,
            },
          },
        ].sort((a, b) => a.id - b.id),
      );
      void drainPending();
    },
    [commitQueued, drainPending],
  );

  /**
   * "Use crop": re-warps the FULL-RES original with the operator quad
   * and commits the processed page (original retained per scanStore
   * rules). Any failure — worker error, glue refusal, timeout — commits
   * the photo instead (never a lost page) with `applied: false`.
   * Generation-guarded like every other continuation.
   */
  const useCrop = useCallback(
    async (id: number, quad: ScanCorner[]): Promise<CropOutcome | null> => {
      const entry = queuedRef.current.find((e) => e.id === id);
      if (entry === undefined || quad.length !== 4) return null;
      const worker = clientRef.current;
      if (worker === null) {
        // Worker gone (reset raced the action): commit the photo.
        removeEntry(id);
        return {
          commit: { file: entry.original, original: null, name: entry.original.name },
          applied: false,
        };
      }
      const rewrap = rewrapOf(worker);
      const gen = genRef.current;
      revokeCropPreview();
      setApplying(true);
      try {
        // Fresh exact-range bytes: transfer neuters the buffer, so the
        // retained original File is re-read (never a shared view).
        const bytes = new Uint8Array(await entry.original.arrayBuffer());
        if (genRef.current !== gen) return null;
        const quadCopy = quad.map((p) => ({ x: p.x, y: p.y }));
        const out = await withTimeout(rewrap(bytes, quadCopy), REWRAP_TIMEOUT_MS);
        if (genRef.current !== gen) return null;
        removeEntry(id);
        return {
          commit: {
            file: new File([out.bytes as unknown as BlobPart], entry.original.name, {
              type: 'image/jpeg',
            }),
            original: entry.original,
            name: entry.original.name,
          },
          applied: true,
        };
      } catch {
        if (genRef.current !== gen) return null;
        removeEntry(id);
        return {
          commit: { file: entry.original, original: null, name: entry.original.name },
          applied: false,
        };
      } finally {
        setApplying(false);
      }
    },
    [removeEntry, revokeCropPreview],
  );

  /**
   * "Use original": commits the capture as a photo (nothing retained —
   * the page IS the original) and advances.
   */
  const useOriginal = useCallback(
    (id: number): ScanCommit | null => {
      const entry = queuedRef.current.find((e) => e.id === id);
      if (entry === undefined) return null;
      removeEntry(id);
      return { file: entry.original, original: null, name: entry.original.name };
    },
    [removeEntry],
  );

  /** "Discard": drops the capture and advances. */
  const discardEntry = useCallback(
    (id: number): void => {
      removeEntry(id);
    },
    [removeEntry],
  );

  /**
   * Queue exit (back arrow / scanner leave): every unreviewed entry
   * commits as its original photo, in capture order. Synchronous by
   * construction — captures are already budget-clamped JPEGs on the
   * capture canvas (≤`SCAN_CAPTURE_LONG_EDGE`, see `captureTargetDims`
   * in CameraCapture.tsx), so the import normalization skip path always
   * applied to them. Preview URLs are revoked; entries are gone.
   */
  const drainQueue = useCallback((): ScanCommit[] => {
    const commits = queuedRef.current.map((e) => ({
      file: e.original,
      original: null,
      name: e.original.name,
    }));
    clearQueue();
    return commits;
  }, [clearQueue]);

  /**
   * Debounced crop preview (CropEditor release / 300ms idle): re-warps a
   * ≤1600px downscale of the original with the adjusted quad and shows
   * the result beside the overlay. Best-effort and latest-wins: failures
   * or superseded responses leave the overlay authoritative. Full
   * resolution crosses the worker only on "Use crop".
   */
  const requestCropPreview = useCallback((id: number, quad: ScanCorner[]) => {
    const entry = queuedRef.current.find((e) => e.id === id);
    if (entry === undefined || quad.length !== 4) return;
    const worker = clientRef.current;
    // No worker (reset raced the debounce): no preview, overlay only.
    if (worker === null) return;
    const rewrap = rewrapOf(worker);
    const token = (previewTokenRef.current += 1);
    const gen = genRef.current;
    setCropPreviewPending(true);
    void (async () => {
      try {
        const scaled = await downscaleForPreview(entry.original, entry.meta, quad);
        if (
          scaled === null ||
          previewTokenRef.current !== token ||
          genRef.current !== gen ||
          !queuedRef.current.some((e) => e.id === id)
        ) {
          return;
        }
        const out = await rewrap(scaled.bytes, scaled.quad);
        if (
          previewTokenRef.current !== token ||
          genRef.current !== gen ||
          !queuedRef.current.some((e) => e.id === id)
        ) {
          return;
        }
        const url = URL.createObjectURL(
          new Blob([out.bytes as unknown as BlobPart], { type: 'image/jpeg' }),
        );
        const prev = cropPreviewUrlRef.current;
        cropPreviewUrlRef.current = url;
        setCropPreviewUrl(url);
        if (prev !== null) URL.revokeObjectURL(prev);
      } catch {
        // Preview is best-effort: the overlay stays authoritative.
      } finally {
        if (previewTokenRef.current === token && genRef.current === gen) {
          setCropPreviewPending(false);
        }
      }
    })();
  }, []);

  /**
   * Latest-frame live detection tick. Skipped while a live request is in
   * flight — never queued. Capture processing has PRIORITY: while any
   * entry is queued/processing, ticks are skipped entirely so the single
   * worker drains the capture backlog at full speed; guidance resumes
   * once every entry is `ready`. Best-effort by design.
   */
  const requestLive = useCallback((frame: Blob) => {
    if (livePendingRef.current) return;
    if (queuedRef.current.some((e) => e.state !== 'ready')) return;
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
   * queue state.
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

  return {
    processing,
    queued,
    liveDetected,
    enqueueCapture,
    useCrop,
    useOriginal,
    discardEntry,
    drainQueue,
    cropPreviewUrl,
    cropPreviewPending,
    applying,
    requestCropPreview,
    requestLive,
    reset,
    warm,
  };
}
