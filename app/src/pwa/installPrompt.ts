/**
 * Install-prompt store (framework-free, mirrors `updateManager.ts`): captures
 * the Chromium `beforeinstallprompt` event, exposes a snapshot through
 * `useSyncExternalStore`, and owns the one explicit `prompt()` call behind
 * the Install button. iOS Safari never fires `beforeinstallprompt`, so the
 * store also detects iOS and the UI answers with Share → Add to Home Screen
 * steps instead of a dead button. Dismissal persists in localStorage
 * (private-mode safe); an installed app (standalone display mode, iOS
 * `navigator.standalone`, or the `appinstalled` event) renders proof copy,
 * never a button.
 */

export type InstallPlatform = 'ios' | 'other';

/** Last `userChoice` outcome of the explicit prompt, or null when unasked. */
export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable' | null;

export interface DeferredInstallPrompt {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallSnapshot {
  /** iOS gets manual steps; every other platform gets the prompt or menu copy. */
  platform: InstallPlatform;
  /** True in standalone display mode, iOS standalone, or after `appinstalled`. */
  installed: boolean;
  /** True while a deferred `beforeinstallprompt` is stashed and unspent. */
  canPrompt: boolean;
  /** True after the user dismisses the Home banner (persisted). */
  dismissed: boolean;
  outcome: InstallOutcome;
  busy: boolean;
}

/** localStorage key for the Home banner dismissal (advisory, never load-bearing). */
export const INSTALL_DISMISSED_KEY = 'folio.pwa.installDismissed';

/** iOS Safari/Chrome/Firefox on iOS: UA carries iPhone/iPad/iPod (iPadOS 13+ reports Macintosh — hence the touch-point fallback). */
export function detectInstallPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  if (/macintosh/i.test(userAgent) && maxTouchPoints > 1) return 'ios';
  return 'other';
}

/** True when the page already runs as an installed app (standalone display mode or iOS standalone). */
export function isStandaloneDisplay(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function') {
      try {
        if (window.matchMedia('(display-mode: standalone)').matches) return true;
      } catch {
        // matchMedia without a layout engine (jsdom) — fall through below.
      }
    }
    const nav = window.navigator as Navigator & { standalone?: unknown };
    return nav.standalone === true;
  } catch {
    return false;
  }
}

function readDismissed(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(INSTALL_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export interface InstallPromptDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  userAgent?: string;
  maxTouchPoints?: number;
}

/**
 * Testable store core: the singleton below wires real window events;
 * tests drive `handleBeforeInstallPrompt` / `handleAppInstalled` directly
 * with doubles, so no browser installability is ever faked.
 */
export function createInstallPrompt(deps: InstallPromptDeps = {}) {
  const storage =
    deps.storage !== undefined
      ? deps.storage
      : typeof window !== 'undefined'
        ? window.localStorage
        : null;
  const ua =
    deps.userAgent !== undefined
      ? deps.userAgent
      : typeof window !== 'undefined'
        ? window.navigator.userAgent
        : '';
  const touch =
    deps.maxTouchPoints !== undefined
      ? deps.maxTouchPoints
      : typeof window !== 'undefined'
        ? (window.navigator.maxTouchPoints ?? 0)
        : 0;

  let deferred: DeferredInstallPrompt | null = null;
  let installedByEvent = false;
  let snap: InstallSnapshot = {
    platform: detectInstallPlatform(ua, touch),
    installed: isStandaloneDisplay(),
    canPrompt: false,
    dismissed: readDismissed(storage),
    outcome: null,
    busy: false,
  };

  const listeners = new Set<() => void>();
  const emit = () => {
    snap = { ...snap, canPrompt: deferred !== null && !snap.installed };
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // A throwing subscriber must never break the store for the rest.
      }
    }
  };

  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    snapshot(): InstallSnapshot {
      return snap;
    },
    /** Stashes a `beforeinstallprompt` (calls `preventDefault` so no automatic mini-bar steals the explicit button). */
    handleBeforeInstallPrompt(
      event: Partial<DeferredInstallPrompt> & { preventDefault?: () => void },
    ): void {
      try {
        event.preventDefault?.();
      } catch {
        // preventDefault is best-effort on foreign event doubles.
      }
      if (typeof event.prompt !== 'function' || !event.userChoice) return;
      deferred = event as DeferredInstallPrompt;
      emit();
    },
    handleAppInstalled(): void {
      installedByEvent = true;
      deferred = null;
      snap = { ...snap, installed: true };
      emit();
    },
    /** Refreshes the standalone read (call on visibility resurface; cheap and honest). */
    refreshInstalled(): void {
      if (!installedByEvent && isStandaloneDisplay() !== snap.installed) {
        snap = { ...snap, installed: isStandaloneDisplay() };
        emit();
      }
    },
    /**
     * Runs the one explicit prompt. Returns the `userChoice` outcome
     * (`'unavailable'` when no deferred event exists — the UI never offers
     * the button in that state, so this is a caller bug, not a user error).
     */
    async promptInstall(): Promise<Exclude<InstallOutcome, null>> {
      const pending = deferred;
      if (snap.busy || !pending) return 'unavailable';
      snap = { ...snap, busy: true };
      emit();
      try {
        await pending.prompt();
        const choice = await pending.userChoice;
        snap = {
          ...snap,
          outcome: choice?.outcome === 'accepted' ? 'accepted' : 'dismissed',
        };
        return snap.outcome as Exclude<InstallOutcome, null>;
      } catch {
        snap = { ...snap, outcome: 'dismissed' };
        return 'dismissed';
      } finally {
        if (deferred === pending) deferred = null;
        snap = { ...snap, busy: false };
        emit();
      }
    },
    dismiss(): void {
      try {
        storage?.setItem(INSTALL_DISMISSED_KEY, '1');
      } catch {
        // Private mode / blocked storage — the in-memory flag still wins.
      }
      snap = { ...snap, dismissed: true };
      emit();
    },
  };
}

export type InstallPromptManager = ReturnType<typeof createInstallPrompt>;

/** App singleton: wires the two real window events once (browser only). */
function createSingleton(): InstallPromptManager {
  const manager = createInstallPrompt();
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (e: Event) => {
      manager.handleBeforeInstallPrompt(
        e as Event & Partial<DeferredInstallPrompt> & { preventDefault?: () => void },
      );
    });
    window.addEventListener('appinstalled', () => manager.handleAppInstalled());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) manager.refreshInstalled();
    });
  }
  return manager;
}

export const installPrompt = createSingleton();
