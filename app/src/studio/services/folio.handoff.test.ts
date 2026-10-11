/**
 * Cross-tool handoff tests (`adoptOutputsAsDocs` + pending transfer).
 *
 * The engine/rendering modules are mocked: `adoptOutputsAsDocs` registers
 * through the real `openStudioBytes` intake, but the PDF.js load behind it
 * is a deterministic fake (pageCount 7, render ids `renderdoc-mock-N`).
 * Zero-copy is asserted at this layer — the store and the intake see the
 * exact same `Uint8Array` view (the defensive copy for PDF.js lives inside
 * the real `PdfJsRenderEngine`, L-2, and is not re-implemented here).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handoffMock = vi.hoisted(() => ({
  loads: [] as Array<{ data: Uint8Array; name: string | undefined }>,
  closed: [] as string[],
  failures: new Map<string, { code?: string; message: string }>(),
}));

vi.mock('../../engine/WasmWorkerEngineAdapter', () => ({
  WasmWorkerEngineAdapter: class {
    execute(): never {
      throw new Error('handoff tests never execute engine operations');
    }

    cancel(): Promise<void> {
      return Promise.resolve();
    }

    subscribe(): () => void {
      return () => undefined;
    }
  },
}));

vi.mock('../../rendering/DefaultPdfThumbnailEngine', () => ({
  DefaultPdfThumbnailEngine: class {
    constructor(_renderEngine: unknown) {
      void _renderEngine;
    }
  },
}));

vi.mock('../../rendering/PdfJsRenderEngine', () => ({
  PdfJsRenderEngine: class {
    loadDocument(input: { data: Uint8Array; name?: string }): {
      promise: Promise<{
        document: { id: string; pageCount: number; name: string; metadata: null };
        timing: { startedAt: string; completedAt: string; durationMs: number };
      }>;
      cancel: () => void;
    } {
      handoffMock.loads.push({ data: input.data, name: input.name });
      const failure = input.name === undefined ? undefined : handoffMock.failures.get(input.name);
      if (failure !== undefined) {
        const error = new Error(failure.message) as Error & { code?: string };
        error.code = failure.code;
        return { promise: Promise.reject(error), cancel: () => undefined };
      }
      const id = `renderdoc-mock-${handoffMock.loads.length}`;
      return {
        promise: Promise.resolve({
          document: { id, pageCount: 7, name: input.name ?? 'document.pdf', metadata: null },
          timing: {
            startedAt: new Date(0).toISOString(),
            completedAt: new Date(0).toISOString(),
            durationMs: 0,
          },
        }),
        cancel: () => undefined,
      };
    }

    closeDocument(documentId: string): Promise<void> {
      handoffMock.closed.push(documentId);
      return Promise.resolve();
    }
  },
}));

import {
  __resetStudioForTests,
  __studioBinariesForTests,
  adoptOutputsAsDocs,
  clearPendingTransfer,
  closeStudioDoc,
  consumePendingTransfer,
  getStudioBytes,
  peekPendingTransfer,
  setPendingTransfer,
  type PendingTransfer,
  type StudioOutput,
} from './folio';

function pdfBytes(seed: number, length = 16): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x25;
  bytes[1] = 0x50;
  bytes[2] = 0x44;
  bytes[3] = 0x46;
  bytes[4] = 0x2d;
  for (let i = 5; i < length; i += 1) {
    bytes[i] = (seed + i) & 0xff;
  }
  return bytes;
}

function output(name: string, seed: number): StudioOutput {
  const bytes = pdfBytes(seed);
  return { name, bytes, byteLength: bytes.length, pageCount: 7 };
}

beforeEach(async () => {
  await __resetStudioForTests();
  handoffMock.loads.length = 0;
  handoffMock.closed.length = 0;
  handoffMock.failures.clear();
});

describe('adoptOutputsAsDocs', () => {
  it('throws an honest structured error on empty outputs', async () => {
    const error = await adoptOutputsAsDocs([], 'report.pdf').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeGreaterThan(0);
    expect(error).toMatchObject({ code: 'INVALID_INPUT', operation: 'pdf.inspect' });
    expect(__studioBinariesForTests.size()).toBe(0);
  });

  it('adopts a single output by reference with no copy', async () => {
    const out = output('merged.pdf', 11);
    const docs = await adoptOutputsAsDocs([out], 'a.pdf');
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.name).toBe('merged.pdf');
    expect(doc.sizeBytes).toBe(out.bytes.length);
    expect(doc.pageCount).toBe(7);
    expect(doc.id.startsWith('studio-')).toBe(true);
    // Zero copies: the store holds the exact same view the output carried.
    expect(getStudioBytes(doc.id)).toBe(out.bytes);
    // The intake saw the same view too — the defensive copy for PDF.js
    // lives inside the real render engine (L-2), not at this layer.
    expect(handoffMock.loads).toHaveLength(1);
    expect(handoffMock.loads[0].data).toBe(out.bytes);
    expect(handoffMock.loads[0].name).toBe('merged.pdf');
  });

  it('preserves order and names across multi-output adoption', async () => {
    const outs = [output('part-a.pdf', 1), output('part-b.pdf', 2), output('part-c.pdf', 3)];
    const docs = await adoptOutputsAsDocs(outs, 'report.pdf');
    expect(docs.map((d) => d.name)).toEqual(['part-a.pdf', 'part-b.pdf', 'part-c.pdf']);
    const ids = docs.map((d) => d.id);
    expect(new Set(ids).size).toBe(3);
    for (let i = 0; i < outs.length; i += 1) {
      expect(getStudioBytes(ids[i])).toBe(outs[i].bytes);
    }
    expect(handoffMock.loads.map((l) => l.name)).toEqual([
      'part-a.pdf',
      'part-b.pdf',
      'part-c.pdf',
    ]);
  });

  it('keeps the caller sourceName out of adopted names (no stacking)', async () => {
    const outs = [output('report-p1-2.pdf', 4), output('report-p3-5.pdf', 5)];
    const docs = await adoptOutputsAsDocs(outs, 'report-rearranged.pdf');
    expect(docs.map((d) => d.name)).toEqual(['report-p1-2.pdf', 'report-p3-5.pdf']);
    // The verbatim source threads through the transfer for downstream
    // smartOutputName chaining instead of stacking onto output names.
    setPendingTransfer(docs, 'report-rearranged.pdf', 'split');
    expect(peekPendingTransfer()?.sourceName).toBe('report-rearranged.pdf');
  });

  it('returns lightweight handles with no bytes', async () => {
    const docs = await adoptOutputsAsDocs([output('a.pdf', 6)], 'a.pdf');
    expect(Object.keys(docs[0]).sort()).toEqual(['id', 'name', 'pageCount', 'sizeBytes']);
  });

  it('rolls back partial adoption on invalid input without leaking', async () => {
    const bad: StudioOutput = {
      name: 'bad.pdf',
      bytes: new Uint8Array([1, 2, 3]),
      byteLength: 3,
      pageCount: null,
    };
    const error = await adoptOutputsAsDocs([output('ok.pdf', 7), bad], 'src.pdf').catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'INVALID_DOCUMENT', operation: 'pdf.inspect' });
    // The first doc was registered (one intake load) then closed again:
    // render doc closed, bytes freed, nothing retained.
    expect(handoffMock.loads).toHaveLength(1);
    expect(handoffMock.closed).toHaveLength(1);
    expect(__studioBinariesForTests.size()).toBe(0);
  });

  it('never swallows CANCELLED', async () => {
    handoffMock.failures.set('part-2.pdf', { code: 'CANCELLED', message: 'cancelled' });
    const error = await adoptOutputsAsDocs(
      [output('part-1.pdf', 8), output('part-2.pdf', 9)],
      'src.pdf',
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CANCELLED' });
    expect(__studioBinariesForTests.size()).toBe(0);
    expect(handoffMock.closed).toHaveLength(1);
  });

  it('closing an adopted doc frees its bytes (P5-1 hygiene)', async () => {
    const docs = await adoptOutputsAsDocs([output('a.pdf', 10)], 'a.pdf');
    expect(getStudioBytes(docs[0].id)).toBeDefined();
    await closeStudioDoc(docs[0].id);
    expect(getStudioBytes(docs[0].id)).toBeUndefined();
    expect(__studioBinariesForTests.size()).toBe(0);
    expect(handoffMock.closed).toHaveLength(1);
  });
});

describe('pending transfer', () => {
  it('stages, peeks, and single-consumes a transfer', async () => {
    const before = Date.now();
    const docs = await adoptOutputsAsDocs([output('m.pdf', 20)], 'a.pdf');
    const id = setPendingTransfer(docs, 'a.pdf', 'merge');
    expect(id.startsWith('transfer-')).toBe(true);

    const peeked: PendingTransfer | null = peekPendingTransfer();
    expect(peeked?.id).toBe(id);
    expect(peeked?.docs.map((d) => d.id)).toEqual(docs.map((d) => d.id));
    expect(peeked?.sourceName).toBe('a.pdf');
    expect(peeked?.producedBy).toBe('merge');
    expect(typeof peeked?.at).toBe('number');
    expect((peeked?.at ?? 0) >= before).toBe(true);

    // Peeking does not consume.
    expect(peekPendingTransfer()?.id).toBe(id);
    const consumed = consumePendingTransfer();
    expect(consumed?.id).toBe(id);
    expect(consumed?.docs.map((d) => d.id)).toEqual(docs.map((d) => d.id));
    // Single-consume: the slot is clear on read.
    expect(consumePendingTransfer()).toBeNull();
    expect(peekPendingTransfer()).toBeNull();
  });

  it('returns null when no transfer is pending', () => {
    expect(consumePendingTransfer()).toBeNull();
    expect(peekPendingTransfer()).toBeNull();
  });

  it('peek returns a copy that cannot reshape the slot', async () => {
    const docs = await adoptOutputsAsDocs([output('a.pdf', 28)], 'a.pdf');
    setPendingTransfer(docs, 'a.pdf', 'merge');
    const peeked = peekPendingTransfer();
    expect(peeked).not.toBeNull();
    peeked?.docs.push({ id: 'fake', name: 'fake.pdf', sizeBytes: 0, pageCount: 0 });
    expect(peekPendingTransfer()?.docs).toHaveLength(1);
    expect(consumePendingTransfer()?.docs).toHaveLength(1);
  });

  it('stores sourceName verbatim with no stacking or sanitize', async () => {
    const docs = await adoptOutputsAsDocs([output('x.pdf', 21)], 'x.pdf');
    setPendingTransfer(docs, 'x-rearranged.pdf', 'rearrange');
    expect(peekPendingTransfer()?.sourceName).toBe('x-rearranged.pdf');
  });

  it('replaces a previous pending transfer', async () => {
    const first = await adoptOutputsAsDocs([output('first.pdf', 22)], 'a.pdf');
    const second = await adoptOutputsAsDocs([output('second.pdf', 23)], 'b.pdf');
    const id1 = setPendingTransfer(first, 'a.pdf', 'merge');
    const id2 = setPendingTransfer(second, 'b.pdf', 'split');
    expect(id2).not.toBe(id1);
    const consumed = consumePendingTransfer();
    expect(consumed?.id).toBe(id2);
    expect(consumed?.sourceName).toBe('b.pdf');
    await closeStudioDoc(first[0].id);
    await closeStudioDoc(second[0].id);
  });

  it('copies the docs array on stage so caller mutation cannot reshape the slot', async () => {
    const docs = await adoptOutputsAsDocs([output('a.pdf', 24)], 'a.pdf');
    setPendingTransfer(docs, 'a.pdf', 'merge');
    docs.push({ id: 'fake', name: 'fake.pdf', sizeBytes: 0, pageCount: 0 });
    expect(peekPendingTransfer()?.docs).toHaveLength(1);
  });

  it('clears without taking', async () => {
    const docs = await adoptOutputsAsDocs([output('a.pdf', 25)], 'a.pdf');
    setPendingTransfer(docs, 'a.pdf', 'merge');
    clearPendingTransfer();
    expect(peekPendingTransfer()).toBeNull();
    expect(consumePendingTransfer()).toBeNull();
    // Docs stay caller-owned: still closable, bytes freed on close.
    await closeStudioDoc(docs[0].id);
    expect(getStudioBytes(docs[0].id)).toBeUndefined();
  });

  it('accepts tool ids and free-form producers', async () => {
    const docs = await adoptOutputsAsDocs([output('a.pdf', 26)], 'a.pdf');
    setPendingTransfer(docs, 'a.pdf', 'split');
    expect(peekPendingTransfer()?.producedBy).toBe('split');
    setPendingTransfer(docs, 'a.pdf', 'test-harness');
    expect(peekPendingTransfer()?.producedBy).toBe('test-harness');
  });

  it('test reset drops a staged transfer', async () => {
    const docs = await adoptOutputsAsDocs([output('a.pdf', 27)], 'a.pdf');
    setPendingTransfer(docs, 'a.pdf', 'merge');
    await __resetStudioForTests();
    expect(peekPendingTransfer()).toBeNull();
    handoffMock.loads.length = 0;
    handoffMock.closed.length = 0;
  });
});
