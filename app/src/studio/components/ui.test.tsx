/**
 * Shared UI primitive tests: the stale-chunk recovery path must turn an
 * undebuggable deploy-skew failure into an actionable reload prompt.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DropZone, ErrorBlock, Progress, isStaleChunkError } from './ui';

afterEach(() => {
  cleanup();
});

describe('isStaleChunkError', () => {
  it('recognizes code-split fetch failures across bundlers', () => {
    expect(
      isStaleChunkError(
        new Error(
          'Failed to fetch dynamically imported module: https://dev.folio-pdf.pages.dev/assets/WasmWorkerEngineAdapter-CbBhUPAy.js',
        ),
      ),
    ).toBe(true);
    expect(isStaleChunkError(new Error('Loading chunk 42 failed.'))).toBe(true);
    expect(isStaleChunkError(new Error('Importing a module script failed.'))).toBe(true);
  });

  it('leaves ordinary engine errors alone', () => {
    expect(isStaleChunkError(new Error('Those page numbers are not valid'))).toBe(false);
    expect(isStaleChunkError({ code: 'CANCELLED', message: 'cancelled' })).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
  });
});

describe('ErrorBlock stale-chunk recovery', () => {
  it('offers Reload instead of the raw fetch error', () => {
    render(
      <ErrorBlock
        error={new Error('Failed to fetch dynamically imported module: https://x/assets/a-b.js')}
      />,
    );
    expect(screen.getByText(/A new version of Folio was released/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload app' })).toBeTruthy();
    // Raw URL kept as secondary diagnostics, not the headline.
    expect(screen.getByText(/Failed to fetch dynamically/)).toBeTruthy();
  });

  it('renders ordinary errors unchanged', () => {
    render(<ErrorBlock error={new Error('Something broke')} />);
    expect(screen.getByText('Something broke')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload app' })).toBeNull();
  });

  it('renders as a bordered card with darker red, keeping message and code', () => {
    const error = Object.assign(new Error('Those page numbers are not valid'), {
      code: 'PAGE_OUT_OF_RANGE',
    });
    const { container } = render(<ErrorBlock error={error} />);
    const alert = screen.getByRole('alert');
    expect(alert.className).toMatch(/rounded-xl/);
    expect(alert.className).toMatch(/border/);
    expect(screen.getByText('Those page numbers are not valid').className).toMatch(/red-700/);
    expect(screen.getByText('PAGE_OUT_OF_RANGE')).toBeTruthy();
    expect(container.innerHTML).toContain('Those page numbers are not valid');
  });
});

describe('Progress determinate fill', () => {
  it('renders a single gradient fill layer so the percentage reads honestly', () => {
    const { container } = render(<Progress value={40} label="Working…" />);
    expect(screen.getByText('40%')).toBeTruthy();
    // One gradient layer only — the old always-full outer layer is gone.
    expect(container.querySelectorAll('.from-brass-500')).toHaveLength(1);
  });
});

describe('DropZone single labelled control', () => {
  it('exposes one tab-stop with the CTA as its accessible name', () => {
    const onFiles = vi.fn();
    const { container } = render(<DropZone onFiles={onFiles} cta="Select PDFs" />);
    // Exactly one focusable control: the file input. The CTA is visual only.
    const input = screen.getByLabelText('Select PDFs');
    expect(input.getAttribute('type')).toBe('file');
    const tabbables = container.querySelectorAll('button, input, a[href], [tabindex]');
    expect(tabbables).toHaveLength(1);
    expect(container.querySelector('button')).toBeNull();
  });
});
