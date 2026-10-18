/**
 * Install-prompt store tests: platform detection, deferred-event capture,
 * explicit prompt outcomes, dismissal persistence, and installed proof.
 * The factory takes doubles throughout — no browser installability is
 * ever faked, and the app singleton is never touched here.
 */
import { describe, expect, it } from 'vitest';
import {
  createInstallPrompt,
  detectInstallPlatform,
  INSTALL_DISMISSED_KEY,
  type DeferredInstallPrompt,
} from './installPrompt';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    map,
  };
}

function deferredEvent(outcome: 'accepted' | 'dismissed'): DeferredInstallPrompt & {
  preventDefault: () => void;
  promptCalls: () => number;
} {
  let calls = 0;
  return {
    preventDefault: () => undefined,
    promptCalls: () => calls,
    prompt: async () => {
      calls += 1;
    },
    userChoice: Promise.resolve({ outcome }),
  };
}

describe('detectInstallPlatform', () => {
  it('detects iPhone and iPad UAs as iOS', () => {
    expect(
      detectInstallPlatform(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      ),
    ).toBe('ios');
    expect(
      detectInstallPlatform('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15'),
    ).toBe('ios');
  });

  it('detects desktop-iPadOS (Macintosh UA with touch points) as iOS', () => {
    expect(
      detectInstallPlatform(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15',
        5,
      ),
    ).toBe('ios');
  });

  it('treats desktop and Android Chrome as other (capability comes from the event, not the UA)', () => {
    expect(
      detectInstallPlatform(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      ),
    ).toBe('other');
    expect(
      detectInstallPlatform(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
      ),
    ).toBe('other');
  });
});

describe('createInstallPrompt', () => {
  it('starts unpromptable, uninstalled, undismissed on a plain browser', () => {
    const manager = createInstallPrompt({ storage: memoryStorage(), userAgent: 'jsdom' });
    const snap = manager.snapshot();
    expect(snap).toMatchObject({
      platform: 'other',
      installed: false,
      canPrompt: false,
      dismissed: false,
      outcome: null,
      busy: false,
    });
  });

  it('restores a persisted dismissal', () => {
    const manager = createInstallPrompt({
      storage: memoryStorage({ [INSTALL_DISMISSED_KEY]: '1' }),
      userAgent: 'jsdom',
    });
    expect(manager.snapshot().dismissed).toBe(true);
  });

  it('stashes beforeinstallprompt and spends it once on accept', async () => {
    const manager = createInstallPrompt({ storage: memoryStorage(), userAgent: 'jsdom' });
    const event = deferredEvent('accepted');
    manager.handleBeforeInstallPrompt(event);
    expect(manager.snapshot().canPrompt).toBe(true);

    await expect(manager.promptInstall()).resolves.toBe('accepted');
    const snap = manager.snapshot();
    expect(snap.outcome).toBe('accepted');
    expect(snap.canPrompt).toBe(false);
    expect(event.promptCalls()).toBe(1);

    // Spent: a second call has nothing to prompt with.
    await expect(manager.promptInstall()).resolves.toBe('unavailable');
    expect(event.promptCalls()).toBe(1);
  });

  it('maps a dismissed userChoice to the dismissed outcome (retry stays possible)', async () => {
    const manager = createInstallPrompt({ storage: memoryStorage(), userAgent: 'jsdom' });
    manager.handleBeforeInstallPrompt(deferredEvent('dismissed'));
    await expect(manager.promptInstall()).resolves.toBe('dismissed');
    expect(manager.snapshot().outcome).toBe('dismissed');
  });

  it('maps a throwing prompt to dismissed, never a hang', async () => {
    const manager = createInstallPrompt({ storage: memoryStorage(), userAgent: 'jsdom' });
    manager.handleBeforeInstallPrompt({
      preventDefault: () => undefined,
      prompt: async () => {
        throw new Error('no prompt');
      },
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    await expect(manager.promptInstall()).resolves.toBe('dismissed');
    expect(manager.snapshot().busy).toBe(false);
  });

  it('ignores foreign events that carry no prompt (never half-armed)', () => {
    const manager = createInstallPrompt({ storage: memoryStorage(), userAgent: 'jsdom' });
    manager.handleBeforeInstallPrompt({ preventDefault: () => undefined });
    expect(manager.snapshot().canPrompt).toBe(false);
  });

  it('returns unavailable with no deferred event (the UI never offers the button there)', async () => {
    const manager = createInstallPrompt({ storage: memoryStorage(), userAgent: 'jsdom' });
    await expect(manager.promptInstall()).resolves.toBe('unavailable');
  });

  it('persists dismissal and notifies subscribers', () => {
    const storage = memoryStorage();
    const manager = createInstallPrompt({ storage, userAgent: 'jsdom' });
    const seen: boolean[] = [];
    const unsubscribe = manager.subscribe(() => {
      seen.push(manager.snapshot().dismissed);
    });
    manager.dismiss();
    unsubscribe();
    expect(storage.map.get(INSTALL_DISMISSED_KEY)).toBe('1');
    expect(manager.snapshot().dismissed).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('marks installed on appinstalled and drops the stash', () => {
    const manager = createInstallPrompt({ storage: memoryStorage(), userAgent: 'jsdom' });
    manager.handleBeforeInstallPrompt(deferredEvent('accepted'));
    expect(manager.snapshot().canPrompt).toBe(true);
    manager.handleAppInstalled();
    expect(manager.snapshot()).toMatchObject({ installed: true, canPrompt: false });
  });

  it('survives throwing subscribers and storage', () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    const manager = createInstallPrompt({ storage: throwingStorage, userAgent: 'jsdom' });
    expect(manager.snapshot().dismissed).toBe(false);
    const unsubscribe = manager.subscribe(() => {
      throw new Error('subscriber bug');
    });
    expect(() => manager.dismiss()).not.toThrow();
    unsubscribe();
    expect(manager.snapshot().dismissed).toBe(true);
  });
});
