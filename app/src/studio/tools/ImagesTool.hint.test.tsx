/**
 * Bulk-import pacing hint (AGENT11): the entry card tells users photos
 * decode one at a time, so large batches don't look stalled.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImagesTool from './ImagesTool';

// Sibling-owned ContinueCard (see ImagesTool.test.ts): mocked to the
// frozen contract so this suite never depends on the sibling lane's file.
vi.mock('../components/ContinueCard', () => ({
  ContinueCard: (_props: Record<string, unknown>) =>
    createElement('div', { 'data-continue-card': 'true' }),
}));

afterEach(() => {
  cleanup();
});

describe('ImagesTool bulk-import hint', () => {
  it('shows the one-at-a-time decode hint on the entry card', async () => {
    render(<ImagesTool />);
    expect(await screen.findByText(/decode one at a time/)).toBeTruthy();
  });
});
