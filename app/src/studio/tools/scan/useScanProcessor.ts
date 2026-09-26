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
import { ScanWorkerClient, type ScanResult, type ScanWorkerFactory } from './scanWorkerClient';

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

  /** Invalidates the session: stale results dropped, worker terminated. */
  const reset = useCallback(() => {
    genRef.current += 1;
    livePendingRef.current = false;
    warmedGenRef.current = -1;
    revokePending(pendingRef.current);
    setPending(null);
    setProcessing(false);
    setLiveDetected(false);
    try {
      clientRef.current?.terminate();
    } catch {
      // Best effort.
    }
    clientRef.current = null;
  }, [revokePending]);

  useEffect(() => {
    return () => {
      genRef.current += 1;
      revokePending(pendingRef.current);
      try {
        clientRef.current?.terminate();
      } catch {
        // Best effort.
      }
      clientRef.current = null;
    };
  }, [revokePending]);

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
    [revokePending],
  );

  /** Accepts the review: returns files for the page collection. */
  const accept = useCallback(
    (useProcessed: boolean): AcceptedScan | null => {
      const review = pendingRef.current;
      if (review === null) return null;
      revokePending(review);
      setPending(null);
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
    [revokePending],
  );

  /** Discards the pending review (Retake): accepted pages untouched. */
  const discard = useCallback(() => {
    revokePending(pendingRef.current);
    setPending(null);
  }, [revokePending]);

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
  };
}
