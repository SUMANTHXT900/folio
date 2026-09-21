/**
 * Large-file memory observability (Lesson 14).
 *
 * Thin, development-oriented diagnostics around the only browser memory
 * API available to the app (`performance.memory`, Chromium-only). Every
 * access is feature-detected: production behavior never depends on these
 * readings, and nothing here fabricates numbers — when the API is
 * absent the snapshot says `supported: false` and carries no values.
 *
 * Scope note: `performance.memory` reports the main-thread JS heap only.
 * PDF.js worker memory, GPU/canvas backing stores, and WASM linear
 * memory are invisible to it. Heap numbers therefore track Folio's own
 * retained references (binary store copies, event arrays, canvases) —
 * exactly the application-level surface Lesson 14 owns — and must never
 * be presented as total browser memory.
 */

/** One feature-detected main-thread heap reading. Values are MiB. */
export interface MemorySnapshot {
  /** False when `performance.memory` is unavailable: no values present. */
  supported: boolean;
  /** Live JS heap, when available. */
  usedJSHeapMB: number | null;
  /** Total allocated JS heap, when available. */
  totalJSHeapMB: number | null;
  /** JS heap limit, when available. */
  heapLimitMB: number | null;
}

interface PerformanceMemoryReading {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function readPerformanceMemory(): PerformanceMemoryReading | null {
  if (typeof performance === 'undefined') {
    return null;
  }
  const memory = (performance as unknown as { memory?: unknown }).memory;
  if (typeof memory !== 'object' || memory === null) {
    return null;
  }
  const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } =
    memory as Partial<PerformanceMemoryReading>;
  if (
    typeof usedJSHeapSize !== 'number' ||
    typeof totalJSHeapSize !== 'number' ||
    typeof jsHeapSizeLimit !== 'number'
  ) {
    return null;
  }
  return { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit };
}

/** Reads one heap snapshot. Never throws; degrades to `supported: false`. */
export function readMemorySnapshot(): MemorySnapshot {
  const reading = readPerformanceMemory();
  if (reading === null) {
    return { supported: false, usedJSHeapMB: null, totalJSHeapMB: null, heapLimitMB: null };
  }
  const toMB = (bytes: number): number => bytes / 1048576;
  return {
    supported: true,
    usedJSHeapMB: toMB(reading.usedJSHeapSize),
    totalJSHeapMB: toMB(reading.totalJSHeapSize),
    heapLimitMB: toMB(reading.jsHeapSizeLimit),
  };
}

/** Formats MiB for diagnostics (`null` → `'n/a'`, never throws). */
export function formatMB(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }
  return `${value.toFixed(1)} MB`;
}
