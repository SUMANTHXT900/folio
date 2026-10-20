/**
 * E-TOOLS-2 scoped tests (RotateTool handoff wiring).
 *
 * The shared `ContinueCard` and the service transfer slot are owned
 * outside this lane: the card is mocked to the frozen props plus optional
 * display-only `durationMs` and the
 * service module is mocked at the boundary, so this suite verifies
 * only RotateTool's side — the empty/0° no-op success path (input
 * bytes by reference, engine untouched), grouped quarter-turn chaining
 * with render-load-free intermediates, mount intake, and back-to-edit.
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

import RotateTool from './RotateTool';
import {
  closeStudioDoc,
  consumePendingTransfer,
  getStudioBytes,
  runStudioOperation,
  type PendingTransfer,
  type StudioDoc,
  type StudioResult,
} from '../services/folio';

const NOOP_BYTES = new Uint8Array([5, 5, 5]);

const closeMock = vi.mocked(closeStudioDoc);
const consumeMock = vi.mocked(consumePendingTransfer);
const bytesMock = vi.mocked(getStudioBytes);
const runMock = vi.mocked(runStudioOperation);

const DOC: StudioDoc = { id: 's1', name: 'doc.pdf', sizeBytes: 3, pageCount: 3 };

function transfer(docs: StudioDoc[], producedBy = 'split', sourceName = 'r.pdf'): PendingTransfer {
  return { id: 'transfer-1', docs, sourceName, producedBy, at: Date.now() };
}

beforeEach(() => {
  consumeMock.mockReturnValue(null);
  bytesMock.mockImplementation((id) => (id === 's1' ? NOOP_BYTES : undefined));
  closeMock.mockResolvedValue(undefined);
  pdfFilesMock.files = [{ ...DOC }];
  pageThumbsMock.thumbs = ['u1', 'u2', 'u3'];
  pageThumbsMock.loading = false;
  pageThumbsMock.load.mockResolvedValue(['u1', 'u2', 'u3']);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('RotateTool zero-rotation honesty', () => {
  it('keeps the download disabled with an honest note until something is rotated', async () => {
    render(<RotateTool />);
    const download = await screen.findByRole('button', { name: 'Download rotated PDF' });
    expect((download as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No rotation selected/)).toBeTruthy();
    expect(runMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('continue-card')).toBeNull();
  });

  it('enables the download once a page is spun', async () => {
    render(<RotateTool />);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right (page 1)' }));
    const download = await screen.findByRole('button', { name: 'Download rotated PDF' });
    expect((download as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/No rotation selected/)).toBeNull();
  });
});

describe('RotateTool stale results', () => {
  it('file remove clears the completion card', async () => {
    const result: StudioResult = {
      summary: { pageCount: 3 },
      outputs: [{ name: 'o', bytes: new Uint8Array([1, 2]), byteLength: 2, pageCount: 3 }],
      durationMs: 2,
    };
    runMock.mockReturnValue({ done: Promise.resolve(result), cancel: vi.fn() });

    render(<RotateTool />);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right (page 1)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download rotated PDF' }));
    await screen.findByTestId('continue-card');

    fireEvent.click(screen.getByRole('button', { name: 'Remove doc.pdf' }));
    expect(screen.queryByTestId('continue-card')).toBeNull();
  });
});

describe('RotateTool grouped runs', () => {
  it('chains one engine call per quarter-turn group over staged intermediates', async () => {
    const result: StudioResult = {
      summary: { pageCount: 3 },
      outputs: [{ name: 'o', bytes: new Uint8Array([1, 2]), byteLength: 2, pageCount: 3 }],
      durationMs: 2,
    };
    runMock.mockReturnValue({ done: Promise.resolve(result), cancel: vi.fn() });

    render(<RotateTool />);
    await screen.findByRole('button', { name: 'Download rotated PDF' });
    // Page 1 +90° (one right spin), page 2 +180° (two right spins).
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right (page 1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right (page 2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right (page 2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download rotated PDF' }));

    const card = await screen.findByTestId('continue-card');
    expect(runMock).toHaveBeenCalledTimes(2);
    const calls = runMock.mock.calls as unknown[][];
    const first = calls[0] as [string, string[], { pages: number[]; angleDeg: number }];
    const second = calls[1] as [string, string[], { pages: number[]; angleDeg: number }];
    expect(first[0]).toBe('pdf.rotate');
    expect(first[1]).toEqual(['s1']);
    expect(first[2]).toEqual({ pages: [1], angleDeg: 90 });
    // The second run chains off the staged intermediate, not the original —
    // intermediates skip the render-load (no `openStudioBytes`, staged ids only).
    expect(second[1][0]).not.toBe('s1');
    expect(second[2]).toEqual({ pages: [2], angleDeg: 180 });
    // Chained engine durations sum into the card (2 + 2, display-only, D4).
    expect(card.getAttribute('data-durationms')).toBe('4');
  });
});

describe('RotateTool pending-transfer intake', () => {
  it('loads a handed-off doc as the single input by reference, with an honest note', async () => {
    const claimed: StudioDoc = {
      id: 'studio-9',
      name: 'r-p1-2.pdf',
      sizeBytes: 2,
      pageCount: 2,
    };
    consumeMock.mockReturnValue(transfer([claimed]));
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([8, 8]) : id === 's1' ? NOOP_BYTES : undefined,
    );
    pdfFilesMock.files = [{ ...claimed }];

    render(<RotateTool />);
    expect(await screen.findByText(/Continued from Split/)).toBeTruthy();
    expect(await screen.findByText(/r\.pdf is loaded below by reference/)).toBeTruthy();
    expect(consumeMock).toHaveBeenCalledTimes(1);
    const updater = pdfFilesMock.setFiles.mock.calls[0]?.[0] as
      ((prev: StudioDoc[]) => StudioDoc[]) | undefined;
    if (updater === undefined) throw new Error('expected a setFiles call');
    expect(updater([])).toEqual([claimed]);
  });

  it('releases a pending-claimed doc on unmount when the user backs out without running', async () => {
    const claimed: StudioDoc = {
      id: 'studio-9',
      name: 'r-p1-2.pdf',
      sizeBytes: 2,
      pageCount: 2,
    };
    consumeMock.mockReturnValue(transfer([claimed]));
    bytesMock.mockImplementation((id) => (id === claimed.id ? new Uint8Array([8, 8]) : undefined));
    pdfFilesMock.files = [{ ...claimed }];

    const { unmount } = render(<RotateTool />);
    await screen.findByText(/Continued from Split/);

    unmount();
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith(claimed.id));
  });
});
