/**
 * `captureSpans` tests (F-22 shutter localize): dev-gate parity with About's
 * `DevChannelCard` host rule, span order + delta math, ring-cap eviction,
 * gate-off silence, export shape, timings filename, and the no-PII key set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_SPANS_CAP,
  exportCaptureSpansJSON,
  getCaptureSpans,
  isCaptureSpansEnabled,
  logCaptureSpansTable,
  markCaptureSpan,
  resetCaptureSpans,
  timingsFilename,
} from './captureSpans';

const realLocation = window.location;

function stubHostname(hostname: string) {
  Object.defineProperty(window, 'location', {
    value: { hostname },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  stubHostname('localhost');
  resetCaptureSpans();
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    value: realLocation,
    configurable: true,
    writable: true,
  });
  resetCaptureSpans();
  vi.restoreAllMocks();
});

describe('dev gate (About DevChannelCard parity)', () => {
  it('stays off on the production host only', () => {
    expect(isCaptureSpansEnabled('folio-pdf.pages.dev')).toBe(false);
  });

  it('stays on for local builds, dev previews, and LAN origins', () => {
    expect(isCaptureSpansEnabled('localhost')).toBe(true);
    expect(isCaptureSpansEnabled('127.0.0.1')).toBe(true);
    expect(isCaptureSpansEnabled('dev-folio-pdf.pages.dev')).toBe(true);
    expect(isCaptureSpansEnabled('folio-abc123.pages.dev')).toBe(true);
    expect(isCaptureSpansEnabled('192.168.1.5')).toBe(true);
  });

  it('records zero marks when the gate is off', () => {
    stubHostname('folio-pdf.pages.dev');
    markCaptureSpan('tap');
    markCaptureSpan('pill');
    markCaptureSpan('takePhoto-start');
    expect(getCaptureSpans()).toEqual([]);
    expect(exportCaptureSpansJSON().spans).toEqual([]);
    expect(exportCaptureSpansJSON().summary).toEqual({});
  });
});

describe('span order + delta math', () => {
  it('keeps insertion order with ms since prev and totalMs since tap', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1250).mockReturnValueOnce(1300);
    markCaptureSpan('tap');
    markCaptureSpan('pill');
    markCaptureSpan('file-parked');
    const spans = getCaptureSpans();
    expect(spans.map((s) => s.step)).toEqual(['tap', 'pill', 'file-parked']);
    expect(spans.map((s) => s.ms)).toEqual([0, 250, 50]);
    expect(spans.map((s) => s.totalMs)).toEqual([0, 250, 300]);
    expect(spans.map((s) => s.t)).toEqual([1000, 1250, 1300]);
  });

  it('carries the 1-based page position on per-page drain steps', () => {
    markCaptureSpan('drain-decode', { n: 2 });
    const spans = getCaptureSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].n).toBe(2);
    expect(spans[0].step).toBe('drain-decode');
  });

  it('samples heap only when Chromium exposes it (never throws)', () => {
    markCaptureSpan('tap');
    const spans = getCaptureSpans();
    expect(spans).toHaveLength(1);
    if (spans[0].heapMB !== undefined) {
      expect(typeof spans[0].heapMB).toBe('number');
      expect(Number.isFinite(spans[0].heapMB as number)).toBe(true);
    }
  });

  it('keeps spans to durations + heap + names + counts (no PII shape)', () => {
    markCaptureSpan('drain-warp', { n: 1 });
    const spans = getCaptureSpans();
    expect(spans).toHaveLength(1);
    const keys = Object.keys(spans[0]).sort();
    expect(keys).toEqual(expect.arrayContaining(['ms', 'step', 't', 'totalMs']));
    for (const key of keys) {
      expect(['t', 'step', 'ms', 'totalMs', 'heapMB', 'n']).toContain(key);
    }
    expect(JSON.stringify(spans[0])).not.toMatch(/\.pdf|\.jpg|blob:/i);
  });
});

describe('ring cap eviction', () => {
  it(`holds at most ${CAPTURE_SPANS_CAP} spans, oldest evicted first`, () => {
    for (let i = 0; i < CAPTURE_SPANS_CAP + 5; i += 1) {
      markCaptureSpan(`s-${i}`);
    }
    const spans = getCaptureSpans();
    expect(spans).toHaveLength(CAPTURE_SPANS_CAP);
    expect(spans[0].step).toBe('s-5');
    expect(spans[spans.length - 1].step).toBe(`s-${CAPTURE_SPANS_CAP + 4}`);
  });
});

describe('export JSON shape', () => {
  it('returns device + spans copy + per-step totals', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1100).mockReturnValueOnce(1300);
    markCaptureSpan('tap');
    markCaptureSpan('pill');
    markCaptureSpan('tap');
    const out = exportCaptureSpansJSON();
    expect(typeof out.device).toBe('object');
    expect(out.spans.map((s) => s.step)).toEqual(['tap', 'pill', 'tap']);
    // Per-step totals: tap spans sum 0 + 200, pill sums 100.
    expect(out.summary).toEqual({ tap: 200, pill: 100 });
    // The spans array is a copy: mutating it never touches the session.
    out.spans.push({
      t: 0,
      step: 'forged',
      ms: 0,
      totalMs: 0,
    });
    expect(exportCaptureSpansJSON().spans).toHaveLength(3);
  });
});

describe('timingsFilename', () => {
  it('builds timings-<smartname>-<timestamp>.json', () => {
    const stamp = new Date(1_791_200_000_000).toISOString().replace(/[:.]/g, '-');
    expect(timingsFilename('scan-docs.pdf', 1_791_200_000_000)).toBe(
      `timings-scan-docs-${stamp}.json`,
    );
  });

  it('strips .pdf case-insensitively and falls back without an empty stem', () => {
    expect(timingsFilename('Report.PDF', 0)).toMatch(/^timings-Report-.*\.json$/);
    expect(timingsFilename('   ', 0)).toMatch(/^timings-scan-.*\.json$/);
    expect(timingsFilename('a-plus1-pages.pdf', 0)).toMatch(/^timings-a-plus1-pages-.*\.json$/);
  });

  it('emits no filesystem-illegal characters', () => {
    expect(timingsFilename('scan-docs.pdf')).not.toMatch(/[\\/:*?"<>|]/);
  });
});

describe('logCaptureSpansTable', () => {
  it('emits one console.table with per-step rows when gated on', () => {
    const table = vi.spyOn(console, 'table').mockImplementation(() => undefined);
    markCaptureSpan('tap');
    markCaptureSpan('build-end');
    logCaptureSpansTable();
    expect(table).toHaveBeenCalledTimes(1);
    const rows = table.mock.calls[0][0] as Array<{ step: string }>;
    expect(rows.map((r) => r.step).sort()).toEqual(['build-end', 'tap']);
  });

  it('stays silent when gated off or empty', () => {
    const table = vi.spyOn(console, 'table').mockImplementation(() => undefined);
    logCaptureSpansTable();
    expect(table).not.toHaveBeenCalled();
    stubHostname('folio-pdf.pages.dev');
    markCaptureSpan('tap');
    logCaptureSpansTable();
    expect(table).not.toHaveBeenCalled();
  });
});
