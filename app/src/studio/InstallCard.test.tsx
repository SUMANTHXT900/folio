/**
 * InstallCard tests: the About install entry renders honest copy per state —
 * proof when installed, the explicit button when a prompt is stashed, manual
 * steps on iOS, and menu guidance otherwise. The app singleton runs
 * unpromptable under jsdom, so the fallback copy is what pins here; prompt
 * flows are covered in `installPrompt.test.ts` against the factory.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import InstallCard from './InstallCard';

afterEach(() => {
  cleanup();
});

describe('InstallCard', () => {
  it('renders the install entry with browser-menu guidance when no prompt exists', () => {
    render(<InstallCard />);
    expect(screen.getByLabelText('Install app')).toBeTruthy();
    expect(screen.getByText('This browser can install Folio from its own menu.')).toBeTruthy();
    // No dead button: without a stashed beforeinstallprompt there is
    // nothing to spend, so no Install control renders.
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
  });
});
