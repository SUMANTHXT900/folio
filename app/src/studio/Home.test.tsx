/**
 * Home honesty + Compress-card focus tests (owned by the UI-copy lane).
 *
 * - Network copy is docs/PROJECT.md-accurate: documents never leave the
 *   device; the app shell + update check use the network. No absolute
 *   "0 servers / never touches a server" claim may render.
 * - The reserved Compress card is visible but NOT focusable (no keyboard
 *   dead end): no tab stop, still described for AT via the virtual cursor.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Home from './Home';

afterEach(() => {
  cleanup();
});

describe('Home network honesty', () => {
  it('never claims zero servers / nothing uploaded', () => {
    render(<Home />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/servers touched/i);
    expect(text).not.toMatch(/nothing is uploaded/i);
    expect(text).not.toMatch(/never touch(es)? a server/i);
  });

  it('states the docs-accurate guarantee with the network nuance', () => {
    render(<Home />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/0 document uploads/);
    expect(text).toMatch(/never leave your device/i);
    expect(text).toMatch(/update check use/i);
  });
});

describe('Home Compress card', () => {
  it('is visible but out of the tab order (no keyboard dead end)', () => {
    render(<Home />);
    const card = screen.getByTitle('Reserved for a future update');
    expect(card.tagName).toBe('DIV');
    expect(card.getAttribute('tabindex')).toBeNull();
    expect(card.getAttribute('aria-disabled')).toBe('true');
    expect(card.getAttribute('aria-describedby')).toMatch(/tool-desc-compress/);
  });
});
