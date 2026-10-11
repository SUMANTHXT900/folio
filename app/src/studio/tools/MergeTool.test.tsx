/**
 * D-TOOLS-1 scoped tests (MergeTool handoff wiring).
 *
 * The shared `ContinueCard` and the service transfer slot are owned
 * outside this lane: the card is mocked to the frozen props
 * (`outputs`, `sourceName`, `producedBy`, `onBackToEdit`, plus optional
 * display-only `durationMs`) and the
 * service module is mocked at the boundary, so these suites verify
 * only MergeTool's side — mount intake by reference (never re-upload),
 * the continued-from note, completion wiring with existing naming,
 * back-to-edit, and P5-1 remove/clear/unmount lifecycle.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
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
      data-outputname={props.outputs[0]?.name ?? ''}
      data-durationms={props.durationMs ?? ''}
    >
      <button type="button" onClick={props.onBackToEdit}>
        Back to edit
      </button>
    </div>
  );
  return { ContinueCard: MockCard, default: MockCard };
});

vi.mock('../services/folio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/folio')>();
  return {
    ...actual,
    runStudioOperation: vi.fn(),
    openStudioDocs: vi.fn(),
    closeStudioDoc: vi.fn(),
    getStudioBytes: vi.fn(),
    consumePendingTransfer: vi.fn(),
  };
});

import MergeTool from './MergeTool';
import {
  closeStudioDoc,
  consumePendingTransfer,
  getStudioBytes,
  openStudioDocs,
  runStudioOperation,
  type PendingTransfer,
  type StudioDoc,
  type StudioResult,
} from '../services/folio';

const closeMock = vi.mocked(closeStudioDoc);
const consumeMock = vi.mocked(consumePendingTransfer);
const bytesMock = vi.mocked(getStudioBytes);
const openMock = vi.mocked(openStudioDocs);
const runMock = vi.mocked(runStudioOperation);

function doc(overrides: Partial<StudioDoc> = {}): StudioDoc {
  return {
    id: 'studio-9',
    name: 'report-rearranged.pdf',
    sizeBytes: 100,
    pageCount: 4,
    ...overrides,
  };
}

function transfer(
  docs: StudioDoc[],
  producedBy = 'rearrange',
  sourceName = 'report-rearranged.pdf',
): PendingTransfer {
  return { id: 'transfer-1', docs, sourceName, producedBy, at: Date.now() };
}

beforeEach(() => {
  consumeMock.mockReturnValue(null);
  bytesMock.mockReturnValue(undefined);
  openMock.mockResolvedValue([]);
  closeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('MergeTool pending-transfer intake', () => {
  it('loads a handed-off doc as the first input by reference, with an honest note', async () => {
    const claimed = doc();
    consumeMock.mockReturnValue(transfer([claimed]));
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    render(createElement(MergeTool));

    expect(await screen.findByText(/Continued from Rearrange/)).toBeTruthy();
    expect(await screen.findByText('report-rearranged.pdf')).toBeTruthy();
    // Single handed-off doc: the user adds more before merging.
    expect(await screen.findByText('1 file selected — add one more PDF to merge')).toBeTruthy();
    expect(consumeMock).toHaveBeenCalledTimes(1);
    // By reference: never re-uploaded through the file intake.
    expect(openMock).not.toHaveBeenCalled();
  });

  it('ignores an empty transfer', async () => {
    consumeMock.mockReturnValue(transfer([]));
    render(createElement(MergeTool));

    expect(await screen.findByText('Drop your PDFs here')).toBeTruthy();
    expect(screen.queryByText(/Continued from/)).toBeNull();
  });

  it('ignores claimed docs whose bytes are already gone', async () => {
    consumeMock.mockReturnValue(transfer([doc()]));
    bytesMock.mockReturnValue(undefined);
    render(createElement(MergeTool));

    expect(await screen.findByText('Drop your PDFs here')).toBeTruthy();
    expect(screen.queryByText(/Continued from/)).toBeNull();
  });
});

describe('MergeTool claim lifecycle (P5-1)', () => {
  it('releases a pending-claimed doc on unmount when the user backs out without running', async () => {
    const claimed = doc();
    consumeMock.mockReturnValue(transfer([claimed]));
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    const { unmount } = render(createElement(MergeTool));
    await screen.findByText(/Continued from Rearrange/);

    unmount();
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith(claimed.id));
  });

  it('row remove routes through closeStudioDoc exactly once (no bypass, no double release)', async () => {
    const claimed = doc();
    consumeMock.mockReturnValue(transfer([claimed]));
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    const { unmount } = render(createElement(MergeTool));
    await screen.findByText(/Continued from Rearrange/);

    fireEvent.click(screen.getByRole('button', { name: 'Remove report-rearranged.pdf' }));
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledWith(claimed.id);

    // The claim was dropped with the row: unmount releases nothing further.
    unmount();
    await new Promise((r) => setTimeout(r, 20));
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

describe('MergeTool completion handoff', () => {
  it('passes raw outputs with the existing smart name and keeps inputs on back-to-edit', async () => {
    const claimed = doc();
    const second: StudioDoc = {
      id: 'studio-10',
      name: 'b.pdf',
      sizeBytes: 50,
      pageCount: 5,
    };
    consumeMock.mockReturnValue(transfer([claimed]));
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    openMock.mockResolvedValue([second]);
    const bytes = new Uint8Array([37, 80, 68, 70, 45]);
    const result: StudioResult = {
      summary: { inputDocumentCount: 2, inputPageCount: 9, outputPageCount: 9 },
      outputs: [{ name: 'engine.pdf', bytes, byteLength: bytes.length, pageCount: 9 }],
      durationMs: 7,
    };
    runMock.mockReturnValue({ done: Promise.resolve(result), cancel: vi.fn() });

    const { container, unmount } = render(createElement(MergeTool));
    await screen.findByText(/Continued from Rearrange/);

    // User adds one more PDF through the existing intake (no transfer).
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLElement, {
      target: { files: [new File(['%PDF-x'], 'b.pdf', { type: 'application/pdf' })] },
    });
    expect(await screen.findByText('2 files selected — ready to merge')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Merge 2 files' }));
    const card = await screen.findByTestId('continue-card');
    // Claimed doc first, existing smart `merge` naming preserved bit-for-bit.
    expect(runMock).toHaveBeenCalledWith(
      'pdf.merge',
      ['studio-9', 'studio-10'],
      {},
      expect.anything(),
    );
    expect(card.getAttribute('data-producedby')).toBe('merge');
    expect(card.getAttribute('data-sourcename')).toBe('report-rearranged-b-merged.pdf');
    expect(card.getAttribute('data-outputcount')).toBe('1');
    // The handoff item carries the same name the old card downloaded with.
    expect(card.getAttribute('data-outputname')).toBe('report-rearranged-b-merged.pdf');
    // Engine duration threads into the card (display-only, D4); the outer
    // duplicate completion line is gone — the card owns the single summary.
    expect(card.getAttribute('data-durationms')).toBe('7');
    expect(screen.queryByText(/Completed in/)).toBeNull();

    // Back-to-edit dismisses the card and keeps both inputs.
    fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    expect(screen.queryByTestId('continue-card')).toBeNull();
    expect(screen.getByText('2 files selected — ready to merge')).toBeTruthy();

    // The run happened: unmount must not release the working inputs.
    unmount();
    await new Promise((r) => setTimeout(r, 20));
    expect(closeMock).not.toHaveBeenCalledWith(claimed.id);
  });
});
