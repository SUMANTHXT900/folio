/**
 * Engine adapter tests: success, failure, cancellation, and event /
 * progress / result propagation through the real adapter boundary.
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockEngineAdapter, simulateDocument } from './MockEngineAdapter';
import { makePlaceholderPdf } from './placeholderPdf';
import type { EngineEvent, EngineRequest } from '../types/engine';

function pdfBytes(seed = 'test'): Uint8Array {
  const prefix = new TextEncoder().encode(`%PDF-1.7\n%${seed}\n`);
  const out = new Uint8Array(256);
  out.set(prefix);
  for (let i = prefix.length; i < out.length; i += 1) {
    out[i] = (i * 31 + seed.length) % 256;
  }
  return out;
}

function inspectRequest(): EngineRequest {
  return {
    operation: 'pdf.inspect',
    inputs: [{ name: 'sample.pdf', bytes: pdfBytes() }],
    options: { level: 'basic' },
  };
}

describe('MockEngineAdapter', () => {
  it('reports a successful inspect with lifecycle, progress, and timing', async () => {
    const adapter = new MockEngineAdapter();
    const seen: EngineEvent[] = [];
    const { jobId, done } = adapter.execute(inspectRequest());
    expect(jobId).toMatch(/^job-\d+$/);
    const unsubscribe = adapter.subscribe(jobId, (event) => seen.push(event));
    const finished = await done;
    unsubscribe();

    expect(finished.status).toBe('completed');
    expect(finished.operation).toBe('pdf.inspect');
    expect(finished.engineDurationMs).toBeGreaterThan(0);
    expect(Date.parse(finished.completedAt)).toBeGreaterThanOrEqual(Date.parse(finished.startedAt));
    expect(finished.progress).toBe(1);
    expect(finished.result?.summary).toMatchObject({ encrypted: false });
    expect(finished.simulated).toBe(true);

    const percentages = seen
      .filter((event) => event.percentage !== undefined)
      .map((event) => event.percentage as number);
    expect(percentages.length).toBeGreaterThan(0);
    for (let i = 1; i < percentages.length; i += 1) {
      expect(percentages[i]).toBeGreaterThanOrEqual(percentages[i - 1]);
    }
    expect(percentages[percentages.length - 1]).toBeLessThanOrEqual(1);
    expect(seen.every((event) => event.jobId === jobId)).toBe(true);
    expect(seen.every((event) => event.simulated)).toBe(true);
  });

  it('replays buffered events to late subscribers', async () => {
    const adapter = new MockEngineAdapter();
    const { jobId, done } = adapter.execute(inspectRequest());
    const finished = await done;
    const replayed: EngineEvent[] = [];
    const unsubscribe = adapter.subscribe(jobId, (event) => replayed.push(event));
    unsubscribe();
    expect(replayed.length).toBe(finished.events.length);
    expect(replayed[0].message).toContain('started');
  });

  it('fails non-PDF bytes with INVALID_DOCUMENT', async () => {
    const adapter = new MockEngineAdapter();
    const { done } = adapter.execute({
      operation: 'pdf.inspect',
      inputs: [
        { name: 'evil.txt', bytes: new TextEncoder().encode('hello world, not a pdf at all!!') },
      ],
      options: { level: 'basic' },
    });
    const finished = await done;
    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('INVALID_DOCUMENT');
    expect(finished.result).toBeUndefined();
  });

  it('fails out-of-range pages with PAGE_OUT_OF_RANGE', async () => {
    const adapter = new MockEngineAdapter();
    const { done } = adapter.execute({
      operation: 'pdf.extract_pages',
      inputs: [{ name: 'sample.pdf', bytes: pdfBytes() }],
      options: { pages: [999999] },
    });
    const finished = await done;
    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('PAGE_OUT_OF_RANGE');
    expect(finished.error?.details).toContain('page_count=');
  });

  it('fails reorder duplicates with DUPLICATE_PAGE and positions', async () => {
    const adapter = new MockEngineAdapter();
    // Find a seed with at least 3 pages (deterministic search, no randomness).
    let seedIndex = 0;
    let bytes = pdfBytes('dupe-0');
    while (simulateDocument('d.pdf', bytes).pageCount < 3 && seedIndex < 200) {
      seedIndex += 1;
      bytes = pdfBytes(`dupe-${seedIndex}`);
    }
    const count = simulateDocument('d.pdf', bytes).pageCount;
    expect(count).toBeGreaterThanOrEqual(3);
    const order = Array.from({ length: count }, (_, i) => i + 1);
    order[1] = order[0];
    const { done } = adapter.execute({
      operation: 'pdf.reorder',
      inputs: [{ name: 'd.pdf', bytes }],
      options: { order },
    });
    const finished = await done;
    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('DUPLICATE_PAGE');
    expect(finished.error?.details).toContain('first_position=');
    expect(finished.error?.details).toContain('duplicate_position=');
  });

  it('cancels mid-flight with CANCELLED status and no result', async () => {
    const adapter = new MockEngineAdapter();
    const { jobId, done } = adapter.execute({
      operation: 'pdf.extract_pages',
      inputs: [{ name: 'sample.pdf', bytes: pdfBytes('cancel-me') }],
      options: { pages: [1] },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await adapter.cancel(jobId);
    const finished = await done;
    expect(finished.status).toBe('cancelled');
    expect(finished.error?.code).toBe('CANCELLED');
    expect(finished.result).toBeUndefined();
  });

  it('produces downloadable output documents for extract', async () => {
    const adapter = new MockEngineAdapter();
    const { done } = adapter.execute({
      operation: 'pdf.extract_pages',
      inputs: [{ name: 'sample.pdf', bytes: pdfBytes() }],
      options: { pages: [1, 2] },
    });
    const finished = await done;
    expect(finished.status).toBe('completed');
    expect(finished.result?.outputs).toHaveLength(1);
    expect(finished.result?.outputs[0].byteLength).toBeGreaterThan(0);
  });

  it('completes images_to_pdf with one page per image', async () => {
    const adapter = new MockEngineAdapter();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
    const { done } = adapter.execute({
      operation: 'pdf.images_to_pdf',
      inputs: [
        { name: 'a.png', bytes: png },
        { name: 'b.jpg', bytes: jpeg },
      ],
      options: { pageSize: 'fit', backgroundRgb: [255, 255, 255] },
    });
    const finished = await done;
    expect(finished.status).toBe('completed');
    expect(finished.result?.summary).toMatchObject({ pageCount: 2 });
    expect(finished.result?.outputs).toHaveLength(1);
  });

  it('fails non-image bytes with UNSUPPORTED_FORMAT', async () => {
    const adapter = new MockEngineAdapter();
    const { done } = adapter.execute({
      operation: 'pdf.images_to_pdf',
      inputs: [{ name: 'evil.txt', bytes: new TextEncoder().encode('hello, not an image!!') }],
      options: { pageSize: 'fit', backgroundRgb: [255, 255, 255] },
    });
    const finished = await done;
    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('reads deterministic metadata with a typed date', async () => {
    const adapter = new MockEngineAdapter();
    const { done } = adapter.execute({
      operation: 'pdf.read_metadata',
      inputs: [{ name: 'sample.pdf', bytes: pdfBytes('meta-read') }],
      options: {},
    });
    const finished = await done;
    expect(finished.status).toBe('completed');
    expect(finished.result?.outputs).toHaveLength(0);
    const summary = finished.result?.summary;
    expect(summary !== undefined && 'metadata' in summary && !('pdfVersion' in summary)).toBe(true);
    if (summary !== undefined && 'metadata' in summary && !('pdfVersion' in summary)) {
      expect(summary.metadata.title).toBe('sample');
      expect(summary.metadata.creationDate).toMatchObject({ year: 2026, tzOffsetMinutes: 330 });
    }
  });

  it('writes a metadata output document and rejects empty set-values', async () => {
    const adapter = new MockEngineAdapter();
    const ok = await adapter.execute({
      operation: 'pdf.set_metadata',
      inputs: [{ name: 'sample.pdf', bytes: pdfBytes('meta-set') }],
      options: { patch: { title: { op: 'set', value: 'T' }, author: { op: 'clear' } } },
    }).done;
    expect(ok.status).toBe('completed');
    expect(ok.result?.outputs).toHaveLength(1);
    expect(ok.result?.outputs[0].name).toContain('-metadata.pdf');

    const bad = await adapter.execute({
      operation: 'pdf.set_metadata',
      inputs: [{ name: 'sample.pdf', bytes: pdfBytes('meta-set') }],
      options: { patch: { title: { op: 'set', value: '' } } },
    }).done;
    expect(bad.status).toBe('failed');
    expect(bad.error?.code).toBe('INVALID_INPUT');
  });
});

describe('makePlaceholderPdf', () => {
  it('emits structurally coherent bytes', () => {
    const bytes = makePlaceholderPdf(3, 'check');
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text).toContain('/Count 3');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // Every xref offset must point at an object header.
    const xrefAt = text.indexOf('xref\n');
    const trailerAt = text.indexOf('trailer\n');
    const entries = text
      .slice(xrefAt, trailerAt)
      .split('\n')
      .slice(2)
      .filter((line) => line.endsWith(' n '));
    expect(entries.length).toBe(6); // catalog + pages + 3 pages + info
    for (const entry of entries) {
      const offset = Number.parseInt(entry.slice(0, 10), 10);
      expect(text.slice(offset, offset + 20)).toMatch(/^\d+ 0 obj/);
    }
  });

  it('writes a copy to the temp dir for verification with the real engine', () => {
    const bytes = makePlaceholderPdf(3, 'verify-me', [{ rotationDeg: 90 }]);
    const path = join(tmpdir(), 'folio-placeholder-check.pdf');
    writeFileSync(path, bytes);
    expect(path).toContain('folio-placeholder-check.pdf');
  });
});
