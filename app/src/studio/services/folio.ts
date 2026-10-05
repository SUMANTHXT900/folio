/**
 * Folio application PDF service — the single integration boundary
 * between the Folio UI and the frozen Folio engine.
 *
 * ```text
 * Studio UI (tools/hooks)
 *      ↓  application concepts only (ids, names, progress, errors)
 * this service (studio/services/folio.ts)
 *      ↓  Folio TypeScript APIs
 * WasmWorkerEngineAdapter → Rust/WASM (manipulation)
 * PdfRenderEngine / PdfThumbnailEngine → PDF.js (rendering)
 * ```
 *
 * Rules enforced here (Lessons 12–14):
 * - PDF bytes live in the module-level `binaries` map, NEVER in React
 *   state. Components hold `{id, name, sizeBytes, pageCount}` only.
 * - No PDF manipulation in UI code: tools call `runStudioOperation`;
 *   all parsing/mutation stays in the engine.
 * - Rendering goes through `PdfRenderEngine`, thumbnails through
 *   `PdfThumbnailEngine` — the UI never touches PDF.js or pdf-lib
 *   (both legacy implementations are deleted).
 * - Thumbnail object URLs are bounded (LRU, 6 documents) and revoked on
 *   evict/close — no unbounded canvas/URL retention.
 */

import type { WasmWorkerEngineAdapter } from '../../engine/WasmWorkerEngineAdapter';
import type { PdfRenderEngine } from '../../rendering/PdfRenderEngine';
import type { PdfThumbnailEngine } from '../../rendering/PdfThumbnailEngine';
import { getBytes, releaseBytes } from '../../engine/binaryStore';
import { sanitizeFileName } from '../components/downloadNaming';
import type { EngineRequest, OperationId, ResultSummary } from '../../types/engine';

/** Lightweight document handle for UI state (no bytes). */
export interface StudioDoc {
  id: string;
  name: string;
  sizeBytes: number;
  pageCount: number;
}

/** One engine output, owned by the studio service until released. */
export interface StudioOutput {
  name: string;
  bytes: Uint8Array;
  byteLength: number;
  pageCount: number | null;
}

/** Completed engine run for UI consumption. */
export interface StudioResult {
  summary: ResultSummary;
  outputs: StudioOutput[];
  durationMs: number;
  /**
   * App-side attribution spans (intake → staging → transfer → wait →
   * outputs; PERFORMANCE.md P4 item 16). DEV-only: present when
   * `import.meta.env.DEV`, absent in production builds. The engine's
   * `durationMs` remains the authoritative operation duration (D4).
   */
  perfMarks?: StudioPerfMark[];
}

/**
 * One app-side attribution span (wall time around a folio service stage).
 * Dev-only diagnostic data; never part of the engine wire contract.
 */
export interface StudioPerfMark {
  /** Span name, e.g. `studio:run:wait`. */
  name: string;
  /** Wall duration in milliseconds (`performance.now()` delta). */
  durationMs: number;
}

/** Real engine progress for UI display (fraction 0..1 when known). */
export interface StudioProgress {
  fraction: number | null;
  label: string;
}

/** Structured, UI-safe error (engine code preserved for diagnostics). */
export interface StudioError extends Error {
  code: string;
  details?: string;
  operation: OperationId;
  /** Raw engine message before friendly mapping (shown as secondary detail). */
  engineMessage?: string;
}

/** Cancellable engine run. */
export interface StudioJob {
  done: Promise<StudioResult>;
  cancel: () => Promise<void>;
}

const binaries = new Map<string, { bytes: Uint8Array; name: string }>();
const renderDocIds = new Map<string, string>();
const thumbJobs = new Map<string, Set<() => void>>();
/**
 * Staged (non-rendering) ids: raw bytes with no PDF.js owner, safe to
 * TRANSFER to the worker (P1). Rendering-backed documents are never
 * added here — transferring them would neuter the renderer's bytes.
 */
const stagedIds = new Set<string>();
let docCounter = 0;

let adapter: WasmWorkerEngineAdapter | null = null;
let renders: PdfRenderEngine | null = null;
let thumbs: PdfThumbnailEngine | null = null;

async function engines(): Promise<{
  adapter: WasmWorkerEngineAdapter;
  renders: PdfRenderEngine;
  thumbs: PdfThumbnailEngine;
}> {
  if (adapter === null || renders === null || thumbs === null) {
    const [{ WasmWorkerEngineAdapter }, { PdfJsRenderEngine }, { DefaultPdfThumbnailEngine }] =
      await Promise.all([
        import('../../engine/WasmWorkerEngineAdapter'),
        import('../../rendering/PdfJsRenderEngine'),
        import('../../rendering/DefaultPdfThumbnailEngine'),
      ]);
    const renderEngine = new PdfJsRenderEngine();
    adapter = new WasmWorkerEngineAdapter();
    renders = renderEngine;
    thumbs = new DefaultPdfThumbnailEngine(renderEngine);
  }
  return { adapter, renders, thumbs };
}

/** Human-readable presentation for engine error codes (code preserved). */
const ERROR_TEXT: Record<string, string> = {
  INVALID_DOCUMENT: 'That file is not a readable PDF.',
  INVALID_PAGE_RANGE: 'Those page numbers are not valid.',
  PAGE_OUT_OF_RANGE: 'A page number is outside the document.',
  DUPLICATE_PAGE: 'A page appears more than once where it must not.',
  PROCESSING_FAILED: 'PDF processing failed.',
  CANCELLED: 'The operation was cancelled.',
  UNSUPPORTED_FORMAT: 'This PDF needs a password, which is not supported yet.',
  IO_ERROR: 'A local I/O error interrupted the operation.',
  INVALID_INPUT: 'The input is not usable.',
  INVALID_OPTIONS: 'Those options are not valid for this operation.',
  INTERNAL: 'An unexpected internal error occurred.',
};

export function toStudioError(
  error: { code?: string; message?: string; details?: string },
  operation: OperationId,
): StudioError {
  const code = error.code ?? 'INTERNAL';
  const engineMessage = error.message;
  const message = ERROR_TEXT[code] ?? error.message ?? 'Something went wrong.';
  const failure = new Error(message) as StudioError;
  failure.code = code;
  failure.details = error.details;
  failure.operation = operation;
  if (engineMessage !== undefined && engineMessage !== message) {
    failure.engineMessage = engineMessage;
  }
  return failure;
}

/** Formats an engine duration for subtle completion lines (e.g. `1.24s`, `380ms`). */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Opens files as studio documents: bytes go to the module store,
 * a rendering document opens for page count + thumbnails, and only
 * lightweight handles return. Throws `StudioError` on unreadable input.
 */
export async function openStudioDocs(files: File[]): Promise<StudioDoc[]> {
  const docs: StudioDoc[] = [];
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    docs.push(await openStudioBytes(file.name, new Uint8Array(buffer)));
  }
  return docs;
}

/**
 * Registers raw bytes as a studio document (e.g. intermediate outputs
 * of chained operations). Same ownership contract as `openStudioDocs`.
 */
export async function openStudioBytes(name: string, bytes: Uint8Array): Promise<StudioDoc> {
  const { renders } = await engines();
  if (bytes.length === 0 || !isPdfBytes(bytes)) {
    throw toStudioError(
      { code: 'INVALID_DOCUMENT', message: 'input is not a readable PDF document' },
      'pdf.inspect',
    );
  }
  docCounter += 1;
  const id = `studio-${docCounter}`;
  binaries.set(id, { bytes, name });
  try {
    const loaded = await renders.loadDocument({ data: bytes, name }).promise;
    renderDocIds.set(id, loaded.document.id);
    return { id, name, sizeBytes: bytes.length, pageCount: loaded.document.pageCount };
  } catch (error) {
    binaries.delete(id);
    throw toStudioError(
      error instanceof Error
        ? { code: (error as { code?: string }).code, message: error.message }
        : {},
      'pdf.inspect',
    );
  }
}

/** Reads stored bytes by reference (never copies, never enters state). */
export function getStudioBytes(id: string): Uint8Array | undefined {
  return binaries.get(id)?.bytes;
}

/**
 * Stages raw bytes under a fresh id WITHOUT opening a rendering
 * document (for non-PDF inputs such as images). The caller must
 * `releaseStagedBytes` when done. Rendering-backed documents must use
 * `openStudioBytes`/`closeStudioDoc` instead.
 */
export function stageStudioBytes(name: string, bytes: Uint8Array): string {
  docCounter += 1;
  const id = `studio-${docCounter}`;
  binaries.set(id, { bytes, name });
  stagedIds.add(id);
  return id;
}

/** Releases a staged raw entry (no rendering document involved). */
export function releaseStagedBytes(id: string): void {
  binaries.delete(id);
  stagedIds.delete(id);
}

function trackThumbJob(docId: string, cancel: () => void): void {
  let set = thumbJobs.get(docId);
  if (set === undefined) {
    set = new Set();
    thumbJobs.set(docId, set);
  }
  set.add(cancel);
}

function untrackThumbJob(docId: string, cancel: () => void): void {
  thumbJobs.get(docId)?.delete(cancel);
}

/** Closes a document: cancels thumb work, closes rendering, frees bytes + URLs. */
export async function closeStudioDoc(id: string): Promise<void> {
  const { renders } = await engines();
  thumbJobs.get(id)?.forEach((cancel) => {
    try {
      cancel();
    } catch {
      // Best effort.
    }
  });
  thumbJobs.delete(id);
  revokeDocUrls(id);
  const renderId = renderDocIds.get(id);
  renderDocIds.delete(id);
  if (renderId !== undefined) {
    purgePreviewsForRender(renderId);
    await renders.closeDocument(renderId).catch(() => undefined);
  }
  binaries.delete(id);
}

export interface StudioRunOptions {
  onProgress?: (progress: StudioProgress) => void;
}

/* ---------- app-side attribution (PERFORMANCE.md P4 item 16) ---------- */

// Sequence for unique performance mark names across concurrent jobs.
let perfSeq = 0;

function perfNow(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {
    // Ignore — fall through to Date.now().
  }
  return Date.now();
}

function safeMark(name: string): void {
  try {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.mark(name);
    }
  } catch {
    // Attribution must never fail the pipeline (jsdom, older browsers).
  }
}

function safeMeasure(name: string, start: string, end: string): void {
  try {
    if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
      performance.measure(name, start, end);
    }
  } catch {
    // Ignore — the wall duration is still recorded via perfNow().
  }
  try {
    if (typeof performance !== 'undefined' && typeof performance.clearMarks === 'function') {
      performance.clearMarks(start);
      performance.clearMarks(end);
    }
  } catch {
    // Ignore.
  }
}

/**
 * Begins an attribution span: marks the start and returns an `end` closure
 * that marks the end, records a `performance.measure`, and returns the wall
 * duration in milliseconds. The engine remains the authoritative duration
 * (D4); these spans only attribute app-side overhead for P4 budgets.
 */
function beginPerfSpan(name: string): () => number {
  const startedAt = perfNow();
  perfSeq += 1;
  const startMark = `folio:${name}#${perfSeq}:start`;
  const endMark = `folio:${name}#${perfSeq}:end`;
  safeMark(startMark);
  return () => {
    const durationMs = perfNow() - startedAt;
    safeMark(endMark);
    safeMeasure(`folio:${name}`, startMark, endMark);
    return durationMs;
  };
}

/** Times a synchronous stage and appends its span to `marks`. */
function spanSync<T>(marks: StudioPerfMark[], name: string, fn: () => T): T {
  const end = beginPerfSpan(name);
  try {
    return fn();
  } finally {
    marks.push({ name, durationMs: end() });
  }
}

/** Times an async stage and appends its span to `marks`. */
async function spanAsync<T>(
  marks: StudioPerfMark[],
  name: string,
  promise: Promise<T>,
): Promise<T> {
  const end = beginPerfSpan(name);
  try {
    return await promise;
  } finally {
    marks.push({ name, durationMs: end() });
  }
}

/**
 * Runs one engine operation over studio documents. Inputs resolve to
 * stored bytes at call time; outputs resolve to studio-owned byte
 * references (adapter store entries are released immediately — no
 * copies, no accumulation). Progress streams real engine events.
 */
export function runStudioOperation(
  operation: OperationId,
  docIds: string[],
  options: EngineRequest['options'],
  runOptions?: StudioRunOptions,
): StudioJob {
  let cancelled = false;
  let cancelAdapter: (() => Promise<void>) | null = null;
  const done = (async (): Promise<StudioResult> => {
    const { adapter } = await engines();
    // P4-16 attribution: wall spans per app-side stage. Behavior-preserving —
    // the spans only observe; the engine duration stays authoritative (D4).
    const perfMarks: StudioPerfMark[] = [];
    const inputs = spanSync(perfMarks, 'studio:run:intake', () =>
      docIds.map((id) => {
        const entry = binaries.get(id);
        if (entry === undefined) {
          throw toStudioError(
            { code: 'INVALID_INPUT', message: 'document is no longer open' },
            operation,
          );
        }
        return { name: entry.name, bytes: entry.bytes, transfer: stagedIds.has(id) };
      }),
    );
    const request = spanSync(
      perfMarks,
      'studio:run:staging',
      () => ({ operation, inputs, options }) as EngineRequest,
    );
    const { jobId, done: adapterDone } = spanSync(perfMarks, 'studio:run:transfer', () =>
      adapter.execute(request),
    );
    cancelAdapter = () => adapter.cancel(jobId);
    if (cancelled) {
      await adapter.cancel(jobId);
    }
    const unsubscribe = adapter.subscribe(jobId, (event) => {
      if (event.kind === 'progress') {
        runOptions?.onProgress?.({
          fraction: event.percentage ?? null,
          label: event.message ?? event.phase ?? 'Working…',
        });
      } else if (event.kind === 'lifecycle' && event.message) {
        runOptions?.onProgress?.({ fraction: null, label: event.message });
      }
    });
    try {
      const finished = await spanAsync(perfMarks, 'studio:run:wait', adapterDone);
      if (finished.status === 'cancelled') {
        throw toStudioError({ code: 'CANCELLED', message: finished.error?.message }, operation);
      }
      if (finished.status !== 'completed' || finished.result === undefined) {
        const error = finished.error;
        throw toStudioError(
          { code: error?.code, message: error?.message, details: error?.details },
          operation,
        );
      }
      // Move outputs into studio ownership: resolve bytes by reference,
      // then release the adapter store entries (no copies, no retention).
      // (Narrowed here: the closure below would lose `finished` narrowing.)
      const engineResult = finished.result;
      const outputs: StudioOutput[] = spanSync(perfMarks, 'studio:run:outputs', () =>
        (engineResult.outputs ?? []).map((ref) => {
          const bytes = getBytes(ref.outputId);
          releaseBytes(ref.outputId);
          if (bytes === undefined) {
            throw toStudioError(
              { code: 'INTERNAL', message: 'engine output went missing' },
              operation,
            );
          }
          return { name: ref.name, bytes, byteLength: ref.byteLength, pageCount: ref.pageCount };
        }),
      );
      const result: StudioResult = {
        summary: engineResult.summary,
        outputs,
        durationMs: finished.engineDurationMs ?? 0,
      };
      if (import.meta.env.DEV) {
        result.perfMarks = perfMarks;
      }
      return result;
    } finally {
      unsubscribe();
    }
  })();
  return {
    done,
    cancel: async () => {
      cancelled = true;
      if (cancelAdapter !== null) {
        await cancelAdapter();
      }
    },
  };
}

/* ---------- thumbnails (bounded object-URL cache) ---------- */

const thumbUrls = new Map<string, Map<number, string>>();
const thumbOrder: string[] = [];
const MAX_THUMB_DOCS = 6;

/**
 * Per-document thumbnail page cap: a very large document must not grow
 * an unbounded page→URL map. Oldest-cached pages evict first (Map
 * insertion order); evicted URLs are revoked and listeners notified so
 * hooks never serve them again.
 */
export const MAX_THUMB_PAGES_PER_DOC = 400;

/** Generation bumped every time an eviction drops URLs for `docId`. */
const thumbGenerations = new Map<string, number>();
type ThumbEvictListener = (docId: string) => void;
const thumbEvictListeners = new Set<ThumbEvictListener>();

/**
 * Subscribes to thumbnail evictions (LRU doc evict, per-doc page-cap
 * evict, close). Hooks invalidate their URL arrays on notification so a
 * revoked URL is never rendered. Returns an unsubscribe closure.
 */
export function subscribeThumbEvictions(listener: ThumbEvictListener): () => void {
  thumbEvictListeners.add(listener);
  return () => {
    thumbEvictListeners.delete(listener);
  };
}

/** Eviction generation for `docId` (0 when never evicted). */
export function getThumbGeneration(docId: string): number {
  return thumbGenerations.get(docId) ?? 0;
}

function noteThumbEvict(docId: string): void {
  thumbGenerations.set(docId, getThumbGeneration(docId) + 1);
  for (const listener of [...thumbEvictListeners]) {
    try {
      listener(docId);
    } catch {
      // Best effort — a hook must never break eviction.
    }
  }
}

/** True while `url` is still the live cached thumbnail for (docId, page). */
export function isThumbUrlLive(docId: string, pageNumber: number, url: string): boolean {
  return thumbUrls.get(docId)?.get(pageNumber) === url;
}

function revokeDocUrls(docId: string): void {
  const pages = thumbUrls.get(docId);
  const had = pages !== undefined && pages.size > 0;
  if (pages !== undefined) {
    for (const url of pages.values()) {
      URL.revokeObjectURL(url);
    }
    thumbUrls.delete(docId);
  }
  const index = thumbOrder.indexOf(docId);
  if (index >= 0) {
    thumbOrder.splice(index, 1);
  }
  if (had) {
    noteThumbEvict(docId);
  }
}

function touchDoc(docId: string): Map<number, string> {
  let pages = thumbUrls.get(docId);
  if (pages === undefined) {
    pages = new Map();
    thumbUrls.set(docId, pages);
  }
  const index = thumbOrder.indexOf(docId);
  if (index >= 0) {
    thumbOrder.splice(index, 1);
  }
  thumbOrder.push(docId);
  while (thumbOrder.length > MAX_THUMB_DOCS) {
    const oldest = thumbOrder.shift();
    if (oldest !== undefined && oldest !== docId) {
      revokeDocUrls(oldest);
    }
  }
  return pages as Map<number, string>;
}

/**
 * Caches one thumbnail URL under the per-document page cap. Evicted
 * pages are revoked immediately and listeners notified (same contract
 * as document eviction). The just-written page is never the victim.
 */
function thumbCacheSet(
  cache: Map<number, string>,
  docId: string,
  pageNumber: number,
  url: string,
): void {
  cache.set(pageNumber, url);
  while (cache.size > MAX_THUMB_PAGES_PER_DOC) {
    let oldest: number | undefined;
    for (const key of cache.keys()) {
      if (key !== pageNumber) {
        oldest = key;
        break;
      }
    }
    if (oldest === undefined) {
      break;
    }
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    if (evicted !== undefined) {
      try {
        URL.revokeObjectURL(evicted);
      } catch {
        // Best effort.
      }
    }
    noteThumbEvict(docId);
  }
}

/**
 * Revalidates the thumbnail cache after an await: returns the live map,
 * or null when the document closed mid-flight (never resurrect entries
 * for a closed document). An evicted-but-open document re-touches as
 * MRU so fresh URLs always land in the live map.
 */
function liveThumbCache(docId: string): Map<number, string> | null {
  if (renderDocIds.get(docId) === undefined) {
    return null;
  }
  return thumbUrls.get(docId) ?? touchDoc(docId);
}

/** Test-only access to the thumbnail cache (eviction + validity). */
export const __thumbCacheForTests = {
  maxDocs: MAX_THUMB_DOCS,
  maxPagesPerDoc: MAX_THUMB_PAGES_PER_DOC,
  touch: touchDoc,
  set: thumbCacheSet,
  revokeDoc: revokeDocUrls,
  live: isThumbUrlLive,
  generation: getThumbGeneration,
  subscribe: subscribeThumbEvictions,
  size(docId: string): number {
    return thumbUrls.get(docId)?.size ?? 0;
  },
  has(docId: string): boolean {
    return thumbUrls.has(docId);
  },
  clearForTests(): void {
    for (const docId of [...thumbUrls.keys()]) {
      const pages = thumbUrls.get(docId);
      thumbUrls.delete(docId);
      if (pages !== undefined) {
        for (const url of pages.values()) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // Best effort.
          }
        }
      }
    }
    thumbOrder.length = 0;
    thumbGenerations.clear();
    thumbEvictListeners.clear();
  },
};

function canvasToUrl(canvas: HTMLCanvasElement): Promise<string> {
  // MIME fallback chain: some environments lack a webp encoder (or fail
  // under memory pressure), in which case toBlob calls back with null.
  // JPEG is near-universal; PNG always works. Never reject the wave.
  const types: Array<{ mime: string; quality?: number }> = [
    { mime: 'image/webp', quality: 0.85 },
    { mime: 'image/jpeg', quality: 0.85 },
    { mime: 'image/png' },
  ];
  return new Promise((resolve, reject) => {
    const attempt = (index: number): void => {
      const type = types[index];
      if (type === undefined) {
        reject(new Error('thumbnail encode failed'));
        return;
      }
      canvas.toBlob(
        (blob) => {
          if (blob === null) {
            attempt(index + 1);
            return;
          }
          resolve(URL.createObjectURL(blob));
        },
        type.mime,
        type.quality,
      );
    };
    attempt(0);
  });
}

/**
 * Bounded encode concurrency for thumbnail windows (P2 finding 13).
 * Matches the render-side concurrency so encodes never outrun renders.
 */
const THUMB_ENCODE_CONCURRENCY = 2;

/**
 * Encodes thumbnail canvases with bounded concurrency while preserving
 * input-order output (`urls[i]` belongs to `items[i]`).
 *
 * The render side already runs at concurrency 2; previously the encodes ran
 * sequentially in a `for`-`await` loop on the main thread. Each canvas bitmap
 * is released after its own encode settles (success or failure), mirroring
 * the sequential loop's release discipline. The MIME fallback chain
 * (webp→jpeg→png) lives in the `encodeOne` step, so it is unchanged. If any
 * encode fails, every started encode still settles (no bitmap is leaked) and
 * the first error is rethrown after all lanes drain.
 *
 * Exported for unit tests; production callers pass `canvasToUrl`.
 */
export async function encodeThumbCanvases(
  items: ReadonlyArray<{ canvas: HTMLCanvasElement; pageNumber: number }>,
  concurrency: number,
  encodeOne: (canvas: HTMLCanvasElement) => Promise<string> = canvasToUrl,
  shouldCancel?: () => boolean,
): Promise<string[]> {
  const urls = new Array<string>(items.length);
  let next = 0;
  let firstError: unknown;
  let failed = false;
  let aborted = false;
  async function lane(): Promise<void> {
    // Single-threaded cooperative scheduling: the check-and-claim below
    // runs without an intervening await, so no two lanes claim one slot.
    while (next < items.length) {
      if (shouldCancel?.() === true) {
        aborted = true;
        break;
      }
      const index = next;
      next += 1;
      const item = items[index];
      try {
        urls[index] = await encodeOne(item.canvas);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      } finally {
        item.canvas.width = 0;
        item.canvas.height = 0;
      }
      if (shouldCancel?.() === true) {
        aborted = true;
        break;
      }
    }
  }
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  if (aborted) {
    // Cancel-during-encode: release canvases no lane claimed and revoke
    // URLs minted before the abort, so a cancelled job leaves neither a
    // bitmap nor an orphaned object URL behind. Cache writes never happen.
    for (let index = next; index < items.length; index += 1) {
      const item = items[index];
      if (item !== undefined) {
        item.canvas.width = 0;
        item.canvas.height = 0;
      }
    }
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index];
      if (url !== undefined) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Best effort.
        }
      }
    }
    throw toStudioError(
      { code: 'CANCELLED', message: 'thumbnail job was cancelled' },
      'pdf.inspect',
    );
  }
  if (failed) {
    throw firstError;
  }
  return urls;
}

/**
 * Thumbnail size tiers (list/grid vs zoomed).
 *
 * List/grid tiles are ~64 CSS px wide, so the default window box is
 * derived from the display (`64 CSS px × devicePixelRatio`, clamped to
 * 96–192 — ≈128 at 2×). The 400 box is kept only for zoomed callers
 * that need a mid-size window render; dialog-scale zoom goes through
 * `studioPreview` (full-res, DPR-capped) instead.
 */
export const THUMB_LIST_BOX = 128;
export const THUMB_ZOOM_BOX = 400;

/** Display-derived list box: 64 CSS px × DPR, clamped to a sane window. */
export function thumbListBox(): number {
  let dpr = 1;
  try {
    const v = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      dpr = Math.min(v, 3);
    }
  } catch {
    // Non-DOM (unit tests): fall through at 1×.
  }
  return Math.min(192, Math.max(96, Math.round(64 * dpr)));
}

/**
 * Renders a window of thumbnails with bounded concurrency (engine
 * concurrency 2) and resolves page→objectURL in input order. Canvases
 * are released as their URLs are encoded; windows stay small (the hook
 * uses 24), so transient memory is bounded. Returns a cancellable job.
 *
 * Per-page fault isolation: when the bounded batch rejects, the missing
 * pages are retried one by one — every success is cached and resolved,
 * every failure is marked by absence (holes stay holes for the hook to
 * mark failed). Only a total failure (nothing salvaged) rejects.
 */
export function studioThumbWindow(
  docId: string,
  pages: number[],
  opts?: { box?: number },
): { done: Promise<Map<number, string>>; cancel: () => void } {
  let cancelled = false;
  let cancelJob: (() => void) | null = null;
  const done = (async (): Promise<Map<number, string>> => {
    const { thumbs } = await engines();
    if (cancelled) {
      throw toStudioError(
        { code: 'CANCELLED', message: 'thumbnail job was cancelled' },
        'pdf.inspect',
      );
    }
    const renderId = renderDocIds.get(docId);
    if (renderId === undefined) {
      throw toStudioError(
        { code: 'INVALID_INPUT', message: 'document is no longer open' },
        'pdf.inspect',
      );
    }
    const cache = touchDoc(docId);
    // List/grid tier by default (≈128 box at 2×); zoomed callers pass an
    // explicit box (THUMB_ZOOM_BOX). Never the old fixed 400 for lists.
    const box = opts?.box ?? thumbListBox();
    const missing = pages.filter((page) => cache.get(page) === undefined);
    const out = new Map<number, string>();
    for (const page of pages) {
      const hit = cache.get(page);
      if (hit !== undefined) {
        out.set(page, hit);
      }
    }
    if (missing.length === 0) {
      return out;
    }
    const job = thumbs.generateThumbnails(renderId, missing, {
      size: { width: box, height: box },
      concurrency: 2,
    });
    cancelJob = (): void => job.cancel();
    trackThumbJob(docId, cancelJob);
    try {
      const endRender = beginPerfSpan('studio:thumb-window:render');
      let results: Awaited<typeof job.promise>;
      try {
        results = await job.promise;
      } finally {
        endRender();
      }
      if (cancelled) {
        // Cancel-during-render: release every bitmap, write nothing.
        for (const item of results) {
          item.canvas.width = 0;
          item.canvas.height = 0;
        }
        throw toStudioError(
          { code: 'CANCELLED', message: 'thumbnail job was cancelled' },
          'pdf.inspect',
        );
      }
      // P2 finding 13: bounded-concurrency encodes (render is already
      // concurrency-2; the old sequential for-await loop is gone). Order is
      // restored through the input page list below, not completion order.
      // The encode lanes also observe `cancelled` and abort (revoking
      // URLs minted before the abort, releasing unclaimed bitmaps).
      const endEncode = beginPerfSpan('studio:thumb-window:encode');
      let urls: string[];
      try {
        urls = await encodeThumbCanvases(
          results,
          THUMB_ENCODE_CONCURRENCY,
          canvasToUrl,
          () => cancelled,
        );
      } finally {
        endEncode();
      }
      if (cancelled) {
        // Cancel-during-encode: revoke the fresh URLs (nobody owns them
        // yet) and never write the cache.
        for (const url of urls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // Best effort.
          }
        }
        throw toStudioError(
          { code: 'CANCELLED', message: 'thumbnail job was cancelled' },
          'pdf.inspect',
        );
      }
      // Never resurrect a dropped entry: a close/evict mid-flight means
      // the `cache` handle is stale. Closed documents fail; evicted-but-
      // open documents re-touch as MRU so fresh URLs land in the live map.
      const live = liveThumbCache(docId);
      if (live === null) {
        for (const url of urls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // Best effort.
          }
        }
        throw toStudioError(
          { code: 'INVALID_INPUT', message: 'document is no longer open' },
          'pdf.inspect',
        );
      }
      const byPage = new Map<number, string>();
      for (let index = 0; index < results.length; index += 1) {
        byPage.set(results[index].pageNumber, urls[index]);
      }
      for (const page of missing) {
        const url = byPage.get(page);
        if (url !== undefined) {
          thumbCacheSet(live, docId, page, url);
          out.set(page, url);
        }
      }
      return out;
    } catch (batchError) {
      // Per-page fault isolation: one bad page must not sink the window.
      // Retry the missing pages individually — cache every success, mark
      // every failure by absence (holes stay holes; the hook marks them
      // failed so later waves never retry them). Cancellation and a closed
      // document still fail the window; only a total failure rethrows the
      // original batch error.
      if (cancelJob !== null) {
        untrackThumbJob(docId, cancelJob);
        cancelJob = null;
      }
      const batchCode = (batchError as { code?: string })?.code;
      if (cancelled || batchCode === 'CANCELLED') {
        throw batchError;
      }
      const cancelledError = (): StudioError =>
        toStudioError({ code: 'CANCELLED', message: 'thumbnail job was cancelled' }, 'pdf.inspect');
      for (const page of missing) {
        if (cancelled) {
          throw cancelledError();
        }
        const single = thumbs.generateThumbnail(renderId, page, {
          size: { width: box, height: box },
        });
        const cancelSingle = (): void => single.cancel();
        cancelJob = cancelSingle;
        trackThumbJob(docId, cancelSingle);
        let canvas: HTMLCanvasElement | null = null;
        try {
          const one = await single.promise;
          canvas = one.canvas;
          if (cancelled) {
            throw cancelledError();
          }
          const url = await canvasToUrl(canvas);
          canvas.width = 0;
          canvas.height = 0;
          canvas = null;
          if (cancelled) {
            try {
              URL.revokeObjectURL(url);
            } catch {
              // Best effort.
            }
            throw cancelledError();
          }
          const liveSingle = liveThumbCache(docId);
          if (liveSingle === null) {
            try {
              URL.revokeObjectURL(url);
            } catch {
              // Best effort.
            }
            throw toStudioError(
              { code: 'INVALID_INPUT', message: 'document is no longer open' },
              'pdf.inspect',
            );
          }
          thumbCacheSet(liveSingle, docId, page, url);
          out.set(page, url);
        } catch (singleError) {
          if (canvas !== null) {
            try {
              canvas.width = 0;
              canvas.height = 0;
            } catch {
              // Canvas teardown never masks the real failure.
            }
          }
          const singleCode = (singleError as { code?: string })?.code;
          if (
            cancelled ||
            singleCode === 'CANCELLED' ||
            singleCode === 'INVALID_INPUT' ||
            singleCode === 'THUMBNAIL_CLOSED' ||
            singleCode === 'THUMBNAIL_CANCELLED'
          ) {
            throw singleError;
          }
          // Marked failure: skip — the page stays a hole.
        } finally {
          untrackThumbJob(docId, cancelSingle);
        }
      }
      cancelJob = null;
      if (out.size === 0) {
        throw batchError;
      }
      return out;
    } finally {
      if (cancelJob !== null) {
        untrackThumbJob(docId, cancelJob);
      }
    }
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
      cancelJob?.();
    },
  };
}

/* ---------- full-resolution preview cache (bounded LRU, P2 finding 17) ---------- */

// Small second layer behind the tools' per-mount maps (those stay the fast
// path and are untouched): repeat previews of the same (document, page) skip
// the scale-2 render + encode. Render ids are `renderdoc-N` (no colons), so
// `renderId:page` keys are unambiguous.
//
// Ownership (single-owner rule): the SERVICE owns every cached preview URL
// — it alone revokes entries, on LRU evict and on document close. Callers
// borrow the returned string and MUST NOT revoke it; a borrowed URL stays
// valid until the service evicts it or its document closes. Callers that
// hold a URL across awaits re-request through `studioPreview` (a live hit
// returns the same URL) or verify with `isPreviewUrlLive` — a dropped key
// is never re-served, the page simply re-renders on the next request.
const previewUrls = new Map<string, string>();
const previewOrder: string[] = [];
const MAX_PREVIEW_URLS = 8;

function previewCacheKey(renderId: string, pageNumber: number): string {
  return `${renderId}:${pageNumber}`;
}

function revokePreviewUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Best effort.
  }
}

function previewCacheTouch(key: string, url: string): void {
  previewUrls.set(key, url);
  const index = previewOrder.indexOf(key);
  if (index >= 0) {
    previewOrder.splice(index, 1);
  }
  previewOrder.push(key);
  while (previewOrder.length > MAX_PREVIEW_URLS) {
    const oldest = previewOrder.shift();
    if (oldest !== undefined && oldest !== key) {
      const evicted = previewUrls.get(oldest);
      previewUrls.delete(oldest);
      if (evicted !== undefined) {
        revokePreviewUrl(evicted);
      }
    }
  }
}

function previewCacheHit(key: string): string | undefined {
  const hit = previewUrls.get(key);
  if (hit === undefined) {
    return undefined;
  }
  const index = previewOrder.indexOf(key);
  if (index >= 0) {
    previewOrder.splice(index, 1);
    previewOrder.push(key);
  }
  return hit;
}

/**
 * Validity check for a borrowed preview URL: true while `url` is still
 * the live cached entry for (renderId, page). Evicted/purged keys fail,
 * so a revoked URL is never mistaken for a live one.
 */
export function isPreviewUrlLive(renderId: string, pageNumber: number, url: string): boolean {
  return previewUrls.get(previewCacheKey(renderId, pageNumber)) === url;
}

/** Test-only access to the preview cache (eviction + validity). */
export const __previewCacheForTests = {
  max: MAX_PREVIEW_URLS,
  key: previewCacheKey,
  touch: previewCacheTouch,
  hit: previewCacheHit,
  live: isPreviewUrlLive,
  size(): number {
    return previewUrls.size;
  },
  has(renderId: string, pageNumber: number): boolean {
    return previewUrls.has(previewCacheKey(renderId, pageNumber));
  },
  clearForTests(): void {
    for (const url of previewUrls.values()) {
      revokePreviewUrl(url);
    }
    previewUrls.clear();
    previewOrder.length = 0;
  },
};

/** Revokes and drops every cached preview rendered from `renderId`. */
function purgePreviewsForRender(renderId: string): void {
  const prefix = `${renderId}:`;
  for (const key of [...previewUrls.keys()]) {
    if (key.startsWith(prefix)) {
      const url = previewUrls.get(key);
      previewUrls.delete(key);
      const index = previewOrder.indexOf(key);
      if (index >= 0) {
        previewOrder.splice(index, 1);
      }
      if (url !== undefined) {
        revokePreviewUrl(url);
      }
    }
  }
}

/** Cancellable full-resolution preview job (mirrors `studioThumbWindow`). */
export interface StudioPreviewJob {
  done: Promise<string>;
  cancel: () => void;
}

/**
 * Full-resolution preview as an object URL (service-owned, borrowed by
 * the caller — see the ownership rule above; never revoke the result).
 * Returns a cancellable job: the caller awaits `done` and calls `cancel`
 * on cleanup/unmount so a superseded render never writes the cache.
 *
 * Render scale is capped to the display (`devicePixelRatio`, max 2)
 * instead of a fixed scale 2: at 1× the dialog shows ~768 CSS px, so a
 * fixed scale-2 render over-renders by 2× for no visible gain.
 */
export function studioPreview(docId: string, pageNumber: number): StudioPreviewJob {
  let cancelled = false;
  let cancelActive: (() => void) | null = null;
  const done = (async (): Promise<string> => {
    const { renders } = await engines();
    if (cancelled) {
      throw toStudioError(
        { code: 'CANCELLED', message: 'preview job was cancelled' },
        'pdf.inspect',
      );
    }
    const renderId = renderDocIds.get(docId);
    if (renderId === undefined) {
      throw toStudioError(
        { code: 'INVALID_INPUT', message: 'document is no longer open' },
        'pdf.inspect',
      );
    }
    const key = previewCacheKey(renderId, pageNumber);
    const cached = previewCacheHit(key);
    if (cached !== undefined) {
      return cached;
    }
    let dpr = 1;
    try {
      const v = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        dpr = Math.min(v, 3);
      }
    } catch {
      // Non-DOM (unit tests): fall through at 1×.
    }
    const scale = Math.min(2, Math.max(1, dpr));
    const canvas = document.createElement('canvas');
    const job = renders.renderPage(renderId, pageNumber, canvas, { scale });
    cancelActive = (): void => job.cancel();
    const cancel = (): void => job.cancel();
    trackThumbJob(docId, cancel);
    const endRender = beginPerfSpan('studio:preview:render');
    try {
      await job.promise;
    } finally {
      endRender();
    }
    if (cancelled) {
      canvas.width = 0;
      canvas.height = 0;
      throw toStudioError(
        { code: 'CANCELLED', message: 'preview job was cancelled' },
        'pdf.inspect',
      );
    }
    // Never resurrect a dropped entry: a close mid-flight fails instead
    // of caching under a stale key.
    if (renderDocIds.get(docId) === undefined) {
      canvas.width = 0;
      canvas.height = 0;
      throw toStudioError(
        { code: 'INVALID_INPUT', message: 'document is no longer open' },
        'pdf.inspect',
      );
    }
    const endEncode = beginPerfSpan('studio:preview:encode');
    try {
      const url = await canvasToUrl(canvas);
      if (cancelled) {
        revokePreviewUrl(url);
        throw toStudioError(
          { code: 'CANCELLED', message: 'preview job was cancelled' },
          'pdf.inspect',
        );
      }
      previewCacheTouch(key, url);
      return url;
    } finally {
      endEncode();
      untrackThumbJob(docId, cancel);
      canvas.width = 0;
      canvas.height = 0;
    }
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
      cancelActive?.();
    },
  };
}

/**
 * Direct save via anchor (user-gesture download, same as Studio UX).
 * Accepts bytes or an existing Blob: passing the Blob avoids a second
 * copy when the caller already built one for its completion UI. The
 * object URL is revoked after 60s (generous download-start window).
 */
export function studioDownload(bytes: Uint8Array | Blob, name: string): void {
  // Sanitize here (not just at callers) so every download path is safe
  // even when a caller passes a raw user-typed or overlong name.
  const safeName = sanitizeFileName(name);
  const blob =
    bytes instanceof Blob
      ? bytes
      : new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Deliberate share (explicit user tap only). */
export async function studioShare(
  bytes: Uint8Array | Blob,
  name: string,
): Promise<'shared' | 'unavailable'> {
  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean;
    share?: (data: { files?: File[]; title?: string }) => Promise<void>;
  };
  if (!nav.share || !nav.canShare) {
    return 'unavailable';
  }
  // Same sanitize-as-the-last-mile policy as `studioDownload`: the share
  // sheet must never receive a raw caller-provided filename.
  const safeName = sanitizeFileName(name);
  const blob =
    bytes instanceof Blob
      ? bytes
      : new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const file = new File([blob], safeName, { type: 'application/pdf' });
  if (!nav.canShare({ files: [file] })) {
    return 'unavailable';
  }
  try {
    await nav.share({ files: [file], title: safeName });
    return 'shared';
  } catch {
    return 'unavailable';
  }
}

export function studioShareAvailable(): boolean {
  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean;
  };
  try {
    return (
      !!nav.canShare &&
      nav.canShare({ files: [new File([new Blob(['x'])], 't.pdf', { type: 'application/pdf' })] })
    );
  } catch {
    return false;
  }
}

export function studioStripExt(name: string): string {
  return name.replace(/\.\w+$/, '');
}

/**
 * Cheap pre-gate before the real load: true when the first bytes contain
 * a `%PDF` header. Deliberately permissive — a UTF-8 BOM or stray leading
 * whitespace/newlines must not reject an otherwise valid document, and
 * tiny-but-well-formed headers (`%PDF-`, 5 bytes) pass too. The real
 * verdict always belongs to the engine/render load that follows; this
 * only filters out obvious non-PDFs (empty buffers, image bytes).
 *
 * Exported for unit tests; production callers go through `openStudioBytes`.
 */
export function isPdfBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 5) {
    return false;
  }
  // Scan the first bytes for `%PDF` so BOM/whitespace-prefixed headers
  // pass. The window stays small on purpose: anything the gate accepts
  // still faces the engine load, which rejects non-PDFs for real.
  const windowEnd = Math.min(bytes.length - 3, 16);
  for (let i = 0; i < windowEnd; i += 1) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46
    ) {
      return true;
    }
  }
  return false;
}

/** Test-only reset (drops engines, bytes, URLs). Not used by the app. */
export async function __resetStudioForTests(): Promise<void> {
  thumbJobs.forEach((set) => {
    set.forEach((cancel) => {
      try {
        cancel();
      } catch {
        // Ignore.
      }
    });
  });
  thumbJobs.clear();
  for (const docId of [...thumbUrls.keys()]) {
    revokeDocUrls(docId);
  }
  for (const url of previewUrls.values()) {
    revokePreviewUrl(url);
  }
  previewUrls.clear();
  previewOrder.length = 0;
  if (renders !== null) {
    for (const renderId of renderDocIds.values()) {
      await renders.closeDocument(renderId).catch(() => undefined);
    }
  }
  renderDocIds.clear();
  binaries.clear();
  adapter = null;
  renders = null;
  thumbs = null;
}
