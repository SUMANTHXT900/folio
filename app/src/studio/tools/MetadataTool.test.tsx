/**
 * E-TOOLS-2 scoped tests (MetadataTool handoff wiring).
 *
 * The shared `ContinueCard` and the service transfer slot are owned
 * outside this lane: the card is mocked to the frozen props plus optional
 * display-only `durationMs` and the
 * service module is mocked at the boundary, so this suite verifies
 * only MetadataTool's side — blank-with-intent rejected with Clear
 * guidance (L3, `""` never sent), set/clear/leave-unchanged patch
 * semantics, removal via `remove()` (P5-1 class), mount intake, and
 * back-to-edit.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const { pdfFilesMock } = vi.hoisted(() => ({
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
}));

vi.mock('../hooks/usePdfFiles', () => ({ usePdfFiles: () => pdfFilesMock }));

vi.mock('../services/folio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/folio')>();
  return {
    ...actual,
    runStudioOperation: vi.fn(),
    openStudioBytes: vi.fn(),
    closeStudioDoc: vi.fn(),
    getStudioBytes: vi.fn(),
    consumePendingTransfer: vi.fn(),
  };
});

import MetadataTool from './MetadataTool';
import {
  closeStudioDoc,
  consumePendingTransfer,
  getStudioBytes,
  openStudioBytes,
  runStudioOperation,
  type PendingTransfer,
  type StudioDoc,
} from '../services/folio';
import type { DocumentMetadataData, MetadataSummary } from '../../types/engine';

const closeMock = vi.mocked(closeStudioDoc);
const consumeMock = vi.mocked(consumePendingTransfer);
const bytesMock = vi.mocked(getStudioBytes);
const openMock = vi.mocked(openStudioBytes);
const runMock = vi.mocked(runStudioOperation);

const DOC: StudioDoc = { id: 's1', name: 'doc.pdf', sizeBytes: 50, pageCount: 2 };

const EMPTY_META: DocumentMetadataData = {
  title: null,
  author: null,
  subject: null,
  keywords: null,
  creator: null,
  producer: null,
  creationDate: null,
  modificationDate: null,
};

const READ_SUMMARY: MetadataSummary = {
  pageCount: 2,
  metadata: { ...EMPTY_META, title: 'Orig', author: 'A. Uthor' },
};

function transfer(docs: StudioDoc[], producedBy = 'split', sourceName = 'r.pdf'): PendingTransfer {
  return { id: 'transfer-1', docs, sourceName, producedBy, at: Date.now() };
}

/** Default engine double: reads resolve, sets resolve with an echo. */
function mockEngine() {
  runMock.mockImplementation((operation: string) => {
    if (operation === 'pdf.read_metadata') {
      return {
        done: Promise.resolve({ summary: READ_SUMMARY, outputs: [], durationMs: 1 }),
        cancel: vi.fn(),
      };
    }
    if (operation === 'pdf.set_metadata') {
      return {
        done: Promise.resolve({
          summary: {
            pageCount: 2,
            metadata: { ...EMPTY_META, title: 'New Title' },
          } satisfies MetadataSummary,
          outputs: [{ name: 'm', bytes: new Uint8Array([9, 9]), byteLength: 2, pageCount: 2 }],
          durationMs: 3,
        }),
        cancel: vi.fn(),
      };
    }
    throw new Error(`unexpected operation ${operation}`);
  });
  openMock.mockResolvedValue({ id: 't1', name: 'reread', sizeBytes: 2, pageCount: 2 });
}

beforeEach(() => {
  consumeMock.mockReturnValue(null);
  bytesMock.mockReturnValue(undefined);
  closeMock.mockResolvedValue(undefined);
  pdfFilesMock.files = [{ ...DOC }];
  mockEngine();
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('MetadataTool patch semantics', () => {
  it('reads and shows the current properties on mount', async () => {
    render(<MetadataTool />);
    expect(await screen.findByText('Orig')).not.toBeNull();
    expect(screen.getByText('A. Uthor')).not.toBeNull();
  });

  it('rejects a blanked field with Clear guidance and sends no set', async () => {
    render(<MetadataTool />);
    await screen.findByText('Orig');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save metadata' }));
    await screen.findByText(/tick Clear to remove it/);
    const sets = (runMock.mock.calls as unknown[][]).filter((c) => c[0] === 'pdf.set_metadata');
    expect(sets).toHaveLength(0);
  });

  it('sends set for edited fields, clear for ticked fields, nothing for the rest', async () => {
    render(<MetadataTool />);
    await screen.findByText('Orig');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New Title' } });
    // Checkboxes follow the field order: 6 text fields, then 2 date fields.
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save metadata' }));
    const card = await screen.findByTestId('continue-card');
    const setCall = (runMock.mock.calls as unknown[][]).find((c) => c[0] === 'pdf.set_metadata');
    if (setCall === undefined) throw new Error('expected a pdf.set_metadata call');
    expect(setCall[1]).toEqual(['s1']);
    expect(setCall[2]).toEqual({
      patch: {
        title: { op: 'set', value: 'New Title' },
        author: { op: 'clear' },
      },
    });
    // Single-output handoff labelled with the existing smart `metadata` name.
    expect(card.getAttribute('data-producedby')).toBe('metadata');
    expect(card.getAttribute('data-sourcename')).toBe('doc.pdf');
    expect(card.getAttribute('data-outputnames')).toBe('doc-metadata.pdf');
    // Engine duration threads into the card (display-only, D4).
    expect(card.getAttribute('data-durationms')).toBe('3');

    fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    expect(screen.queryByTestId('continue-card')).toBeNull();
  });
});

describe('MetadataTool lifecycle', () => {
  it('removes the file through remove(), not a bare state reset', async () => {
    render(<MetadataTool />);
    await screen.findByText('Orig');
    fireEvent.click(screen.getByRole('button', { name: 'Remove doc.pdf' }));
    expect(pdfFilesMock.remove).toHaveBeenCalledWith('s1');
  });

  it('loads a handed-off doc as the single input by reference, with an honest note', async () => {
    const claimed: StudioDoc = {
      id: 'studio-9',
      name: 'r-p1-2.pdf',
      sizeBytes: 1,
      pageCount: 2,
    };
    consumeMock.mockReturnValue(transfer([claimed]));
    bytesMock.mockImplementation((id) => (id === claimed.id ? new Uint8Array([4]) : undefined));
    pdfFilesMock.files = [{ ...claimed }];

    render(<MetadataTool />);
    expect(await screen.findByText(/Continued from Split/)).toBeTruthy();
    expect(await screen.findByText(/r\.pdf is loaded below by reference/)).toBeTruthy();
    expect(consumeMock).toHaveBeenCalledTimes(1);
    const updater = pdfFilesMock.setFiles.mock.calls[0]?.[0] as
      ((prev: StudioDoc[]) => StudioDoc[]) | undefined;
    if (updater === undefined) throw new Error('expected a setFiles call');
    expect(updater([])).toEqual([claimed]);
  });
});
