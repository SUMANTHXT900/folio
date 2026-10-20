/**
 * D-TOOLS-1 scoped tests (RearrangeTool handoff wiring).
 *
 * Mirrors the MergeTool suite: mount intake of a single handed-off doc by
 * reference (never re-upload), the continued-from note, completion wiring
 * with existing naming, back-to-edit, and P5-1 back-out release. The
 * thumbnail engine is mocked at the service boundary (bounded-window
 * pattern from `usePageThumbs.test.ts`); the shared `ContinueCard` is
 * mocked to the frozen props (plus optional display-only `durationMs`).
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
    studioThumbWindow: vi.fn(),
    studioPreview: vi.fn(),
  };
});

import RearrangeTool from './RearrangeTool';
import {
  closeStudioDoc,
  consumePendingTransfer,
  getStudioBytes,
  runStudioOperation,
  studioPreview,
  studioThumbWindow,
  type PendingTransfer,
  type StudioDoc,
  type StudioResult,
} from '../services/folio';

const closeMock = vi.mocked(closeStudioDoc);
const consumeMock = vi.mocked(consumePendingTransfer);
const bytesMock = vi.mocked(getStudioBytes);
const windowMock = vi.mocked(studioThumbWindow);
const previewMock = vi.mocked(studioPreview);
const runMock = vi.mocked(runStudioOperation);

const claimed: StudioDoc = {
  id: 'studio-5',
  name: 'report-merged.pdf',
  sizeBytes: 50,
  pageCount: 3,
};

function transfer(): PendingTransfer {
  return {
    id: 'transfer-2',
    docs: [claimed],
    sourceName: 'report-merged.pdf',
    producedBy: 'merge',
    at: Date.now(),
  };
}

function windowImpl(
  docId: string,
  pages: number[],
): { done: Promise<Map<number, string>>; cancel: () => void } {
  return {
    done: Promise.resolve(new Map(pages.map((p) => [p, `blob:${docId}-${p}`] as [number, string]))),
    cancel: vi.fn(),
  };
}

beforeEach(() => {
  consumeMock.mockReturnValue(null);
  bytesMock.mockReturnValue(undefined);
  closeMock.mockResolvedValue(undefined);
  windowMock.mockImplementation(windowImpl);
  previewMock.mockReturnValue({ done: Promise.resolve('hi-res'), cancel: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('RearrangeTool pending-transfer intake', () => {
  it('loads the handed-off doc as its single input by reference, with an honest note', async () => {
    consumeMock.mockReturnValue(transfer());
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    render(createElement(RearrangeTool));

    expect(await screen.findByText(/Continued from Merge/)).toBeTruthy();
    expect(await screen.findByText('report-merged.pdf')).toBeTruthy();
    // Existing single-file path takes over: thumbs load for the claimed doc.
    expect(windowMock).toHaveBeenCalledWith(claimed.id, [1, 2, 3]);
    expect(await screen.findByText('Save rearranged PDF')).toBeTruthy();
  });

  it('ignores claimed docs whose bytes are already gone', async () => {
    consumeMock.mockReturnValue(transfer());
    bytesMock.mockReturnValue(undefined);
    render(createElement(RearrangeTool));

    expect(await screen.findByText('Drop a PDF to rearrange')).toBeTruthy();
    expect(screen.queryByText(/Continued from/)).toBeNull();
  });

  it('releases a pending-claimed doc on unmount when the user backs out without running', async () => {
    consumeMock.mockReturnValue(transfer());
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    const { unmount } = render(createElement(RearrangeTool));
    await screen.findByText(/Continued from Merge/);

    unmount();
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith(claimed.id));
  });
});

describe('RearrangeTool completion handoff', () => {
  it('passes the raw output with the existing rearrange name and keeps inputs on back-to-edit', async () => {
    consumeMock.mockReturnValue(transfer());
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    const bytes = new Uint8Array([37, 80, 68, 70, 45]);
    const result: StudioResult = {
      summary: { pageCount: 3 },
      outputs: [{ name: 'engine.pdf', bytes, byteLength: bytes.length, pageCount: 3 }],
      durationMs: 9,
    };
    runMock.mockReturnValue({ done: Promise.resolve(result), cancel: vi.fn() });

    const { unmount } = render(createElement(RearrangeTool));
    await screen.findByText(/Continued from Merge/);

    // Identity orders no longer save (no-op honesty): move page 1 down so
    // the run carries a real change.
    fireEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0]);
    fireEvent.click(await screen.findByText('Save rearranged PDF'));
    expect(runMock).toHaveBeenCalledWith(
      'pdf.reorder',
      [claimed.id],
      { order: [2, 1, 3] },
      expect.anything(),
    );
    const card = await screen.findByTestId('continue-card');
    expect(card.getAttribute('data-producedby')).toBe('rearrange');
    // Existing naming, chained with no stacking.
    expect(card.getAttribute('data-sourcename')).toBe('report-merged-rearranged.pdf');
    expect(card.getAttribute('data-outputcount')).toBe('1');
    expect(card.getAttribute('data-outputname')).toBe('report-merged-rearranged.pdf');
    // Engine duration threads into the card (display-only, D4); the outer
    // duplicate completion line is gone — the card owns the single summary.
    expect(card.getAttribute('data-durationms')).toBe('9');
    expect(screen.queryByText(/Completed in/)).toBeNull();

    // Back-to-edit dismisses the card and keeps the file.
    fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    expect(screen.queryByTestId('continue-card')).toBeNull();
    expect(screen.getByText('report-merged.pdf')).toBeTruthy();

    // The run happened: unmount must not release the working input.
    unmount();
    await new Promise((r) => setTimeout(r, 20));
    expect(closeMock).not.toHaveBeenCalledWith(claimed.id);
  });
});

describe('RearrangeTool no-op honesty', () => {
  it('keeps Save disabled with an honest reason while the order is identity', async () => {
    consumeMock.mockReturnValue(transfer());
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    render(createElement(RearrangeTool));
    await screen.findByText(/Continued from Merge/);

    const save = await screen.findByText('Save rearranged PDF');
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/original order/)).toBeTruthy();
    expect(runMock).not.toHaveBeenCalled();
  });

  it('keyboard handle nudges with arrows and stays Tab-reachable', async () => {
    consumeMock.mockReturnValue(transfer());
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    const bytes = new Uint8Array([37, 80, 68, 70, 45]);
    runMock.mockReturnValue({
      done: Promise.resolve({
        summary: { pageCount: 3 },
        outputs: [{ name: 'engine.pdf', bytes, byteLength: bytes.length, pageCount: 3 }],
        durationMs: 9,
      } satisfies StudioResult),
      cancel: vi.fn(),
    });

    render(createElement(RearrangeTool));
    await screen.findByText(/Continued from Merge/);

    // Native button: one tab stop, arrow-key nudging, 44px hit area.
    const handle = screen.getByRole('button', { name: /Reorder Page 1/ });
    expect(handle.tagName).toBe('BUTTON');
    expect(handle.className).toMatch('min-h-[44px]');
    fireEvent.keyDown(handle, { key: 'ArrowDown' });

    fireEvent.click(await screen.findByText('Save rearranged PDF'));
    expect(runMock).toHaveBeenCalledWith(
      'pdf.reorder',
      [claimed.id],
      { order: [2, 1, 3] },
      expect.anything(),
    );
  });

  it('move buttons keep E2E-stable labels and carry page context in title', async () => {
    consumeMock.mockReturnValue(transfer());
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    render(createElement(RearrangeTool));
    await screen.findByText(/Continued from Merge/);

    const downs = screen.getAllByRole('button', { name: 'Move down' });
    expect(downs.length).toBeGreaterThan(0);
    expect(downs[0].getAttribute('title')).toMatch(/Page 1/);
    expect(downs[0].className).toMatch('min-h-[44px]');
  });
});

describe('RearrangeTool preview dialog (AUD-6)', () => {
  it('moves focus in on open, closes on Escape, and marks aria-modal', async () => {
    consumeMock.mockReturnValue(transfer());
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    render(createElement(RearrangeTool));
    await screen.findByText(/Continued from Merge/);

    fireEvent.click(screen.getByText('Page 1'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.className).toMatch('min-h-[44px]');
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('RearrangeTool stale results', () => {
  it('file remove clears the completion card and any error', async () => {
    consumeMock.mockReturnValue(transfer());
    bytesMock.mockImplementation((id) =>
      id === claimed.id ? new Uint8Array([1, 2, 3]) : undefined,
    );
    const bytes = new Uint8Array([37, 80, 68, 70, 45]);
    runMock.mockReturnValue({
      done: Promise.resolve({
        summary: { pageCount: 3 },
        outputs: [{ name: 'engine.pdf', bytes, byteLength: bytes.length, pageCount: 3 }],
        durationMs: 9,
      } satisfies StudioResult),
      cancel: vi.fn(),
    });

    render(createElement(RearrangeTool));
    await screen.findByText(/Continued from Merge/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0]);
    fireEvent.click(await screen.findByText('Save rearranged PDF'));
    await screen.findByTestId('continue-card');

    fireEvent.click(screen.getByRole('button', { name: 'Remove report-merged.pdf' }));
    expect(screen.queryByTestId('continue-card')).toBeNull();
  });
});
