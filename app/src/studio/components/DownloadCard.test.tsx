/**
 * `DownloadCard` reset tests: a new completion (new blob/suggestion)
 * resets mode, text, and downloaded state in one pass.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadCard } from './DownloadCard';

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
