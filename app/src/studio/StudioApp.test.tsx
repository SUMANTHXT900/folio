/**
 * StudioApp lane tests: theme toggle semantics, MobileNav Compress parity,
 * nav-mask focus handling, ToolFallback stall path, and chunk-regex parity
 * with `studio/components/ui.tsx`.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StudioApp, {
  MobileNav,
  ROUTE_CHUNK_RE,
  TOOL_FALLBACK_STALL_MS,
  ToolFallback,
  isRouteChunkError,
} from './StudioApp';
import { isStaleChunkError } from './components/ui';

const hadMatchMedia = typeof window.matchMedia === 'function';
const realMatchMedia = (window as unknown as Record<string, unknown>).matchMedia;

function mockMatchMedia() {
  const impl = () =>
    ({
      matches: false,
      media: '',
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
  window.matchMedia = impl as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.setItem('folio-theme', 'light');
  window.location.hash = '#/';
  mockMatchMedia();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.location.hash = '#/';
  if (hadMatchMedia) window.matchMedia = realMatchMedia as typeof window.matchMedia;
  else delete (window as unknown as Record<string, unknown>).matchMedia;
  vi.useRealTimers();
});

describe('theme toggle', () => {
  it('labels the action dynamically and exposes pressed state', () => {
    render(<StudioApp />);
    const toggle = screen.getByRole('button', { name: 'Switch to dark theme' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Switch to light theme' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

describe('MobileNav Compress parity', () => {
  it('never links the reserved compress id (disabled span like Home)', () => {
    render(<MobileNav route="merge" />);
    expect(document.querySelector('a[href="#/compress"]')).toBeNull();
    const item = screen.getByTitle('Reserved for a future update');
    expect(item.tagName).toBe('SPAN');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.querySelector('a')).toBeNull();
  });

  it('scrolls a focused link into view so the edge fade never clips it', () => {
    const spy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView =
      spy as unknown as typeof window.HTMLElement.prototype.scrollIntoView;
    render(<MobileNav route="merge" />);
    const link = document.querySelector('a[href="#/split"]') as HTMLElement;
    fireEvent.focus(link);
    expect(spy).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
    delete (window.HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView;
  });
});

describe('ToolFallback stall path', () => {
  it('stays a plain spinner first, then offers an honest retry', async () => {
    vi.useFakeTimers();
    render(<ToolFallback />);
    expect(screen.getByText('Loading tool…')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOOL_FALLBACK_STALL_MS + 500);
    });
    expect(screen.getByRole('alert')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Reload app' })).not.toBeNull();
  });
});

describe('route chunk-error parity', () => {
  const chunkShapes = [
    'Failed to fetch dynamically imported module: https://x/assets/Merge-abc.js',
    'Loading chunk 12 failed',
    'ChunkLoadError: Loading chunk vendors failed',
    'Importing a module script failed.',
    'error loading dynamically imported module',
  ];
  it.each(chunkShapes)('catches %s like ui.tsx', (message) => {
    expect(isRouteChunkError(new Error(message))).toBe(true);
    expect(ROUTE_CHUNK_RE.test(message)).toBe(true);
    expect(isStaleChunkError(new Error(message))).toBe(true);
  });

  it('does not mistake ordinary errors for stale chunks', () => {
    expect(isRouteChunkError(new Error('TypeError: x is undefined'))).toBe(false);
    expect(isStaleChunkError(new Error('TypeError: x is undefined'))).toBe(false);
  });
});
