/**
 * Bulk-import pacing hint (AGENT11): the entry card tells users photos
 * decode one at a time, so large batches don't look stalled.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ImagesTool from './ImagesTool';

afterEach(() => {
  cleanup();
});

describe('ImagesTool bulk-import hint', () => {
  it('shows the one-at-a-time decode hint on the entry card', async () => {
    render(<ImagesTool />);
    expect(await screen.findByText(/decode one at a time/)).toBeTruthy();
  });
});
