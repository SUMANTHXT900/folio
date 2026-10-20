/**
 * About UpdateCard tests (simple auto-apply update flow).
 *
 * The PWA store (`usePwaUpdate` / `updateManager`) is mocked at the module
 * boundary with one mutable snapshot — no worker, no navigation.
 * `releaseNotes` is wrapped with an override switch so the empty-list
 * fallback is asserted without touching the real notes.
 * `window.location.hostname` is stubbed per test to drive the production /
 * non-production notes branches.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import About from './About';
import type { UpdateSnapshot } from '../pwa/updateManager';
import type { ReleaseNote } from './releaseNotes';

const { snapshotState, managerMock, notesOverride } = vi.hoisted(() => ({
  snapshotState: {
    phase: 'idle',
    checking: false,
    statusText: 'Tap Update to check for the latest version.',
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

beforeEach(() => {
  setSnapshot({
    phase: 'idle',
    checking: false,
    statusText: 'Tap Update to check for the latest version.',
    canCheck: true,
  });
  notesOverride.value = null;
  managerMock.checkForUpdates.mockClear();
  managerMock.applyUpdate.mockClear();
  stubHostname('localhost');
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

  it('offers one Update button that runs the check on tap (no confirm step)', () => {
    render(<About />);
    const update = screen.getByRole('button', { name: 'Update' });
    expect(update.hasAttribute('disabled')).toBe(false);
    fireEvent.click(update);
    expect(managerMock.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(managerMock.checkForUpdates).toHaveBeenCalledWith(true);
    expect(managerMock.applyUpdate).not.toHaveBeenCalled();
  });

  it('names the checking state with a disabled button (no dead tap)', () => {
    setSnapshot({
      phase: 'checking',
      checking: true,
      statusText: 'Checking for updates…',
      canCheck: false,
    });
    render(<About />);
    const checking = screen.getByRole('button', { name: 'Checking…' });
    expect(checking.hasAttribute('disabled')).toBe(true);
  });

  it('names the applying state with a disabled Updating button', () => {
    setSnapshot({
      phase: 'applying',
      checking: false,
      statusText: 'Updating… reloading now.',
      canCheck: false,
    });
    render(<About />);
    const updating = screen.getByRole('button', { name: 'Updating…' });
    expect(updating.hasAttribute('disabled')).toBe(true);
  });

  it('keeps the local copy verbatim (E2E asserts Preview build)', () => {
    setSnapshot({
      phase: 'local',
      checking: false,
      statusText: 'Preview build — update checks run on the deployed site.',
      canCheck: false,
    });
    render(<About />);
    expect(
      within(card()).getByText('Preview build — update checks run on the deployed site.'),
    ).not.toBeNull();
  });

  it('always shows the running version and build stamp (freshness proof on every host)', () => {
    render(<About />);
    const text = card().textContent ?? '';
    expect(text).toMatch(/v\d+\.\d+/);
    expect(text).toContain('Built');
  });
});

describe('UpdateCard version proof', () => {
  it('renders Updated v{from} → v{now} after an applied update', () => {
    setSnapshot({
      phase: 'up-to-date',
      checking: false,
      statusText: 'Folio is up to date.',
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
      checking: false,
      statusText: 'Folio is up to date.',
      canCheck: true,
      updatedFrom: now,
    });
    render(<About />);
    expect(within(card()).getByText('Folio is up to date.')).not.toBeNull();
    expect(screen.queryByText(/^Updated v/)).toBeNull();
  });

  it('renders no proof line without the manager field', () => {
    setSnapshot({
      phase: 'up-to-date',
      checking: false,
      statusText: 'Folio is up to date.',
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
    // Latest production entry renders in full…
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

describe('Version tree channel gating', () => {
  it('strips the dev suffix on production (no dev leak in the version tree)', () => {
    stubHostname('folio-pdf.pages.dev');
    render(<About />);
    const tree = screen.getByLabelText('Version history');
    expect(tree.textContent).not.toMatch(/·\s*dev/);
  });

  it('keeps the dev suffix off-production (dev-preview still shows the working version)', () => {
    stubHostname('dev-folio-pdf.pages.dev');
    render(<About />);
    const tree = screen.getByLabelText('Version history');
    expect(tree.textContent).toMatch(/·\s*dev/);
  });
});
