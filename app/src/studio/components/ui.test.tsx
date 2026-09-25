/**
 * Shared UI primitive tests: the stale-chunk recovery path must turn an
 * undebuggable deploy-skew failure into an actionable reload prompt.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorBlock, isStaleChunkError } from './ui';

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
});
