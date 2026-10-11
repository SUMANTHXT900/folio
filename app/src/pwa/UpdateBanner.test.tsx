import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { HTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UpdateBanner from './UpdateBanner';
import type { UpdateSnapshot } from './updateManager';

const { snapshotState } = vi.hoisted(() => ({
  snapshotState: {
    phase: 'idle',
    updateAvailable: false,
    checking: false,
    statusText: 'Tap Check for updates to verify.',
    log: [],
    canCheck: true,
  } as UpdateSnapshot,
}));

vi.mock('./usePwaUpdate', () => ({
  usePwaUpdate: () => snapshotState,
}));

// framer-motion's exit fade never completes in jsdom, leaving dismissed
// banners mounted as ghosts and breaking exact counts. Strip animation so
// mount/unmount is synchronous here (production motion untouched).
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...rest
    }: Record<string, unknown>) => <div {...(rest as HTMLAttributes<HTMLDivElement>)} />,
  },
}));

function showUpdate() {
  snapshotState.updateAvailable = true;
  snapshotState.phase = 'update-available';
  snapshotState.statusText = 'A new version is ready.';
}

beforeEach(() => {
  snapshotState.phase = 'idle';
  snapshotState.updateAvailable = false;
  snapshotState.checking = false;
  snapshotState.statusText = 'Tap Check for updates to verify.';
  snapshotState.log = [];
  snapshotState.canCheck = true;
  window.location.hash = '';
});

// This repo's vitest config does not enable globals, so RTL auto-cleanup
// never runs — unmount explicitly or renders accumulate across tests.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

/** jsdom has no matchMedia — stub it so the scroll behavior branch runs. */
function stubMatchMedia(matches: boolean) {
  const impl = () =>
    ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
  if (typeof window.matchMedia === 'function') {
    vi.spyOn(window, 'matchMedia').mockImplementation(impl);
  } else {
    window.matchMedia = impl;
  }
}

describe('UpdateBanner', () => {
  it('renders nothing while no update waits', () => {
    render(<UpdateBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces the waiting update with a review link (never applies itself)', () => {
    showUpdate();
    render(<UpdateBanner />);
    expect(screen.getByRole('alert')).not.toBeNull();
    expect(screen.getByText('A new version is ready')).not.toBeNull();
    const review = screen.getByText('Review update');
    expect(review.closest('a')?.getAttribute('href')).toBe('#/about');
  });

  it('a dismiss covers only that update — a newer arrival re-surfaces', () => {
    showUpdate();
    const { rerender } = render(<UpdateBanner />);
    expect(screen.queryByRole('alert')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Dismiss update notice'));
    expect(screen.queryByRole('alert')).toBeNull();
    // Same update lingering: stays dismissed.
    rerender(<UpdateBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
    // New arrival (false→true transition): banner returns.
    snapshotState.updateAvailable = false;
    rerender(<UpdateBanner />);
    showUpdate();
    rerender(<UpdateBanner />);
    expect(screen.queryByRole('alert')).not.toBeNull();
  });

  it('names the installing state while applying (no dead tap)', () => {
    showUpdate();
    snapshotState.phase = 'applying';
    render(<UpdateBanner />);
    expect(screen.getByText('Installing…')).not.toBeNull();
  });

  it('same-hash tap scrolls to the updates card instead of dead-tapping', () => {
    showUpdate();
    window.location.hash = '#/about';
    stubMatchMedia(false);
    const heading = document.createElement('h2');
    const focusSpy = vi.spyOn(heading, 'focus');
    const card = document.createElement('section');
    const scrollSpy = vi.fn();
    card.scrollIntoView = scrollSpy;
    vi.spyOn(card, 'querySelector').mockReturnValue(heading);
    const byId = vi.spyOn(document, 'getElementById').mockReturnValue(card);
    render(<UpdateBanner />);
    const link = screen.getByText('Review update').closest('a');
    expect(link).not.toBeNull();
    // preventDefault → fireEvent reports the click as cancelled.
    expect(fireEvent.click(link as HTMLAnchorElement)).toBe(false);
    expect(byId).toHaveBeenCalledWith('app-updates');
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(focusSpy).toHaveBeenCalled();
  });

  it('cross-hash tap keeps default hash navigation', () => {
    showUpdate();
    window.location.hash = '#/';
    stubMatchMedia(false);
    const byId = vi.spyOn(document, 'getElementById');
    render(<UpdateBanner />);
    const link = screen.getByText('Review update').closest('a');
    expect(link?.getAttribute('href')).toBe('#/about');
    // Not cancelled → the browser performs the default hash navigation.
    expect(fireEvent.click(link as HTMLAnchorElement)).toBe(true);
    expect(byId).not.toHaveBeenCalled();
  });

  it('dismiss target meets the 44px touch minimum', () => {
    showUpdate();
    render(<UpdateBanner />);
    const dismiss = screen.getByLabelText('Dismiss update notice');
    expect(dismiss.className).toContain('min-h-[44px]');
    expect(dismiss.className).toContain('min-w-[44px]');
  });

  it('never applies the update itself — only links to About', () => {
    showUpdate();
    window.location.hash = '#/';
    stubMatchMedia(false);
    render(<UpdateBanner />);
    // No apply affordance lives in the banner (Update now is About's job).
    expect(screen.queryByText('Update now')).toBeNull();
    fireEvent.click(screen.getByText('Review update'));
    // Tapping review neither applies nor dismisses — the banner persists.
    expect(screen.queryByText('Update now')).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeNull();
  });
});
