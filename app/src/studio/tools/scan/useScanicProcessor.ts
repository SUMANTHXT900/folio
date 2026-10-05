/**
 * Capture-queue processor for the scanic scanner (main thread) — the
 * "shutter is a queue" model (D34).
 *
 * `enqueueCapture(file)` is INSTANT: it stores the ORIGINAL File handle and
 * an object URL of the original, appends a `queued` entry, and returns —
 * no decode, no worker call, no waiting between shots. A single background
 * drainer then processes entries ONE at a time in capture order:
 *
 * ```text
 * queued → processing → ready
 * ```
 *
 * For each entry: decode an in-memory ImageData COPY of the original (the
 * original File bytes are never resized or recompressed), detect with
 * scanic, and — when a document quad was found — decode a fresh copy and
 * warp it full-resolution through the worker, exposing the lossless PNG as
 * `warpedUrl`. An entry whose detection found no document settles with
 * `corners: null`, `warpedUrl: null`; a failure settles with `error` set.
 * Either way the ORIGINAL `file`/`photoUrl` stay available, so a capture is
 * never lost.
 *
 * Lifecycle rules:
 * - StrictMode-safe: the mount effect restores `aliveRef` on every setup
 *   (mount → cleanup → mount), and the cleanup only flips the flag — it
 *   NEVER clears the queue or revokes URLs (`keepQueue`), so a remount
 *   resumes the drain instead of dropping shots. The consumer owns final
 *   URL teardown when the capture flow truly ends.
 * - Every async continuation re-checks `aliveRef`; a stale continuation
 *   requeues the entry it was working on so a revived drainer picks it up.
 * - State mutations happen outside React updaters (updaters double-invoke
 *   under StrictMode); `recordsRef` is the synchronous source of truth and
 *   `entries` is its published snapshot.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScanicClient } from './scanicClient';
import type { ScanicCorners, ScanicDetectorKind } from './scanicProtocol';

export type ScanicEntryPhase = 'queued' | 'processing' | 'ready';

/** One capture in the processing queue. */
export interface ScanicEntry {
  /** Capture-order id (`scan-1`, `scan-2`, …). */
  id: string;
  /** ORIGINAL File handle — bytes are never resized or re-encoded here. */
  file: File;
  /** Object URL of the original file. */
  photoUrl: string;
  /** Full-resolution decoded dims — the corner coordinate space. */
  imageWidth: number | null;
  imageHeight: number | null;
  /** Detected quad in full-resolution pixels; null when none was found. */
  corners: ScanicCorners | null;
  /** Lossless PNG object URL of the warp output; null when not warped. */
  warpedUrl: string | null;
  /** `ready` means settled (processed, no-document, or failed — see `error`). */
  phase: ScanicEntryPhase;
  /**
   * Detector behind the settled result: the backend that produced `corners`,
   * or — when none were found — the backend that made the final attempt.
   * Null while queued/processing or when processing failed before detection.
   */
  detector: ScanicDetectorKind | null;
  /** Failure message when processing failed; null otherwise. */
  error: string | null;
}

/**
 * Test/platform seams. Every field defaults to the real implementation;
 * production callers pass nothing. `detector` is read at PROCESS time, so a
 * detector override takes effect for captures still queued or processing;
 * when omitted, the client resolves the policy default (ML, D46).
 */
export interface ScanicProcessorOptions {
  /** Defaults to a fresh `ScanicClient` owned by this hook instance. */
  client?: ScanicClient;
  /** Explicit detection backend override; omitted = ML (D46: ML only). */
  detector?: ScanicDetectorKind;
  /** Decodes an ORIGINAL File into a full-resolution ImageData copy. */
  decode?: (file: File) => Promise<ImageData>;
  /** Encodes warp output to a lossless PNG blob. */
  encodePng?: (image: ImageData) => Promise<Blob>;
}

export interface ScanicProcessor {
  /** Queue snapshot in capture order (the render source; reference only). */
  entries: ScanicEntry[];
  /** Queues one captured photo; returns immediately (never decodes). */
  enqueueCapture: (file: File) => void;
  /** Entries whose processing has settled. */
  readyCount: number;
  /**
   * Waits until the background queue is fully drained (including work
   * enqueued while waiting) and resolves with the entries snapshot in
   * capture order. Ready entries carry `corners`/`warpedUrl`; the consumer
   * decides which are warped scans and which fall back to the original.
   */
  buildNow: () => Promise<ScanicEntry[]>;
}

function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function isOffscreenCanvas(canvas: OffscreenCanvas | HTMLCanvasElement): canvas is OffscreenCanvas {
  return typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas;
}

/**
 * Default decode: `createImageBitmap` + a 2D canvas read into ImageData at
 * the bitmap's natural (full) resolution. The bitmap is released in a
 * `finally`; the returned ImageData is a pixel COPY independent of the
 * original File.
 */
async function decodeFileToImageData(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = createCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true }) as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (context === null) {
      throw new Error('2D canvas unavailable for scan decode');
    }
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** Default encode: warp ImageData → PNG (lossless), off the JPEG path. */
async function encodeImageDataToPng(image: ImageData): Promise<Blob> {
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d') as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (context === null) {
    throw new Error('2D canvas unavailable for scan encode');
  }
  context.putImageData(image, 0, 0);
  if (isOffscreenCanvas(canvas)) {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error('scan PNG encode failed')) : resolve(blob)),
      'image/png',
    );
  });
}

export function useScanicProcessor(options: ScanicProcessorOptions = {}): ScanicProcessor {
  // Construction-time seam capture: the client owns its lazy worker; the
  // decode/encode functions are platform capabilities.
  const [seams] = useState(() => ({
    client: options.client ?? new ScanicClient(),
    decode: options.decode ?? decodeFileToImageData,
    encodePng: options.encodePng ?? encodeImageDataToPng,
  }));

  // Latest detector override (undefined = ML-first policy) without
  // re-creating the drainer; read at process time for every capture.
  const detectorRef = useRef<ScanicDetectorKind | undefined>(options.detector);
  useEffect(() => {
    detectorRef.current = options.detector;
  });

  // Synchronous source of truth; `entries` is its published snapshot.
  const recordsRef = useRef<ScanicEntry[]>([]);
  const [entries, setEntries] = useState<ScanicEntry[]>([]);
  const queueRef = useRef<string[]>([]);
  const drainPromiseRef = useRef<Promise<void> | null>(null);
  const aliveRef = useRef(true);
  const nextIdRef = useRef(0);

  const publish = useCallback(() => {
    setEntries(recordsRef.current.slice());
  }, []);

  const patch = useCallback(
    (id: string, changes: Partial<ScanicEntry>) => {
      const records = recordsRef.current;
      const index = records.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      records[index] = { ...records[index], ...changes };
      publish();
    },
    [publish],
  );

  /**
   * Processes one entry to `ready`. Returns `'requeued'` when the component
   * went away mid-flight (the caller keeps the id at the queue front so a
   * StrictMode remount resumes it); every other outcome is `'done'`.
   */
  const processEntry = useCallback(
    async (id: string): Promise<'done' | 'requeued'> => {
      const record = recordsRef.current.find((entry) => entry.id === id);
      if (record === undefined) return 'done';
      patch(id, { phase: 'processing', error: null });
      const stale = () => !aliveRef.current;
      try {
        // Detection copy: decoded from the original File, consumed by the
        // transfer inside `detect` (the ImageData is neutered on send).
        const detectionImage = await seams.decode(record.file);
        if (stale()) return 'requeued';
        patch(id, { imageWidth: detectionImage.width, imageHeight: detectionImage.height });
        const detection = await seams.client.detect(detectionImage, detectorRef.current);
        if (stale()) return 'requeued';
        if (!detection.success || detection.corners === null) {
          patch(id, {
            phase: 'ready',
            corners: null,
            warpedUrl: null,
            detector: detection.detector,
          });
          return 'done';
        }
        const corners = detection.corners;
        // Extraction copy: the detection copy was transferred (neutered),
        // so a freshly decoded full-res copy feeds the warp.
        const fullImage = await seams.decode(record.file);
        if (stale()) return 'requeued';
        const warped = await seams.client.extract(fullImage, corners);
        if (stale()) return 'requeued';
        const png = await seams.encodePng(warped);
        if (stale()) return 'requeued';
        patch(id, {
          phase: 'ready',
          corners,
          warpedUrl: URL.createObjectURL(png),
          detector: detection.detector,
        });
        return 'done';
      } catch (error) {
        if (stale()) return 'requeued';
        // Settle as ready with the failure recorded: the original File and
        // photoUrl remain, so the capture commits as a photo, never lost.
        patch(id, {
          phase: 'ready',
          error: error instanceof Error ? error.message : 'scan processing failed',
        });
        return 'done';
      }
    },
    [patch, seams],
  );

  const drain = useCallback(async (): Promise<void> => {
    while (aliveRef.current) {
      const id = queueRef.current[0];
      if (id === undefined) break;
      const outcome = await processEntry(id);
      if (outcome === 'done') {
        queueRef.current.shift();
        continue;
      }
      // Unmounted mid-entry: keep the id at the front for a remount and
      // stop this loop (do not spin while dead).
      patch(id, { phase: 'queued' });
      break;
    }
  }, [patch, processEntry]);

  /**
   * Serializes the drainer: concurrent calls join the active run. When a run
   * ends and live work remains (a StrictMode remount revived the loop after
   * a requeue, or an enqueue raced the shutdown), it restarts transparently.
   */
  const pump = useCallback((): Promise<void> => {
    const active = drainPromiseRef.current;
    if (active !== null) {
      return active;
    }
    const run = drain();
    drainPromiseRef.current = run;
    const clear = () => {
      if (drainPromiseRef.current !== run) return;
      drainPromiseRef.current = null;
      if (aliveRef.current && queueRef.current.length > 0) {
        void pump();
      }
    };
    run.then(clear, clear);
    return run;
  }, [drain]);

  // Mount lifecycle: restore `aliveRef` on every setup (StrictMode) and stop
  // new work on cleanup. keepQueue: no queue clearing, no URL revocation.
  useEffect(() => {
    aliveRef.current = true;
    void pump();
    return () => {
      aliveRef.current = false;
    };
  }, [pump]);

  const enqueueCapture = useCallback(
    (file: File): void => {
      const id = `scan-${(nextIdRef.current += 1)}`;
      const entry: ScanicEntry = {
        id,
        file,
        photoUrl: URL.createObjectURL(file),
        imageWidth: null,
        imageHeight: null,
        corners: null,
        warpedUrl: null,
        phase: 'queued',
        detector: null,
        error: null,
      };
      recordsRef.current = [...recordsRef.current, entry];
      publish();
      queueRef.current.push(id);
      void pump();
    },
    [publish, pump],
  );

  const buildNow = useCallback(async (): Promise<ScanicEntry[]> => {
    // Join/start the drainer and wait until no work is left — including
    // entries enqueued while waiting.
    for (;;) {
      const active = drainPromiseRef.current ?? pump();
      await active;
      if (drainPromiseRef.current === null) break;
    }
    return recordsRef.current.slice();
  }, [pump]);

  const readyCount = useMemo(
    () => entries.filter((entry) => entry.phase === 'ready').length,
    [entries],
  );

  return { entries, enqueueCapture, readyCount, buildNow };
}
