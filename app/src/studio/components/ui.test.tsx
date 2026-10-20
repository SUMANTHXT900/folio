/**
 * Shared UI primitive tests: the stale-chunk recovery path must turn an
 * undebuggable deploy-skew failure into an actionable reload prompt.
 *
 * DoneBanner / Spinner / ErrorBlock honesty + a11y: success banners announce
 * via role="status" without claiming a verified save, filenames are
 * sanitized at the last mile, spinners never render an empty status, and
 * long engine secondary values truncate instead of blowing the card.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DoneBanner, DropZone, ErrorBlock, Progress, Spinner, isStaleChunkError } from './ui';

beforeEach(() => {
  let counter = 0;
  URL.createObjectURL = vi.fn(() => {
    counter += 1;
    return `blob:ui-${counter}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

describe('DoneBanner honest success', () => {
  it('announces via role="status" without claiming a verified save', () => {
    const blob = new Blob(['a'], { type: 'application/pdf' });
    render(<DoneBanner name="report.pdf" blob={blob} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/report\.pdf/);
    expect(status.textContent).toMatch(/Download started/);
    expect(status.textContent).not.toMatch(/save it again/i);
  });

  it('sanitizes the download attribute at the last mile', () => {
    const blob = new Blob(['a'], { type: 'application/pdf' });
    render(<DoneBanner name="a/b:c" blob={blob} />);
    const anchor = screen.getByText('Save to device').closest('a');
    expect(anchor?.getAttribute('download')).toBe('a-b-c.pdf');
    expect(screen.getByRole('status').textContent).toMatch(/a-b-c\.pdf/);
  });
});

describe('Spinner status announcement', () => {
  it('exposes role="status" with the visible label', () => {
    render(<Spinner label="Rotating…" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/Rotating…/);
  });

  it('keeps an sr-only name when no visible label is given', () => {
    const { container } = render(<Spinner />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading');
    expect(container.querySelector('.sr-only')).toBeTruthy();
  });
});

describe('ErrorBlock secondary truncation', () => {
  it('truncates long secondary values but keeps the primary and code', () => {
    const longDetails = `source=${'d'.repeat(500)}.pdf`;
    const error = Object.assign(new Error('Those page numbers are not valid'), {
      code: 'INVALID_PAGE_RANGE',
      details: longDetails,
    });
    render(<ErrorBlock error={error} />);
    expect(screen.getByText('Those page numbers are not valid')).toBeTruthy();
    expect(screen.getByText('INVALID_PAGE_RANGE')).toBeTruthy();
    const secondary = screen.getByTitle(longDetails);
    expect(secondary.textContent ?? '').toMatch(/…$/);
    expect((secondary.textContent ?? '').length).toBeLessThanOrEqual(240);
  });

  it('leaves short secondary values untouched (no title)', () => {
    const error = Object.assign(new Error('Primary line'), {
      code: 'INTERNAL',
      details: 'short detail',
    });
    const { container } = render(<ErrorBlock error={error} />);
    expect(screen.getByText(/short detail/)).toBeTruthy();
    expect(container.querySelector('[title]')).toBeNull();
  });
});
