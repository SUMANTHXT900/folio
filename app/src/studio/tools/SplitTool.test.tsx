/**
 * E-TOOLS-2 scoped tests (SplitTool handoff wiring).
 *
 * The shared `ContinueCard` and the service transfer slot are owned
 * outside this lane: the card is mocked to the frozen props
 * (`outputs`, `sourceName`, `producedBy`, `onBackToEdit`, plus optional
 * display-only `durationMs`) and the
 * service module is mocked at the boundary, so this suite verifies
 * only SplitTool's side — mount intake by reference (never re-upload),
 * the continued-from note, completion wiring with the existing part
 * naming (pick single, ranges-mode atomic multi), range errors
 * producing nothing, back-to-edit, and P5-1 remove/unmount lifecycle.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/ContinueCard', () => {
  const MockCard = (props: {
    outputs: Array<{ name: string }>;
    sourceName: string;
    producedBy: string;
    onBackToEdit: () => void;
    durationMs?: number;
  }) => (
    <div
      data-testid="continue-card"
      data-sourcename={props.sourceName}
      data-producedby={props.producedBy}
      data-outputcount={props.outputs.length}
      data-outputnames={props.outputs.map((o) => o.name).join('|')}
      data-durationms={props.durationMs ?? ''}
    >
      <button type="button" onClick={props.onBackToEdit}>
        Back to edit
      </button>
    </div>
  );
  return { ContinueCard: MockCard, default: MockCard };
});

const { pdfFilesMock, pageThumbsMock } = vi.hoisted(() => ({
  pdfFilesMock: {
    files: [] as Array<{ id: string; name: string; sizeBytes: number; pageCount: number }>,
    addFiles: vi.fn(),
    remove: vi.fn(),
    setFiles: vi.fn(),
    error: null as string | null,
    busy: false,
    setBusy: vi.fn(),
    setError: vi.fn(),
  },
  pageThumbsMock: {
    thumbs: [] as string[],
    load: vi.fn(),
    fillAll: vi.fn(),
    loading: false,
    progress: null as { done: number; total: number } | null,
    renderPreview: vi.fn(),
  },
}));

vi.mock('../hooks/usePdfFiles', () => ({ usePdfFiles: () => pdfFilesMock }));
vi.mock('../hooks/usePageThumbs', () => ({ usePageThumbs: () => pageThumbsMock }));

vi.mock('../services/folio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/folio')>();
  return {
    ...actual,
    runStudioOperation: vi.fn(),
    closeStudioDoc: vi.fn(),
    getStudioBytes: vi.fn(),
    consumePendingTransfer: vi.fn(),
  };
});

import SplitTool from './SplitTool';
import {
  closeStudioDoc,
  consumePendingTransfer,
  getStudioBytes,
  runStudioOperation,
  type PendingTransfer,
  type StudioDoc,
  type StudioResult,
} from '../services/folio';
import type { SplitSummary } from '../../types/engine';

const closeMock = vi.mocked(closeStudioDoc);
const consumeMock = vi.mocked(consumePendingTransfer);
const bytesMock = vi.mocked(getStudioBytes);
const runMock = vi.mocked(runStudioOperation);

const DOC: StudioDoc = { id: 's1', name: 'r.pdf', sizeBytes: 100, pageCount: 4 };

function transfer(docs: StudioDoc[], producedBy = 'rotate', sourceName = 'a.pdf'): PendingTransfer {
  return { id: 'transfer-1', docs, sourceName, producedBy, at: Date.now() };
}

beforeEach(() => {
  consumeMock.mockReturnValue(null);
  bytesMock.mockReturnValue(undefined);
  closeMock.mockResolvedValue(undefined);
  pdfFilesMock.files = [];
  pdfFilesMock.error = null;
  pdfFilesMock.busy = false;
  pageThumbsMock.thumbs = [];
  pageThumbsMock.loading = false;
  pageThumbsMock.progress = null;
  pageThumbsMock.renderPreview.mockReturnValue({
    done: Promise.resolve('hi-res'),
    cancel: vi.fn(),
  });
  pageThumbsMock.load.mockResolvedValue(['t1', 't2', 't3', 't4']);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('SplitTool pending-transfer intake', () => {
  it('loads a handed-off doc as the single input by reference, with an honest note', async () => {
    const claimed: StudioDoc = {
      id: 'studio-9',
      name: 'a-rotated.pdf',
      sizeBytes: 3,
      pageCount: 3,
    };
    consumeMock.mockReturnValue(transfer([claimed]));
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    pdfFilesMock.files = [{ ...claimed }];

    render(<SplitTool />);
    expect(await screen.findByText(/Continued from Rotate/)).toBeTruthy();
    expect(await screen.findByText(/a\.pdf is loaded below by reference/)).toBeTruthy();
    expect(consumeMock).toHaveBeenCalledTimes(1);
    const updater = pdfFilesMock.setFiles.mock.calls[0]?.[0] as
      ((prev: StudioDoc[]) => StudioDoc[]) | undefined;
    if (updater === undefined) throw new Error('expected a setFiles call');
    expect(updater([])).toEqual([claimed]);
  });

  it('ignores an empty transfer', async () => {
    consumeMock.mockReturnValue(transfer([]));
    render(<SplitTool />);

    expect(await screen.findByText('Drop a PDF to split')).toBeTruthy();
    expect(screen.queryByText(/Continued from/)).toBeNull();
    expect(pdfFilesMock.setFiles).not.toHaveBeenCalled();
  });

  it('ignores claimed docs whose bytes are already gone', async () => {
    const claimed: StudioDoc = {
      id: 'studio-9',
      name: 'a-rotated.pdf',
      sizeBytes: 3,
      pageCount: 3,
    };
    consumeMock.mockReturnValue(transfer([claimed]));
    bytesMock.mockReturnValue(undefined);
    render(<SplitTool />);

    expect(await screen.findByText('Drop a PDF to split')).toBeTruthy();
    expect(screen.queryByText(/Continued from/)).toBeNull();
    expect(pdfFilesMock.setFiles).not.toHaveBeenCalled();
  });
});

describe('SplitTool claim lifecycle (P5-1)', () => {
  it('releases a pending-claimed doc on unmount when the user backs out without running', async () => {
    const claimed: StudioDoc = {
      id: 'studio-9',
      name: 'a-rotated.pdf',
      sizeBytes: 3,
      pageCount: 3,
    };
    consumeMock.mockReturnValue(transfer([claimed]));
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    pdfFilesMock.files = [{ ...claimed }];

    const { unmount } = render(<SplitTool />);
    await screen.findByText(/Continued from Rotate/);

    unmount();
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith(claimed.id));
  });

  it('file remove routes through remove() and drops the claim', async () => {
    const claimed: StudioDoc = {
      id: 'studio-9',
      name: 'a-rotated.pdf',
      sizeBytes: 3,
      pageCount: 3,
    };
    consumeMock.mockReturnValue(transfer([claimed]));
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    pdfFilesMock.files = [{ ...claimed }];

    const { unmount } = render(<SplitTool />);
    await screen.findByText(/Continued from Rotate/);

    fireEvent.click(screen.getByRole('button', { name: 'Remove a-rotated.pdf' }));
    expect(pdfFilesMock.remove).toHaveBeenCalledWith(claimed.id);

    // The claim was dropped with the file: unmount releases nothing further.
    unmount();
    await new Promise((r) => setTimeout(r, 20));
    expect(closeMock).not.toHaveBeenCalled();
  });
});

describe('SplitTool completion handoff', () => {
  beforeEach(() => {
    pdfFilesMock.files = [{ ...DOC }];
    pageThumbsMock.thumbs = ['t1', 't2', 't3', 't4'];
  });

  it('ranges mode makes one atomic pdf.split call and hands off every named part', async () => {
    const summary: SplitSummary = {
      inputPageCount: 4,
      parts: [
        { name: null, pageCount: 2 },
        { name: null, pageCount: 2 },
      ],
    };
    const result: StudioResult = {
      summary,
      outputs: [
        { name: 'engine-0', bytes: new Uint8Array([10]), byteLength: 1, pageCount: 2 },
        { name: 'engine-1', bytes: new Uint8Array([20]), byteLength: 1, pageCount: 2 },
      ],
      durationMs: 7,
    };
    runMock.mockReturnValue({ done: Promise.resolve(result), cancel: vi.fn() });

    render(<SplitTool />);
    fireEvent.click(screen.getByRole('button', { name: 'By ranges' }));
    fireEvent.change(screen.getByLabelText('Pages to extract'), {
      target: { value: '1-2, 3-4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Extract pages' }));

    const card = await screen.findByTestId('continue-card');
    // Atomicity: exactly one engine call carrying every part — no partial outputs.
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      'pdf.split',
      ['s1'],
      { parts: [{ pages: [1, 2] }, { pages: [3, 4] }] },
      expect.anything(),
    );
    expect(card.getAttribute('data-producedby')).toBe('split');
    expect(card.getAttribute('data-sourcename')).toBe('r.pdf');
    expect(card.getAttribute('data-outputcount')).toBe('2');
    // Existing smart part naming preserved per part.
    expect(card.getAttribute('data-outputnames')).toBe('r-p1-2.pdf|r-p3-4.pdf');
    // Engine duration threads into the card (display-only, D4).
    expect(card.getAttribute('data-durationms')).toBe('7');

    fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    expect(screen.queryByTestId('continue-card')).toBeNull();
  });

  it('pick mode hands off a single output with the existing smart part name', async () => {
    const result: StudioResult = {
      summary: { pageCount: 4 },
      outputs: [{ name: 'engine', bytes: new Uint8Array([30]), byteLength: 1, pageCount: 4 }],
      durationMs: 5,
    };
    runMock.mockReturnValue({ done: Promise.resolve(result), cancel: vi.fn() });

    render(<SplitTool />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create PDF · 4 pages' }));
    const card = await screen.findByTestId('continue-card');
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      'pdf.extract_pages',
      ['s1'],
      { pages: [1, 2, 3, 4] },
      expect.anything(),
    );
    expect(card.getAttribute('data-outputcount')).toBe('1');
    expect(card.getAttribute('data-outputnames')).toBe('r-p1-4.pdf');
    expect(card.getAttribute('data-sourcename')).toBe('r.pdf');
    // Engine duration threads into the card (display-only, D4).
    expect(card.getAttribute('data-durationms')).toBe('5');
  });

  it('range errors produce nothing and surface honestly', async () => {
    render(<SplitTool />);
    fireEvent.click(screen.getByRole('button', { name: 'By ranges' }));
    fireEvent.change(screen.getByLabelText('Pages to extract'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Extract pages' }));
    await screen.findByText('Enter at least one page or range');
    expect(runMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('continue-card')).toBeNull();
  });
});

describe('SplitTool thumbnail sharpness (F-23)', () => {
  beforeEach(() => {
    pdfFilesMock.files = [{ ...DOC }];
    pageThumbsMock.thumbs = ['t1', 't2', 't3', 't4'];
  });

  it('loads the pick grid at grid tier, not the small list default', async () => {
    const { thumbGridBox } = await import('../services/folio');
    render(<SplitTool />);
    await waitFor(() => expect(pageThumbsMock.load).toHaveBeenCalled());
    const box = pageThumbsMock.load.mock.calls[0]?.[3] as number | undefined;
    expect(box).toBe(thumbGridBox());
    expect(box).toBeGreaterThan(128);
  });

  it('preview dialog renders the full-res render with the grid thumb as fallback', async () => {
    render(<SplitTool />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview Page 1' }));
    await waitFor(() => expect(pageThumbsMock.renderPreview).toHaveBeenCalledWith('s1', 1));
    // Full-res URL replaces the small thumb once it resolves.
    expect(await screen.findByAltText('Page 1 (full resolution)')).toBeTruthy();
  });

  it('preview keeps the grid thumb with a rendering note while full-res loads', async () => {
    let resolveHiRes!: (url: string) => void;
    pageThumbsMock.renderPreview.mockReturnValue({
      done: new Promise<string>((resolve) => {
        resolveHiRes = resolve;
      }),
      cancel: vi.fn(),
    });
    render(<SplitTool />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview Page 1' }));
    await waitFor(() => expect(pageThumbsMock.renderPreview).toHaveBeenCalled());
    expect(screen.getByText('Rendering full-resolution view…')).toBeTruthy();
    resolveHiRes('hi-1');
    expect(await screen.findByAltText('Page 1 (full resolution)')).toBeTruthy();
  });
});
