/**
 * About UpdateCard tests (R2 confirm-then-apply rebuild).
 *
 * The PWA store (`usePwaUpdate` / `updateManager`) is mocked at the module
 * boundary with one mutable snapshot, so every manager phase is driven by
 * direct mutation + rerender — no worker, no navigation. `releaseNotes` is
 * wrapped with an override switch so the empty-list fallback is asserted
 * without touching the real notes. `window.location.hostname` is stubbed
 * per test to drive the production / non-production notes branches.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import About from './About';
import type { UpdateSnapshot } from '../pwa/updateManager';
import type { ReleaseNote } from './releaseNotes';

const { snapshotState, managerMock, notesOverride } = vi.hoisted(() => ({
  snapshotState: {
    phase: 'idle',
    updateAvailable: false,
    checking: false,
    statusText: 'Tap Check for updates to verify.',
    log: [],
    canCheck: true,
    updatedFrom: null,
  } as UpdateSnapshot,
  managerMock: { checkForUpdates: vi.fn(), applyUpdate: vi.fn() },
  notesOverride: { value: null as ReleaseNote[] | null },
}));

vi.mock('../pwa/usePwaUpdate', () => ({
  usePwaUpdate: () => snapshotState,
  updateManager: managerMock,
}));

vi.mock('./releaseNotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./releaseNotes')>();
  return {
    ...actual,
    get RELEASE_NOTES() {
      return notesOverride.value ?? actual.RELEASE_NOTES;
    },
  };
});

const realLocation = window.location;

function stubHostname(hostname: string) {
  Object.defineProperty(window, 'location', {
    value: { hostname },
    configurable: true,
    writable: true,
  });
}

function setSnapshot(patch: Partial<UpdateSnapshot>) {
  Object.assign(snapshotState, patch);
  if (!('updatedFrom' in patch) && 'updatedFrom' in snapshotState) {
    delete (snapshotState as unknown as Record<string, unknown>).updatedFrom;
  }
}

function card(): HTMLElement {
  const el = document.getElementById('app-updates');
  if (!el) throw new Error('expected #app-updates section to exist');
  return el;
}

function heading(): HTMLElement {
  return screen.getByRole('heading', { name: 'App updates' });
}

function showAvailable() {
  setSnapshot({
    phase: 'update-available',
    updateAvailable: true,
    checking: false,
    statusText: 'A new version is ready.',
    log: [],
    canCheck: false,
  });
}

beforeEach(() => {
  setSnapshot({
    phase: 'idle',
    updateAvailable: false,
    checking: false,
    statusText: 'Tap Check for updates to verify.',
    log: [],
    canCheck: true,
  });
  notesOverride.value = null;
  managerMock.checkForUpdates.mockClear();
  managerMock.applyUpdate.mockClear();
  stubHostname('localhost');
  // jsdom may lack scrollIntoView (or log not-implemented noise) — the card
  // guards every call, but a quiet stub keeps arrival-scroll assertions exact.
  if (typeof Element.prototype.scrollIntoView === 'function') {
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  } else {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'location', {
    value: realLocation,
    configurable: true,
    writable: true,
  });
});

describe('UpdateCard structure', () => {
  it('anchors the card as #app-updates with sticky-header clearance', () => {
    render(<About />);
    const el = card();
    expect(el.classList.contains('scroll-mt-24')).toBe(true);
  });

  it('offers an idle check with the exact E2E label and calls check on tap', () => {
    render(<About />);
    const check = screen.getByRole('button', { name: 'Check for updates' });
    expect(check.hasAttribute('disabled')).toBe(false);
    fireEvent.click(check);
    expect(managerMock.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(managerMock.checkForUpdates).toHaveBeenCalledWith(true);
  });

  it('names the checking state with a disabled button (no dead tap)', () => {
    setSnapshot({
      phase: 'checking',
      updateAvailable: false,
      checking: true,
      statusText: 'Checking for updates…',
      log: [],
      canCheck: false,
    });
    render(<About />);
    const checking = screen.getByRole('button', { name: 'Checking…' });
    expect(checking.hasAttribute('disabled')).toBe(true);
  });

  it('keeps the local/offline copy verbatim (E2E asserts Preview build)', () => {
    setSnapshot({
      phase: 'local',
      updateAvailable: false,
      checking: false,
      statusText: 'Preview build — update checks run on the deployed site.',
      log: [],
      canCheck: false,
    });
    render(<About />);
    // Scoped to the update card: the dev-channel card mirrors the same
    // manager status line in its service-worker box.
    expect(
      within(card()).getByText('Preview build — update checks run on the deployed site.'),
    ).not.toBeNull();
  });

  it('auto-expands literal log lines while an update waits, toggle stays authoritative', () => {
    showAvailable();
    setSnapshot({ log: ['12:00:00 Service worker reported a waiting update.'] });
    render(<About />);
    expect(screen.getByText('› 12:00:00 Service worker reported a waiting update.')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(screen.queryByText('› 12:00:00 Service worker reported a waiting update.')).toBeNull();
  });
});

describe('UpdateCard confirm-then-apply', () => {
  it('arms the brass confirm on Review & update (banner-arrival focuses the heading)', () => {
    showAvailable();
    render(<About />);
    // Mount with an update waiting: heading owns focus for screen readers.
    expect(document.activeElement).toBe(heading());
    // Available but unconfirmed: Review & update only, no direct apply.
    expect(screen.queryByRole('group', { name: 'Confirm update' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    const panel = screen.getByRole('group', { name: 'Confirm update' });
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain(
      'A new version is ready. Update now? Your open work stays in this tab until the reload.',
    );
    expect(document.activeElement).toBe(heading());
    // Confirming shows Update now + Not now (never a second Review button).
    expect(screen.getByRole('button', { name: 'Update now' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Not now' })).not.toBeNull();
  });

  it('applies only from the confirm panel (banner-style direct apply is gone)', () => {
    showAvailable();
    render(<About />);
    expect(managerMock.applyUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    expect(managerMock.applyUpdate).toHaveBeenCalledTimes(1);
  });

  it('disables every control while applying, then re-arms the retry on failure', () => {
    showAvailable();
    const { rerender } = render(<About />);
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    setSnapshot({ phase: 'applying', statusText: 'Installing update… Reloading.' });
    rerender(<About />);
    expect(screen.getByRole('button', { name: 'Check for updates' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Installing…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Not now' }).hasAttribute('disabled')).toBe(true);
    // Failed activation lands back on the waiting version — confirm is still
    // armed, so the retry is one tap, not two.
    setSnapshot({ phase: 'update-available', statusText: 'A new version is ready.' });
    rerender(<About />);
    const retry = screen.getByRole('button', { name: 'Update now' });
    expect(retry.hasAttribute('disabled')).toBe(false);
    fireEvent.click(retry);
    expect(managerMock.applyUpdate).toHaveBeenCalledTimes(1);
  });

  it('Not now disarms back to Review & update', () => {
    showAvailable();
    render(<About />);
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    expect(screen.getByRole('group', { name: 'Confirm update' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('group', { name: 'Confirm update' })).toBeNull();
    const trigger = screen.getByRole('button', { name: 'Review & update' });
    expect(trigger).not.toBeNull();
    // Focus dropped with the unmounted panel returns to the arming trigger.
    expect(document.activeElement).toBe(trigger);
    expect(managerMock.applyUpdate).not.toHaveBeenCalled();
  });

  it('Esc disarms and returns focus to the arming trigger', () => {
    showAvailable();
    render(<About />);
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    expect(screen.getByRole('group', { name: 'Confirm update' })).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Confirm update' })).toBeNull();
    const trigger = screen.getByRole('button', { name: 'Review & update' });
    expect(document.activeElement).toBe(trigger);
  });

  it('a resolved update disarms the confirm', () => {
    showAvailable();
    const { rerender } = render(<About />);
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    expect(screen.getByRole('group', { name: 'Confirm update' })).not.toBeNull();
    setSnapshot({
      phase: 'up-to-date',
      updateAvailable: false,
      statusText: 'Folio is up to date.',
      canCheck: true,
    });
    rerender(<About />);
    expect(screen.queryByRole('group', { name: 'Confirm update' })).toBeNull();
  });
});

describe('UpdateCard version proof', () => {
  it('renders Updated v{from} → v{now} after an applied update', () => {
    setSnapshot({
      phase: 'up-to-date',
      updateAvailable: false,
      checking: false,
      statusText: 'Folio is up to date.',
      log: [],
      canCheck: true,
      updatedFrom: '0.0.0-proof',
    });
    render(<About />);
    const badgeText = card().querySelector('span.font-mono')?.textContent ?? '';
    const now = badgeText.replace(/^v/, '');
    expect(screen.getByText(`Updated v0.0.0-proof → v${now}`)).not.toBeNull();
  });

  it('renders no proof line for a same-version compare', () => {
    render(<About />);
    const badgeText = card().querySelector('span.font-mono')?.textContent ?? '';
    const now = badgeText.replace(/^v/, '');
    cleanup();
    setSnapshot({
      phase: 'up-to-date',
      updateAvailable: false,
      checking: false,
      statusText: 'Folio is up to date.',
      log: [],
      canCheck: true,
      updatedFrom: now,
    });
    render(<About />);
    expect(within(card()).getByText('Folio is up to date.')).not.toBeNull();
    expect(screen.queryByText(/^Updated v/)).toBeNull();
  });

  it('renders no proof line without the manager field (pre-R1 snapshot)', () => {
    setSnapshot({
      phase: 'up-to-date',
      updateAvailable: false,
      checking: false,
      statusText: 'Folio is up to date.',
      log: [],
      canCheck: true,
    });
    render(<About />);
    expect(screen.queryByText(/^Updated v/)).toBeNull();
  });
});

describe('UpdateCard what-changed notes', () => {
  it('links non-production hosts to the Build channel card below (same-page target present)', () => {
    stubHostname('localhost');
    render(<About />);
    const block = screen.getByLabelText('What changed');
    expect(card().contains(block)).toBe(true);
    const link = screen.getByRole('link', {
      name: "See what's new in the Build channel card below.",
    });
    expect(block.contains(link)).toBe(true);
    expect(link.getAttribute('href')).toBe('#build-channel');
    // Same-page scroll target: the DevChannelCard section carries the id.
    expect(document.getElementById('build-channel')).not.toBeNull();
  });

  it('never duplicates dev-wave copy on non-production hosts', () => {
    stubHostname('dev-folio-pdf.pages.dev');
    render(<About />);
    // A DEV_NOTES-only line lives in the channel card, not in the update card.
    const updateText = card().textContent ?? '';
    expect(updateText).not.toContain('Main-lens default scoring.');
  });

  it('renders production release notes newest-first with no dev-wave copy', () => {
    stubHostname('folio-pdf.pages.dev');
    render(<About />);
    const block = screen.getByLabelText('What changed');
    expect(card().contains(block)).toBe(true);
    // Latest production entry (R4 notes) renders in full…
    expect(block.textContent).toContain('v1.10.1 release');
    expect(block.textContent).toContain(
      'Scanner detection is now ML-only — a miss keeps your full photo instead of a guessed crop.',
    );
    // …and no dev-wave internals pose as release notes.
    expect(block.textContent).not.toContain('Main-lens default scoring.');
    expect(block.textContent).not.toContain('D35/D36 scanner UX');
  });

  it('falls back honestly when production ships no notes', () => {
    stubHostname('folio-pdf.pages.dev');
    notesOverride.value = [];
    render(<About />);
    const block = screen.getByLabelText('What changed');
    const badgeText = card().querySelector('span.font-mono')?.textContent ?? '';
    const now = badgeText.replace(/^v/, '');
    expect(block.textContent).toContain(
      `Update installed (v${now}). What's-new notes aren't included with this build.`,
    );
  });
});
