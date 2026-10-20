/**
 * `DownloadCard` reset tests: a new completion (new blob/suggestion)
 * resets mode, text, and downloaded state in one pass.
 *
 * `MultiDownloadCard` honesty tests: anchor clicks are fire-and-forget (no
 * browser API reports a completed download), so Download-all announces only
 * that downloads STARTED — never that all parts "saved".
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadCard, MultiDownloadCard, type DownloadPart } from './DownloadCard';

function makeParts(): DownloadPart[] {
  return [
    {
      key: 'part-0',
      blob: new Blob(['a'], { type: 'application/pdf' }),
      suggestedName: 'a-p1-1.pdf',
    },
    {
      key: 'part-1',
      blob: new Blob(['b'], { type: 'application/pdf' }),
      suggestedName: 'a-p2-2.pdf',
    },
  ];
}

beforeEach(() => {
  let counter = 0;
  URL.createObjectURL = vi.fn(() => {
    counter += 1;
    return `blob:card-${counter}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DownloadCard reset', () => {
  it('resets mode, text, and downloaded state when the completion changes', () => {
    const blobA = new Blob(['a'], { type: 'application/pdf' });
    const blobB = new Blob(['b'], { type: 'application/pdf' });
    const { rerender } = render(<DownloadCard blob={blobA} suggestedName="report.pdf" />);

    // Switch to Custom and type a name, then complete the download.
    fireEvent.click(screen.getByRole('button', { name: 'Custom name' }));
    fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'mine' } });
    expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe('mine');
    fireEvent.click(screen.getByRole('link', { name: 'Download PDF' }));
    // Downloaded state takes over (naming card replaced by the banner).
    expect(screen.queryByLabelText('File name')).toBeNull();

    // A new completion resets everything in one pass.
    rerender(<DownloadCard blob={blobB} suggestedName="other.pdf" />);
    expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe('other.pdf');
    expect(screen.getByRole('button', { name: 'Smart name' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('link', { name: 'Download PDF' }).getAttribute('download')).toBe(
      'other.pdf',
    );
  });

  it('shows the smart suggestion as the initial name', () => {
    const blob = new Blob(['a'], { type: 'application/pdf' });
    render(<DownloadCard blob={blob} suggestedName="images.pdf" />);
    expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe('images.pdf');
  });
});

describe('MultiDownloadCard honest started-state', () => {
  it('announces downloads-started (never all-saved) after Download all', async () => {
    render(<MultiDownloadCard parts={makeParts()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download all parts' }));
    const status = await screen.findByRole('status', {}, { timeout: 3000 });
    expect(status.textContent).toMatch(/Downloads started for all 2 parts/);
    expect(status.textContent).toMatch(/check your downloads shelf/);
    expect(screen.queryByText(/All parts saved/)).toBeNull();
  });

  it('resyncs row text when a new completion reuses the stable rows', () => {
    const { rerender } = render(<MultiDownloadCard parts={makeParts()} />);
    fireEvent.change(screen.getByLabelText('File name part 1'), {
      target: { value: 'my-custom' },
    });
    expect((screen.getByLabelText('File name part 1') as HTMLInputElement).value).toBe('my-custom');

    // Re-run: new blobs, new suggestions, same stable keys — the stale edit
    // must not survive.
    rerender(
      <MultiDownloadCard
        parts={[
          {
            key: 'part-0',
            blob: new Blob(['c'], { type: 'application/pdf' }),
            suggestedName: 'b-p1-1.pdf',
          },
          {
            key: 'part-1',
            blob: new Blob(['d'], { type: 'application/pdf' }),
            suggestedName: 'b-p2-2.pdf',
          },
        ]}
      />,
    );
    expect((screen.getByLabelText('File name part 1') as HTMLInputElement).value).toBe(
      'b-p1-1.pdf',
    );
    expect((screen.getByLabelText('File name part 2') as HTMLInputElement).value).toBe(
      'b-p2-2.pdf',
    );
  });

  it('resets the started notice when a new completion arrives', async () => {
    const { rerender } = render(<MultiDownloadCard parts={makeParts()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download all parts' }));
    await screen.findByRole('status', {}, { timeout: 3000 });

    rerender(<MultiDownloadCard parts={makeParts()} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
