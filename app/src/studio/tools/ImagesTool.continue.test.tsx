/**
 * Images source-only handoff tests (F-IMAGES-SOURCE contract).
 *
 * A completed build renders the sibling-owned ContinueCard (mocked here to
 * the frozen props — `outputs`, `sourceName`, `producedBy`, `onBackToEdit`,
 * plus optional display-only `durationMs`)
 * with the single PDF output, the smart `images` source name, and
 * `producedBy="images"`; back-to-edit dismisses the card and keeps the page
 * collection intact. The engine call is mocked at the `buildImagesPdf`
 * seam — staging, naming, and completion wiring run for real. Images is
 * never a continue target: no pending-transfer consume path is exercised
 * anywhere in this suite.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImagesTool from './ImagesTool';
import { createPage, type ImagePage } from './imagePages';
import { buildImagesPdf } from './imageSharding';
import { useImagePages } from './useImagePages';
import type { StudioOutput, StudioResult } from '../services/folio';

vi.mock('../components/ContinueCard', () => ({
  ContinueCard: (props: {
    outputs: StudioOutput[];
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

// PageGrid (thumbs + id-keyed modal) is owned elsewhere and untouched —
// stubbed here to keep this suite on the handoff contract.
vi.mock('./PageGrid', () => ({
  PageGrid: ({ pages }: { pages: ImagePage[] }) => (
    <ul data-testid="page-grid">
      {pages.map((p) => (
        <li key={p.id}>{p.name}</li>
      ))}
    </ul>
  ),
}));

const buildImagesPdfMock = vi.mocked(buildImagesPdf);
const useImagePagesMock = vi.mocked(useImagePages);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function seedCollection(overrides: { clear?: () => void } = {}): ImagePage[] {
  const pages = [
    createPage({
      id: 'a',
      source: 'upload',
      file: new File([new Uint8Array([10])], 'scan-001.jpg', { type: 'image/jpeg' }),
      name: 'scan-001.jpg',
    }),
    createPage({
      id: 'b',
      source: 'upload',
      file: new File([new Uint8Array([20, 21])], 'scan-002.jpg', { type: 'image/jpeg' }),
      name: 'scan-002.jpg',
    }),
  ];
  useImagePagesMock.mockReturnValue({
    pages,
    addFiles: vi.fn(),
    addEntries: vi.fn(),
    importFiles: vi.fn(),
    move: vi.fn(),
    remove: vi.fn(),
    rotate: vi.fn(),
    clear: overrides.clear ?? vi.fn(),
    reorder: vi.fn(),
  });
  return pages;
}

/** One ordered PDF out of the (mocked) engine, as `buildImagesPdf` resolves. */
function resolveBuild(): { bytes: Uint8Array; output: StudioOutput } {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const output: StudioOutput = {
    name: 'engine-output.pdf',
    bytes,
    byteLength: bytes.length,
    pageCount: 2,
  };
  const result: StudioResult = {
    summary: { pageCount: 2, imageCount: 2 },
    outputs: [output],
    durationMs: 12,
  };
  buildImagesPdfMock.mockReturnValue({ done: Promise.resolve(result), cancel: vi.fn() });
  return { bytes, output };
}

describe('Images source handoff', () => {
  it('hands the single built PDF to ContinueCard with the smart images name', async () => {
    seedCollection();
    const { output, bytes } = resolveBuild();
    render(<ImagesTool />);
    fireEvent.click(screen.getByRole('button', { name: /Build PDF/ }));

    const card = await screen.findByTestId('continue-card');
    expect(card.getAttribute('data-producedby')).toBe('images');
    // Existing naming, unchanged: first-plus-N from the collection.
    expect(card.getAttribute('data-sourcename')).toBe('scan-001-plus1-pages.pdf');
    expect(card.getAttribute('data-outputcount')).toBe('1');
    // The download branch names the file exactly as the old card did.
    expect(card.getAttribute('data-outputname')).toBe('scan-001-plus1-pages.pdf');
    // The engine record itself is unlabeled — the smart name is app-side.
    expect(output.name).toBe('engine-output.pdf');
    expect(output.bytes).toBe(bytes);
    expect(buildImagesPdfMock).toHaveBeenCalledTimes(1);
    // Engine duration threads into the card (display-only, D4); the outer
    // duplicate completion line is gone — the card owns the single summary.
    expect(card.getAttribute('data-durationms')).toBe('12');
    expect(screen.queryByText(/Completed in/)).toBeNull();
  });

  it('back-to-edit dismisses the card and keeps the collection intact', async () => {
    const clear = vi.fn();
    seedCollection({ clear });
    resolveBuild();
    render(<ImagesTool />);
    fireEvent.click(screen.getByRole('button', { name: /Build PDF/ }));
    await screen.findByTestId('continue-card');

    fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    expect(screen.queryByTestId('continue-card')).toBeNull();
    // Build returns; the collection was never cleared, reordered, or revoked.
    expect(screen.getByRole('button', { name: /Build PDF/ })).toBeTruthy();
    const grid = screen.getByTestId('page-grid');
    expect(grid.textContent).toContain('scan-001.jpg');
    expect(grid.textContent).toContain('scan-002.jpg');
    expect(clear).not.toHaveBeenCalled();
  });

  it('rebuilds after back-to-edit with the same naming', async () => {
    seedCollection();
    resolveBuild();
    render(<ImagesTool />);
    fireEvent.click(screen.getByRole('button', { name: /Build PDF/ }));
    await screen.findByTestId('continue-card');
    fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));

    fireEvent.click(screen.getByRole('button', { name: /Build PDF/ }));
    const card = await screen.findByTestId('continue-card');
    expect(card.getAttribute('data-sourcename')).toBe('scan-001-plus1-pages.pdf');
    expect(buildImagesPdfMock).toHaveBeenCalledTimes(2);
  });
});
