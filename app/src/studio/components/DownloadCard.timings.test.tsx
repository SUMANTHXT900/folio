/**
 * `DownloadCard` timings export tests (F-22 shutter localize): the dev-only
 * "Download timings JSON" button renders beside Download on dev hosts only,
 * snapshots the span log to a `timings-<smartname>-<timestamp>.json` anchor
 * download on tap (never auto), and renders nothing extra on production.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadCard } from './DownloadCard';
import { markCaptureSpan, resetCaptureSpans } from '../tools/captureSpans';

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
  let counter = 0;
  URL.createObjectURL = vi.fn(() => {
    counter += 1;
    return `blob:card-${counter}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetCaptureSpans();
  Object.defineProperty(window, 'location', {
    value: realLocation,
    configurable: true,
    writable: true,
  });
});

function renderCard() {
  const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
  render(<DownloadCard blob={blob} suggestedName="scan-docs.pdf" />);
}

function timingsAnchorDownload(): string | null {
  const createSpy = vi.spyOn(document, 'createElement');
  fireEvent.click(screen.getByRole('button', { name: 'Download timings JSON' }));
  for (const result of createSpy.mock.results) {
    const el = result.value as unknown;
    if (
      el instanceof HTMLAnchorElement &&
      typeof el.download === 'string' &&
      el.download.startsWith('timings-')
    ) {
      return el.download;
    }
  }
  return null;
}

describe('DownloadCard timings export (gate on)', () => {
  it('renders the timings button beside Download', () => {
    renderCard();
    expect(screen.getByRole('link', { name: 'Download PDF' })).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'Download timings JSON' });
    expect(btn.textContent).toBe('Download timings JSON');
  });

  it('downloads a timings JSON snapshot named timings-<smartname>-<timestamp>.json', async () => {
    markCaptureSpan('tap');
    markCaptureSpan('build-end');
    renderCard();
    const download = timingsAnchorDownload();
    expect(download).toMatch(/^timings-scan-docs-.*\.json$/);
    expect(download).not.toMatch(/[\\/:*?"<>|]/);

    const jsonCalls = (
      URL.createObjectURL as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.filter((call) => call[0] instanceof Blob && call[0].type === 'application/json');
    expect(jsonCalls).toHaveLength(1);
    const payload = JSON.parse(await (jsonCalls[0][0] as Blob).text()) as {
      device: unknown;
      spans: Array<{ step: string }>;
      summary: Record<string, number>;
    };
    expect(typeof payload.device).toBe('object');
    expect(payload.spans.map((s) => s.step)).toContain('tap');
    // The export tap marks `download` before snapshotting, so it is included.
    expect(payload.spans.map((s) => s.step)).toContain('download');
    expect(typeof payload.summary).toBe('object');
    expect(payload.summary['download']).toBeGreaterThanOrEqual(0);
  });
});

describe('DownloadCard timings export (gate off)', () => {
  it('renders no timings button on the production host', () => {
    stubHostname('folio-pdf.pages.dev');
    renderCard();
    expect(screen.getByRole('link', { name: 'Download PDF' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download timings JSON' })).toBeNull();
  });
});
