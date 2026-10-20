/**
 * `usePdfFiles` 150MB gate tests: over-limit batches are BLOCKED with an
 * honest message before any bytes are read (never opened with an advisory
 * notice). The engine's 100MB per-file cap (`MAX_PDF_BYTES`) stays as the
 * backstop — this suite pins the hook-side total-bytes gate only.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/folio', () => ({
  openStudioDocs: vi.fn(),
  closeStudioDoc: vi.fn(async () => undefined),
}));

import { openStudioDocs } from '../services/folio';
import { usePdfFiles } from './usePdfFiles';
import type { StudioDoc } from './usePdfFiles';

const openMock = vi.mocked(openStudioDocs);

/** A PDF File whose `size` reads as `bytes` without allocating them. */
function sizedPdf(name: string, bytes: number): File {
  const file = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: bytes, configurable: true });
  return file;
}

function doc(id: string, sizeBytes: number): StudioDoc {
  return { id, name: `${id}.pdf`, sizeBytes, pageCount: 1 };
}

beforeEach(() => {
  openMock.mockReset();
  openMock.mockImplementation(async (files: File[]) =>
    files.map((f, i) => doc(`studio-${i}`, f.size)),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('usePdfFiles 150MB gate', () => {
  it('blocks an over-limit batch with an honest message and never opens it', async () => {
    const { result } = renderHook(() => usePdfFiles());
    const big = sizedPdf('big.pdf', 151 * 1024 * 1024);

    await act(async () => {
      await result.current.addFiles([big]);
    });

    expect(openMock).not.toHaveBeenCalled();
    expect(result.current.files).toHaveLength(0);
    expect(result.current.error).toMatch(/were not opened/);
    expect(result.current.error).toMatch(/150MB/);
    expect(result.current.busy).toBe(false);
  });

  it('blocks on cumulative bytes (existing + incoming), not just single files', async () => {
    const { result } = renderHook(() => usePdfFiles());
    await act(async () => {
      await result.current.addFiles([sizedPdf('a.pdf', 100 * 1024 * 1024)]);
    });
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.addFiles([sizedPdf('b.pdf', 60 * 1024 * 1024)]);
    });

    // The second batch is refused; the first stays open and untouched.
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(result.current.files).toHaveLength(1);
    expect(result.current.error).toMatch(/were not opened/);
  });

  it('opens under-limit batches exactly as before (no gate regression)', async () => {
    const { result } = renderHook(() => usePdfFiles());
    await act(async () => {
      await result.current.addFiles([sizedPdf('a.pdf', 1024), sizedPdf('b.pdf', 2048)]);
    });

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(result.current.files).toHaveLength(2);
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it('keeps intake-error detail plumbing intact (P1 regression guard)', async () => {
    const failure = Object.assign(new Error('That file is not a readable PDF.'), {
      code: 'INVALID_DOCUMENT',
    });
    openMock.mockRejectedValueOnce(failure);
    const { result } = renderHook(() => usePdfFiles());

    await act(async () => {
      await result.current.addFiles([sizedPdf('bad.pdf', 1024)]);
    });

    expect(result.current.error).toBe('That file is not a readable PDF.');
    expect((result.current.errorDetail as { code?: string } | null)?.code).toBe('INVALID_DOCUMENT');
  });
});
