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
});

// This repo's vitest config does not enable globals, so RTL auto-cleanup
// never runs — unmount explicitly or renders accumulate across tests.
afterEach(() => {
  cleanup();
});

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
});
