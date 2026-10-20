/**
 * Camera → Images handoff regression tests.
 *
 * The scanner used to prepare every page, then ImagesTool prepared the same
 * pages again, then the user had to press Build PDF a second time. This suite
 * pins the repaired contract: ONE commit call performs ONE import and starts
 * ONE engine build with the imported pages.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImagesTool from './ImagesTool';
import type { ScanicCommittedPage } from './ScanicCapture';
import { createPage, type ImagePage } from './imagePages';
import { buildImagesPdf } from './imageSharding';
import { useImagePages } from './useImagePages';

vi.mock('../components/ContinueCard', () => ({
  ContinueCard: () => <div data-testid="continue-card" />,
}));

vi.mock('./ScanicCapture', () => ({
  default: ({
    onCommit,
  }: {
    onCommit: (
      pages: ScanicCommittedPage[],
    ) => Promise<{ ok: true } | { ok: false; message: string } | void>;
  }) => (
    <button
      type="button"
      onClick={() =>
        void onCommit([
          {
            file: new File(['scan-bytes'], 'scan-001.jpg', { type: 'image/jpeg' }),
            name: 'scan-001.jpg',
          },
        ])
      }
    >
      Commit scan
    </button>
  ),
}));

vi.mock('./imageSharding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./imageSharding')>();
  return { ...actual, buildImagesPdf: vi.fn() as typeof actual.buildImagesPdf };
});

vi.mock('./useImagePages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useImagePages')>();
  return { ...actual, useImagePages: vi.fn() as typeof actual.useImagePages };
});

vi.mock('./PageGrid', () => ({
  PageGrid: ({ pages }: { pages: ImagePage[] }) => (
    <div data-testid="page-grid">{pages.length}</div>
  ),
}));

const buildImagesPdfMock = vi.mocked(buildImagesPdf);
const useImagePagesMock = vi.mocked(useImagePages);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('camera commit to build', () => {
  it('rolls back a partial import so a retry cannot duplicate pages', async () => {
    const added = createPage({
      id: 'partial-1',
      source: 'camera',
      file: new File(['partial'], 'scan-001.jpg', { type: 'image/jpeg' }),
      name: 'scan-001.jpg',
      width: 640,
      height: 480,
    });
    const removeMany = vi.fn();
    const importFiles = vi.fn(
      async (
        _files: File[],
        _source: string,
        callbacks?: { onCommitted?: (pages: ImagePage[]) => void },
      ) => {
        callbacks?.onCommitted?.([added]);
        return {
          added: 1,
          skipped: 0,
          failed: 1,
          cancelled: false,
          firstError: 'bad image',
        };
      },
    );
    useImagePagesMock.mockReturnValue({
      pages: [],
      addFiles: vi.fn(),
      addEntries: vi.fn(),
      importFiles,
      move: vi.fn(),
      remove: vi.fn(),
      removeMany,
      rotate: vi.fn(),
      clear: vi.fn(),
      reorder: vi.fn(),
    });

    render(<ImagesTool />);
    fireEvent.click(screen.getByRole('button', { name: /Scan/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit scan' }));

    await waitFor(() => expect(removeMany).toHaveBeenCalledWith([added]));
    expect(buildImagesPdfMock).not.toHaveBeenCalled();
  });

  it('imports once and auto-starts exactly one build with the imported pages', async () => {
    const added = createPage({
      id: 'scan-1',
      source: 'camera',
      file: new File(['scan-bytes'], 'scan-001.jpg', { type: 'image/jpeg' }),
      name: 'scan-001.jpg',
      width: 640,
      height: 480,
    });
    const importFiles = vi.fn(
      async (
        _files: File[],
        _source: string,
        callbacks?: { onCommitted?: (pages: ImagePage[]) => void },
      ) => {
        callbacks?.onCommitted?.([added]);
        return { added: 1, skipped: 0, failed: 0, cancelled: false, firstError: null };
      },
    );
    useImagePagesMock.mockReturnValue({
      pages: [],
      addFiles: vi.fn(),
      addEntries: vi.fn(),
      importFiles,
      move: vi.fn(),
      remove: vi.fn(),
      removeMany: vi.fn(),
      rotate: vi.fn(),
      clear: vi.fn(),
      reorder: vi.fn(),
    });
    buildImagesPdfMock.mockReturnValue({
      done: Promise.resolve({
        summary: { pageCount: 1, imageCount: 1 },
        outputs: [
          {
            name: 'scan-001.pdf',
            bytes: new Uint8Array([37, 80, 68, 70]),
            byteLength: 4,
            pageCount: 1,
          },
        ],
        durationMs: 8,
      }),
      cancel: vi.fn(),
    });

    render(<ImagesTool />);
    // No camera needed: the scanner is stubbed to one explicit commit.
    fireEvent.click(screen.getByRole('button', { name: /Scan/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit scan' }));

    await waitFor(() => expect(importFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(buildImagesPdfMock).toHaveBeenCalledTimes(1));
    // The auto-build received the page that the import just committed —
    // no second manual Build PDF press.
    const buildInput = buildImagesPdfMock.mock.calls[0][0];
    expect(buildInput.stagedIds).toHaveLength(1);
    expect(buildInput.stagedPixels).toEqual([640 * 480]);
  });
});
