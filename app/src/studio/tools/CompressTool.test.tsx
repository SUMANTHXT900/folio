/**
 * CompressTool honesty tests (owned by the UI-copy lane).
 *
 * The level selector is preview-only while Compress is reserved: every
 * option renders disabled with its reason, so choosing a level can never
 * pretend to change the (non-existent) output.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CompressTool from './CompressTool';

vi.mock('../hooks/usePdfFiles', () => ({
  usePdfFiles: () => ({
    files: [{ id: 'test-1', name: 'report.pdf', sizeBytes: 1024 }],
    setFiles: vi.fn(),
    addFiles: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
});

describe('CompressTool level selector', () => {
  it('renders every level disabled with its reason (selection changes nothing)', () => {
    render(<CompressTool />);
    const group = screen.getByRole('radiogroup', { name: /compression level/i });
    expect(group.getAttribute('aria-disabled')).toBe('true');

    for (const label of ['Best quality', 'Balanced', 'Maximum compression']) {
      const option = screen.getByRole('button', { name: new RegExp(label) });
      expect(option.hasAttribute('disabled')).toBe(true);
      expect(option.getAttribute('title')).toMatch(/does nothing/i);
    }
    // The reason is spelled out once beside the group, not hidden in hover text.
    expect(screen.getByText(/these options do nothing until Compress ships/i)).not.toBeNull();
  });

  it('keeps the action disabled with an explicit future-functionality note', () => {
    render(<CompressTool />);
    const action = screen.getByRole('button', { name: 'Compress' });
    expect(action.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/stays disabled rather than pretending to work/i)).not.toBeNull();
  });
});
