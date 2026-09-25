/**
 * Scan processor hook: capture → worker → review state machine for the
 * document scanner (M3).
 *
 * Owns NO pixels in React state — only handles, URLs, and result
 * metadata. One `ScanWorkerClient` per hook instance (lazy WASM load on
 * first processing request, terminated on reset/unmount).
 *
 * Generation safety: every async continuation checks the session
 * generation. `reset()` (Done / unmount / camera switch) bumps it and
 * terminates the worker — stale results are dropped before they can
 * create pages, replace previews, or resurrect sessions. Rapid captures
 * discard the previous pending review (latest wins).
 *
 * Live detection: `requestLive()` sends the LATEST frame only; calls
 * while a live request, capture scan, or review is active are skipped
 * (no queue of stale frames). Live corners are guidance ONLY — the
 * shutter always runs a fresh full-resolution detection.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScanWorkerClient, type ScanResult, type ScanWorkerFactory } from './scanWorkerClient';

/**
 * The hardened scanner has ONE capture experience (product decision):
 * document scans in normal color. There is no UI mode selector — the
 * core pipeline mode is fixed at the color path (`CORE_MODE`).
 */
const CORE_MODE = 'original' as const;

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
        const result = await client().process(bytes, 'original');
        if (genRef.current !== gen) return;
        setLiveDetected(result.status === 'processed' && result.corners !== null);
      } catch {
        if (genRef.current === gen) setLiveDetected(false);
      } finally {
        livePendingRef.current = false;
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
  };
}
