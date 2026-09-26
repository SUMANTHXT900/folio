/**
 * Scan-image import normalization (M3.x): bounded, pixel-budget based.
 *
 * The file-import path must never materialize many full-resolution
 * decodes at once: a ~2 MB phone JPEG can decode to ~36 MB of raw
 * pixels, so 32 selected photos are >1 GB before any PDF work starts.
 * This layer normalizes ONE image at a time (long edge ≤
 * [`MAX_IMPORT_LONG_EDGE`], pixels not file size), releasing every
 * temporary decode/canvas before the next file, and yields to the event
 * loop between files so the UI can paint progress.
 *
 * JPEGs already inside the pixel budget keep their ORIGINAL bytes —
 * no unnecessary recompression, no quality loss. Oversized images are
 * re-encoded once at the existing capture quality (~q0.92). PNGs are
 * ALWAYS converted to JPEG (white-filled, budget-clamped): the engine
 * embeds PNGs as uncompressed raw RGB, so a retained 2 MB screenshot
 * would become ~15 MB in the PDF (real-phone report: 100 MB+ outputs
 * from gallery imports while JPEG camera captures stayed small).
 * Aspect ratio is always preserved; small images are never upscaled.
 *
 * Encode offload (PERFORMANCE.md P2 item 11): `resizeToJpeg` encodes
 * through `imageEncode.worker.ts` (`OffscreenCanvas` + `convertToBlob`
 * off the main thread, bitmap transferred) and falls back to the
 * original main-thread canvas path when workers are unavailable — same
 * white-fill, same dimensions, same quality either way.
 */

/** Working long edge for imported images (engineering constant). */
export const MAX_IMPORT_LONG_EDGE = 2500;

/** JPEG quality for normalized imports (matches capture path). */
export const IMPORT_JPEG_QUALITY = 0.92;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface PrepareImportResult {
  /** File retained for the page: original bytes or normalized re-encode. */
  file: File | Blob;
  name: string;
  /** True when the file is within budget and bytes are untouched. */
  retainedOriginal: boolean;
  width: number;
  height: number;
}

export interface PrepareImportOptions {
  maxLongEdge?: number;
  quality?: number;
}

/**
 * Pure decision: target dimensions for a source size, aspect preserved,
 * never upscaled. Returns null when normalization is unnecessary.
 */
export function planNormalization(
  source: ImageDimensions,
  maxLongEdge: number = MAX_IMPORT_LONG_EDGE,
): ImageDimensions | null {
  const longest = Math.max(source.width, source.height);
  if (!Number.isFinite(longest) || longest <= 0) return null;
  if (longest <= maxLongEdge) return null;
  const scale = maxLongEdge / longest;
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/** PNG inputs (MIME or extension): the engine has no DCT path for PNG,
 * so retained PNG bytes would embed as raw RGB — always convert. */
export function isPngFile(file: File): boolean {
  if (file.type === 'image/png') return true;
  if (file.type === 'image/jpeg') return false;
  return /\.png$/i.test(file.name);
}
/**
 * One decode's result: pixel dimensions plus the live decoder handle.
 * `resizeToJpeg` reads pixels from `bitmap`; the caller releases it via
 * `ImportRenderer.close` in a `finally`.
 */
export interface DecodedImage extends ImageDimensions {
  /** Renderer-private handle (`ImageBitmap` in the browser). */
  bitmap: unknown;
}

/** Minimal renderer seam so planning logic is testable without a DOM. */
export interface ImportRenderer {
  /** Decodes ONCE; the caller must release the handle via `close`. */
  decode(file: File | Blob): Promise<DecodedImage>;
  /** Re-encodes the decoded pixels; never re-reads the source file. */
  resizeToJpeg(
    decoded: DecodedImage,
    target: ImageDimensions,
    quality: number,
  ): Promise<Uint8Array>;
  /** Releases a decode's backing memory (browser: `ImageBitmap.close`). */
  close(decoded: DecodedImage): void;
}

/* ---------- JPEG encode offload (P2 item 11) ---------- */

/**
 * Thrown when the encode worker cannot be used WITHOUT consuming the
 * caller's bitmap (no `Worker`, construction failed, no worker-side
 * `OffscreenCanvas`, or the post itself was rejected): the caller must
 * fall back to its main-thread path. Any other error means the bitmap
 * was already transferred — fallback is impossible, propagate it.
 */
export class EncodeWorkerUnavailableError extends Error {
  constructor(message = 'Encode worker unavailable.') {
    super(message);
    this.name = 'EncodeWorkerUnavailableError';
  }
}

interface PendingEncode {
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface EncodeWorkerFactory {
  (): Worker;
}

function defaultEncodeWorkerFactory(): Worker {
  return new Worker(new URL('./imageEncode.worker.ts', import.meta.url), { type: 'module' });
}

let encodeWorkerFactory: EncodeWorkerFactory = defaultEncodeWorkerFactory;
/** True while a test factory is installed: bypasses the `Worker` gate. */
let encodeWorkerFactoryOverride = false;
let encodeWorker: Worker | null = null;
let encodeWorkerReady: Promise<boolean> | null = null;
/** Latched once the worker proves broken: later calls skip it outright. */
let encodeWorkerDead = false;
let encodeWorkerSeq = 0;
const pendingEncodes = new Map<number, PendingEncode>();

/** Maximum time one encode may occupy the worker before it is failed. */
const ENCODE_WORKER_TIMEOUT_MS = 30_000;
/** Maximum time to wait for the worker's boot handshake. */
const ENCODE_WORKER_READY_TIMEOUT_MS = 3000;

/** Test-only factory override (FakeWorker pattern, cf. ScanWorkerClient). */
export function __setEncodeWorkerFactoryForTests(factory: EncodeWorkerFactory | null): void {
  encodeWorkerFactory = factory ?? defaultEncodeWorkerFactory;
  encodeWorkerFactoryOverride = factory !== null;
  __resetEncodeWorkerForTests();
}

/** Test-only reset: drops the singleton, pending jobs, and latches. */
export function __resetEncodeWorkerForTests(): void {
  try {
    encodeWorker?.terminate();
  } catch {
    // Best effort.
  }
  encodeWorker = null;
  encodeWorkerReady = null;
  encodeWorkerDead = false;
  for (const [, job] of pendingEncodes) {
    clearTimeout(job.timer);
  }
  pendingEncodes.clear();
}

function poisonEncodeWorker(): void {
  encodeWorkerDead = true;
  try {
    encodeWorker?.terminate();
  } catch {
    // Best effort.
  }
  encodeWorker = null;
  encodeWorkerReady = null;
  for (const [id, job] of pendingEncodes) {
    pendingEncodes.delete(id);
    clearTimeout(job.timer);
    job.reject(new Error('Encode worker failed.'));
  }
}

function routeEncodeResult(data: unknown): void {
  if (data === null || typeof data !== 'object') return;
  const msg = data as {
    kind?: unknown;
    id?: unknown;
    ok?: unknown;
    buffer?: unknown;
    message?: unknown;
  };
  if (msg.kind !== 'result' || typeof msg.id !== 'number') return;
  const job = pendingEncodes.get(msg.id);
  if (job === undefined) return;
  pendingEncodes.delete(msg.id);
  clearTimeout(job.timer);
  if (msg.ok === true && msg.buffer instanceof ArrayBuffer) {
    job.resolve(new Uint8Array(msg.buffer));
  } else {
    job.reject(new Error(typeof msg.message === 'string' ? msg.message : 'Encode worker failed.'));
  }
}

/**
 * Resolves true once a usable encode worker exists. False is latched:
 * environments without workers (or without worker-side OffscreenCanvas)
 * pay exactly one failed attempt, then always take the main-thread path.
 */
function ensureEncodeWorker(): Promise<boolean> {
  if (encodeWorkerDead) return Promise.resolve(false);
  if (encodeWorkerReady !== null) return encodeWorkerReady;
  encodeWorkerReady = new Promise<boolean>((resolve) => {
    // A test-installed factory bypasses the ambient `Worker` gate so
    // FakeWorker doubles run under jsdom (which has no `Worker`).
    if (typeof Worker === 'undefined' && !encodeWorkerFactoryOverride) {
      resolve(false);
      return;
    }
    let worker: Worker;
    try {
      worker = encodeWorkerFactory();
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        worker.terminate();
      } catch {
        // Best effort.
      }
      resolve(false);
    }, ENCODE_WORKER_READY_TIMEOUT_MS);
    worker.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { kind?: unknown; offscreen?: unknown } | null;
      if (data !== null && typeof data === 'object' && data.kind === 'ready') {
        clearTimeout(timer);
        if (data.offscreen === true) {
          encodeWorker = worker;
          worker.onerror = () => poisonEncodeWorker();
          resolve(true);
        } else {
          try {
            worker.terminate();
          } catch {
            // Best effort.
          }
          resolve(false);
        }
        return;
      }
      routeEncodeResult(ev.data);
    };
    worker.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
  return encodeWorkerReady;
}

/**
 * Encodes `bitmap` to JPEG in the encode worker, TRANSFERRING the
 * bitmap. On success the worker owns closing; the sender's copy is
 * neutered (its `close()` is a harmless no-op the caller still runs).
 *
 * Throws `EncodeWorkerUnavailableError` when the bitmap was NOT
 * consumed (safe to fall back); any other throw means the transfer
 * happened and the caller must propagate (per-file error isolation).
 */
export async function encodeBitmapToJpeg(
  bitmap: ImageBitmap,
  target: ImageDimensions,
  quality: number,
  flipHorizontal = false,
): Promise<Uint8Array> {
  const usable = await ensureEncodeWorker();
  const worker = encodeWorker;
  if (!usable || worker === null) {
    throw new EncodeWorkerUnavailableError();
  }
  const id = (encodeWorkerSeq += 1);
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Hung worker: fail this job and stop trusting the worker —
      // later encodes go straight to the main-thread path.
      pendingEncodes.delete(id);
      poisonEncodeWorker();
      reject(new Error('Encode worker timed out.'));
    }, ENCODE_WORKER_TIMEOUT_MS);
    pendingEncodes.set(id, { resolve, reject, timer });
    try {
      worker.postMessage(
        {
          kind: 'encode',
          id,
          bitmap,
          width: target.width,
          height: target.height,
          quality,
          flipHorizontal,
        },
        [bitmap],
      );
    } catch (error) {
      // Post rejected before the transfer: the bitmap is still usable.
      pendingEncodes.delete(id);
      clearTimeout(timer);
      reject(
        new EncodeWorkerUnavailableError(
          error instanceof Error ? error.message : 'Encode worker post failed.',
        ),
      );
    }
  });
}

/**
 * The pre-P2 main-thread encode: white-fill + draw + `toBlob` /
 * `convertToBlob` on the calling thread. Unchanged behavior — this is
 * the synchronous fallback whenever the worker is unavailable.
 */
async function mainThreadResizeToJpeg(
  bitmap: ImageBitmap,
  target: ImageDimensions,
  quality: number,
): Promise<Uint8Array> {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(target.width, target.height)
      : document.createElement('canvas');
  if (canvas instanceof HTMLCanvasElement) {
    canvas.width = target.width;
    canvas.height = target.height;
  }
  const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext('2d') as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (ctx === null) throw new Error('2D canvas unavailable for import normalization.');
  // White-fill first: transparent PNG pixels must composite to white
  // (JPEG has no alpha; an unfilled canvas bakes them to black).
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);
  if (canvas instanceof HTMLCanvasElement) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    canvas.width = 0;
    canvas.height = 0;
    if (blob === null) throw new Error('Import re-encode failed.');
    return new Uint8Array(await blob.arrayBuffer());
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Browser renderer: one decode serves dimensions + resize. */
export const browserImportRenderer: ImportRenderer = {
  async decode(file) {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height, bitmap };
  },

  async resizeToJpeg(decoded, target, quality) {
    const bitmap = decoded.bitmap as ImageBitmap;
    try {
      return await encodeBitmapToJpeg(bitmap, target, quality);
    } catch (error) {
      if (!(error instanceof EncodeWorkerUnavailableError)) throw error;
      return mainThreadResizeToJpeg(bitmap, target, quality);
    }
  },

  close(decoded) {
    (decoded.bitmap as ImageBitmap).close();
  },
};

/**
 * Prepares ONE selected file for import. Decodes a single bitmap ONCE
 * (dimension check + re-encode share it), decides by pixel dimensions,
 * and either retains the original bytes or re-encodes once — no
 * temporary object URLs, no retained canvas. The decode handle is
 * released exactly once, in this function's `finally`.
 * PNGs always re-encode (white-filled JPEG): retained PNG bytes would
 * embed as uncompressed raw RGB downstream.
 */
export async function prepareImportFile(
  file: File,
  renderer: ImportRenderer = browserImportRenderer,
  options: PrepareImportOptions = {},
): Promise<PrepareImportResult> {
  const maxLongEdge = options.maxLongEdge ?? MAX_IMPORT_LONG_EDGE;
  const quality = options.quality ?? IMPORT_JPEG_QUALITY;
  const decoded = await renderer.decode(file);
  try {
    const dims: ImageDimensions = { width: decoded.width, height: decoded.height };
    if (!(dims.width > 0 && dims.height > 0)) {
      throw new Error(`could not read image dimensions for ${file.name}`);
    }
    const target = planNormalization(dims, maxLongEdge);
    if (target === null && !isPngFile(file)) {
      return {
        file,
        name: file.name,
        retainedOriginal: true,
        width: dims.width,
        height: dims.height,
      };
    }
    const size = target ?? dims;
    const bytes = await renderer.resizeToJpeg(decoded, size, quality);
    const name = file.name.replace(/\.(jpe?g|png)$/i, '') + '.jpg';
    return {
      file: new File([bytes as unknown as BlobPart], name, { type: 'image/jpeg' }),
      name,
      retainedOriginal: false,
      width: size.width,
      height: size.height,
    };
  } finally {
    renderer.close(decoded);
  }
}

/** One queued file's outcome. */
export interface ImportOutcome {
  file: File;
  result: PrepareImportResult | null;
  error: string | null;
}

/**
 * Runs `prepare` over `files` SEQUENTIALLY (concurrency 1: the memory
 * bound is one decoded bitmap), yielding to the event loop between
 * items so progress can paint. `shouldCancel` is polled before each
 * file; a cancelled run leaves prepared results untouched (callers keep
 * what already committed).
 */
export async function runImportQueue(
  files: File[],
  prepare: (file: File) => Promise<PrepareImportResult>,
  onProgress: (completed: number, total: number, result: PrepareImportResult) => void,
  shouldCancel: () => boolean,
): Promise<{ outcomes: ImportOutcome[]; cancelled: boolean }> {
  const outcomes: ImportOutcome[] = [];
  for (let i = 0; i < files.length; i += 1) {
    if (shouldCancel()) {
      return { outcomes, cancelled: true };
    }
    const file = files[i];
    try {
      const result = await prepare(file);
      outcomes.push({ file, result, error: null });
      onProgress(i + 1, files.length, result);
    } catch (error) {
      outcomes.push({
        file,
        result: null,
        error: error instanceof Error ? error.message : 'image could not be read',
      });
    }
    // Yield: keeps React paint + input responsive between decodes.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { outcomes, cancelled: false };
}
