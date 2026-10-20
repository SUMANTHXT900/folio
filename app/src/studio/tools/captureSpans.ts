/**
 * F-22 shutter localize — dev-only per-step timing + memory for the capture pipeline.
 *
 * On-call questions this answers (instrument-as-you-build):
 * 1. Where does wall time go between shutter tap and committed pages?
 * 2. Is a slow capture the sensor (`takePhoto`), the ML drain
 *    (decode/detect/warp), or the commit (`build`) on THIS phone?
 * 3. Does heap pressure (`heapMB`) correlate with the slow step?
 *
 * Design:
 * - Bounded ring buffer (cap 200 spans, oldest evicted) of
 *   `{ t, step, ms, totalMs, heapMB?, n? }`: `ms` is the delta since the
 *   previous span, `totalMs` since the session tap, `heapMB` is a
 *   Chromium-only `performance.memory` sample (guarded try/catch, omitted
 *   elsewhere), `n` is the 1-based page position for per-page drain steps.
 * - Step vocabulary is fixed strings only — durations + heap numbers + step
 *   names + counts. No doc bytes, filenames, or PII ever enter a span.
 * - Dev-gate: same host rule as About's `DevChannelCard` (`folioChannel` —
 *   every host except the production host is a dev build). All marks no-op
 *   behind a single boolean check when the gate is off, so production
 *   rendering stays byte-identical at near-zero cost.
 * - `console.table` summary fires once on completion (build end) when gated
 *   on, for desktop debugging. Export (`exportCaptureSpansJSON`) feeds the
 *   dev-only "Download timings JSON" button in `DownloadCard` — user taps
 *   only, never auto-downloaded (browsers block multi-download).
 *
 * Pure module otherwise — no DOM, no React — so it is unit-testable here.
 */

/** Ring-buffer cap: oldest spans evict first (L-4 discipline). */
export const CAPTURE_SPANS_CAP = 200;

/** Production host — the only host where spans stay off (mirrors About `folioChannel`). */
export const CAPTURE_SPANS_PROD_HOST = 'folio-pdf.pages.dev';

/** One timing mark: durations + heap numbers + step names + counts only. */
export interface CaptureSpan {
  /** Monotonic mark time (`performance.now` base, `Date.now` fallback). */
  t: number;
  /** Fixed-vocabulary step name (never a filename, URL, or user string). */
  step: string;
  /** Delta since the previous span (0 for the first). */
  ms: number;
  /** Delta since the session's first span (0 for the first). */
  totalMs: number;
  /** Chromium-only heap sample in MiB (omitted where unavailable). */
  heapMB?: number;
  /** 1-based page position for per-page drain steps. */
  n?: number;
}

/** Export shape: device facts + span log + per-step totals. */
export interface CaptureTimingsExport {
  device: { hardwareConcurrency?: number; deviceMemory?: number };
  spans: CaptureSpan[];
  /** Per-step totals (sum of `ms` per step name). */
  summary: Record<string, number>;
}

function currentHostname(): string {
  try {
    const h = typeof window !== 'undefined' ? window.location?.hostname : '';
    return typeof h === 'string' ? h : '';
  } catch {
    return '';
  }
}

/**
 * Dev gate: on for every host except production (same pattern as About's
 * `DevChannelCard`, which renders on every channel except production).
 * An explicit hostname override exists for unit tests; callers pass none.
 */
export function isCaptureSpansEnabled(hostname?: string): boolean {
  const host = hostname ?? currentHostname();
  return host !== CAPTURE_SPANS_PROD_HOST;
}

function now(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {
    // Fall through to the Date fallback below.
  }
  return Date.now();
}

/** Chromium-only heap sample; undefined everywhere else (never throws). */
function sampleHeapMB(): number | undefined {
  try {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: unknown } })?.memory;
    const bytes = mem?.usedJSHeapSize;
    if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) {
      return bytes / 1048576;
    }
  } catch {
    // Absent outside Chromium — the span simply carries no heap sample.
  }
  return undefined;
}

function sampleDevice(): CaptureTimingsExport['device'] {
  const device: CaptureTimingsExport['device'] = {};
  try {
    const nav = globalThis.navigator as unknown as
      { hardwareConcurrency?: unknown; deviceMemory?: unknown } | undefined;
    if (typeof nav?.hardwareConcurrency === 'number' && Number.isFinite(nav.hardwareConcurrency)) {
      device.hardwareConcurrency = nav.hardwareConcurrency;
    }
    if (typeof nav?.deviceMemory === 'number' && Number.isFinite(nav.deviceMemory)) {
      device.deviceMemory = nav.deviceMemory;
    }
  } catch {
    // Device facts are best-effort evidence, never load-bearing.
  }
  return device;
}

let spans: CaptureSpan[] = [];

/**
 * Records one span. Single boolean gate check when off (near-zero cost);
 * production call sites stay bare `markCaptureSpan('…')` calls.
 */
export function markCaptureSpan(step: string, extra?: { n?: number }): void {
  if (!isCaptureSpansEnabled()) return;
  const t = now();
  const prev = spans.length > 0 ? spans[spans.length - 1] : null;
  const first = spans.length > 0 ? spans[0] : null;
  const heapMB = sampleHeapMB();
  const span: CaptureSpan = {
    t,
    step,
    ms: prev !== null ? t - prev.t : 0,
    totalMs: first !== null ? t - first.t : 0,
    ...(heapMB !== undefined ? { heapMB } : {}),
    ...(extra?.n !== undefined ? { n: extra.n } : {}),
  };
  spans.push(span);
  if (spans.length > CAPTURE_SPANS_CAP) {
    spans.splice(0, spans.length - CAPTURE_SPANS_CAP);
  }
}

/** Opens a fresh timing session (scanner mount). Ungated: recording nothing is free. */
export function resetCaptureSpans(): void {
  spans = [];
}

/** Read-only copy of the session spans (oldest first). */
export function getCaptureSpans(): CaptureSpan[] {
  return spans.map((s) => ({ ...s }));
}

/**
 * Exportable snapshot: device facts + span log + per-step totals.
 * Counts + durations only — no doc bytes, filenames, or PII.
 */
export function exportCaptureSpansJSON(): CaptureTimingsExport {
  const summary: Record<string, number> = {};
  for (const s of spans) summary[s.step] = (summary[s.step] ?? 0) + s.ms;
  return { device: sampleDevice(), spans: getCaptureSpans(), summary };
}

/**
 * Single `console.table` summary on completion (desktop debugging).
 * No-op when gated off or when nothing was recorded.
 */
export function logCaptureSpansTable(): void {
  if (!isCaptureSpansEnabled()) return;
  if (spans.length === 0) return;
  const totals: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const s of spans) {
    totals[s.step] = (totals[s.step] ?? 0) + s.ms;
    counts[s.step] = (counts[s.step] ?? 0) + 1;
  }
  const rows = Object.entries(totals).map(([step, totalMs]) => ({
    step,
    totalMs: Math.round(totalMs * 10) / 10,
    count: counts[step] ?? 0,
  }));
  console.table(rows);
}

/**
 * Timings download filename: `timings-<smartname>-<timestamp>.json`.
 * The `.pdf` suffix is stripped (this is JSON, never a PDF); the ISO stamp
 * has `:`/`.` replaced so the name is safe on every filesystem.
 */
export function timingsFilename(smartName: string, nowMs: number = Date.now()): string {
  const stem = smartName.replace(/\.pdf$/i, '').trim() || 'scan';
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return `timings-${stem}-${stamp}.json`;
}
