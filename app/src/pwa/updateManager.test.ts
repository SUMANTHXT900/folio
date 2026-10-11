import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLIED_BUILD_FLAG,
  APPLIED_FLAG,
  APPLIED_FROM_FLAG,
  classifyEnv,
  createUpdateManager,
  platformNeedsFullClose,
  statusTextFor,
  type RegistrarHooks,
  type UpdateEnv,
} from './updateManager';

const onlineHost: UpdateEnv = {
  hostname: 'dev.folio-pdf.pages.dev',
  secureContext: true,
  online: true,
  swSupported: true,
};

describe('classifyEnv', () => {
  it('treats localhost as local', () => {
    expect(classifyEnv({ ...onlineHost, hostname: 'localhost' })).toBe('local');
    expect(classifyEnv({ ...onlineHost, hostname: '127.0.0.1' })).toBe('local');
  });

  it('treats insecure LAN origins as local (PWA disabled there)', () => {
    expect(classifyEnv({ ...onlineHost, hostname: '192.168.1.5', secureContext: false })).toBe(
      'local',
    );
    expect(classifyEnv({ ...onlineHost, hostname: 'nas.local', secureContext: false })).toBe(
      'local',
    );
  });

  it('treats HTTPS hosts as update-capable', () => {
    expect(classifyEnv(onlineHost)).toBe('ok');
  });

  it('treats missing Service Worker support as unsupported', () => {
    expect(classifyEnv({ ...onlineHost, swSupported: false })).toBe('unsupported');
  });
});

describe('statusTextFor', () => {
  it('has copy for every phase (no blank UI states)', () => {
    const phases = [
      'unknown',
      'local',
      'unsupported',
      'idle',
      'checking',
      'applying',
      'update-available',
      'up-to-date',
      'offline',
      'error',
    ] as const;
    for (const phase of phases) {
      expect(statusTextFor(phase).length).toBeGreaterThan(0);
    }
  });

  it('uses plain preview-build wording for the local phase (no dev jargon)', () => {
    expect(statusTextFor('local')).toBe('Preview build — update checks run on the deployed site.');
  });
});

describe('createUpdateManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });

  function stubUserAgent(value: string): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
    Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
    return () => {
      if (descriptor) {
        Object.defineProperty(window.navigator, 'userAgent', descriptor);
      } else {
        delete (window.navigator as unknown as Record<string, unknown>).userAgent;
      }
    };
  }

  function stubStandaloneDisplay(matches: boolean): () => void {
    const original = window.matchMedia;
    const impl = (query: string) =>
      ({
        matches: matches && query === '(display-mode: standalone)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList;
    window.matchMedia = impl as unknown as typeof window.matchMedia;
    return () => {
      if (original === undefined) {
        delete (window as unknown as Record<string, unknown>).matchMedia;
      } else {
        window.matchMedia = original;
      }
    };
  }

  function fakeRegistrar(hooks: RegistrarHooks, impl?: Partial<{ update: () => Promise<void> }>) {
    return {
      hooks,
      update: impl?.update ?? (() => Promise.resolve()),
      applyUpdate: vi.fn(),
    };
  }

  it('stays local on localhost and never registers', async () => {
    const register = vi.fn(async (_hooks: RegistrarHooks) => fakeRegistrar(_hooks));
    const manager = createUpdateManager({
      register,
      env: () => ({ ...onlineHost, hostname: 'localhost' }),
    });
    manager.init();
    expect(manager.snapshot().phase).toBe('local');
    expect(register).not.toHaveBeenCalled();
    await manager.checkForUpdates(true);
    expect(register).not.toHaveBeenCalled();
  });

  it('reports up-to-date when the worker stays silent', async () => {
    const manager = createUpdateManager({
      register: (h) => Promise.resolve(fakeRegistrar(h)),
      env: () => onlineHost,
      settleWaitMs: 1000,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(1500);
    await check;
    expect(manager.snapshot().phase).toBe('up-to-date');
    expect(manager.snapshot().updateAvailable).toBe(false);
  });

  it('flags update-available when the worker signals mid-check', async () => {
    let onNeedRefresh: (() => void) | undefined;
    const manager = createUpdateManager({
      register: (h) => {
        onNeedRefresh = h.onNeedRefresh;
        return Promise.resolve(fakeRegistrar(h));
      },
      env: () => onlineHost,
      settleWaitMs: 5000,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    onNeedRefresh?.();
    await vi.advanceTimersByTimeAsync(300);
    await check;
    expect(manager.snapshot().updateAvailable).toBe(true);
    expect(manager.snapshot().phase).toBe('update-available');
  });

  it('reports offline without touching the network', async () => {
    const register = vi.fn(async (_hooks: RegistrarHooks) => fakeRegistrar(_hooks));
    const manager = createUpdateManager({
      register,
      env: () => ({ ...onlineHost, online: false }),
      settleWaitMs: 100,
    });
    await manager.checkForUpdates(true);
    expect(manager.snapshot().phase).toBe('offline');
    expect(register).not.toHaveBeenCalled();
  });

  it('reports registration failure as an error', async () => {
    const manager = createUpdateManager({
      register: () => Promise.reject(new Error('denied')),
      env: () => onlineHost,
      settleWaitMs: 100,
    });
    await manager.checkForUpdates(true);
    expect(manager.snapshot().phase).toBe('error');
    expect(manager.snapshot().log.join('\n')).toMatch(/denied/);
  });

  it('applyUpdate delegates to the waiting worker (one tap)', async () => {
    let applied: (() => void) | null = null;
    const reload = vi.fn();
    const manager = createUpdateManager({
      register: () =>
        Promise.resolve({ update: () => Promise.resolve(), applyUpdate: () => applied?.() }),
      env: () => onlineHost,
      settleWaitMs: 100,
      reload,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    await check;
    applied = vi.fn();
    await manager.applyUpdate();
    expect(applied).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('caps the diagnostic log', async () => {
    const manager = createUpdateManager({
      register: (h) => Promise.resolve(fakeRegistrar(h)),
      env: () => onlineHost,
      settleWaitMs: 50,
      maxLogLines: 4,
    });
    for (let i = 0; i < 6; i += 1) {
      const check = manager.checkForUpdates(true);
      await vi.advanceTimersByTimeAsync(200);
      await check;
    }
    expect(manager.snapshot().log.length).toBeLessThanOrEqual(4);
  });

  it('silent init registers and checks without blocking', async () => {
    const register = vi.fn(async (_hooks: RegistrarHooks) => fakeRegistrar(_hooks));
    const manager = createUpdateManager({
      register,
      env: () => onlineHost,
      autoCheckDelayMs: 3000,
      settleWaitMs: 500,
    });
    manager.init();
    expect(manager.snapshot().phase).toBe('idle');
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(800);
    expect(register).toHaveBeenCalledTimes(1);
    // Second init is a no-op (StrictMode double-effect safe).
    manager.init();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('keeps a stable snapshot reference between emissions (useSyncExternalStore)', async () => {
    const manager = createUpdateManager({
      register: (h) => Promise.resolve(fakeRegistrar(h)),
      env: () => onlineHost,
      settleWaitMs: 100,
    });
    // No subscriber loop: identical reference until state actually changes.
    expect(manager.snapshot()).toBe(manager.snapshot());
    const before = manager.snapshot();
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    await check;
    expect(manager.snapshot()).not.toBe(before);
    expect(manager.snapshot()).toBe(manager.snapshot());
  });

  it('prefixes every log line with the local timestamp (HH:MM:SS)', async () => {
    const manager = createUpdateManager({
      register: (h) => Promise.resolve(fakeRegistrar(h)),
      env: () => onlineHost,
      settleWaitMs: 1000,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(1500);
    await check;
    const { log } = manager.snapshot();
    expect(log.length).toBeGreaterThan(0);
    for (const line of log) {
      expect(line).toMatch(/^\d{2}:\d{2}:\d{2} /);
    }
  });

  it('writes literal log copy: sw.js re-fetch, settle wait, silent window', async () => {
    const manager = createUpdateManager({
      register: (h) => Promise.resolve(fakeRegistrar(h)),
      env: () => onlineHost,
      settleWaitMs: 5000,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(5500);
    await check;
    const text = manager.snapshot().log.join('\n');
    expect(text).toMatch(/sw\.js/);
    expect(text).toMatch(/Waiting 5s for the worker to answer/);
    expect(text).toMatch(/No new version answered within 5s/);
    expect(text).not.toMatch(/edge server/i);
    expect(text).not.toMatch(/Verifying worker integrity/);
    expect(text).not.toMatch(/Hashes match/);
  });

  it('applyUpdate sets a visible applying phase before delegating', async () => {
    const applyUpdate = vi.fn();
    const reload = vi.fn();
    const manager = createUpdateManager({
      register: () => Promise.resolve({ update: () => Promise.resolve(), applyUpdate }),
      env: () => onlineHost,
      settleWaitMs: 100,
      reload,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    await check;
    const applying = manager.applyUpdate();
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(manager.snapshot().phase).toBe('applying');
    expect(manager.snapshot().statusText).toBe('Installing update… Reloading.');
    expect(manager.snapshot().canCheck).toBe(false);
    expect(manager.snapshot().log.join('\n')).toMatch(/Activating the waiting worker/);
    await applying;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('applyUpdate without a registrar stays put (no crash, no phase change)', () => {
    const manager = createUpdateManager({
      register: () => Promise.reject(new Error('never')),
      env: () => onlineHost,
    });
    expect(() => manager.applyUpdate()).not.toThrow();
    expect(manager.snapshot().phase).toBe('unknown');
  });

  it('exposes updateAvailable for UpdateCard auto-expand (no extra snapshot field)', async () => {
    let onNeedRefresh: (() => void) | undefined;
    const manager = createUpdateManager({
      register: (h) => {
        onNeedRefresh = h.onNeedRefresh;
        return Promise.resolve(fakeRegistrar(h));
      },
      env: () => onlineHost,
      settleWaitMs: 5000,
    });
    expect(Object.keys(manager.snapshot()).sort()).toEqual(
      [
        'canCheck',
        'checking',
        'log',
        'phase',
        'statusText',
        'updateAvailable',
        'updatedFrom',
      ].sort(),
    );
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    onNeedRefresh?.();
    await vi.advanceTimersByTimeAsync(300);
    await check;
    // UpdateCard reads this flag directly to auto-expand its details.
    expect(manager.snapshot().updateAvailable).toBe(true);
  });

  it('classifies IPv6 loopback (either spelling), empty, 0.0.0.0 and *.localhost as local', () => {
    for (const hostname of ['::1', '[::1]', '', '0.0.0.0', 'app.localhost', 'LOCALHOST']) {
      expect(classifyEnv({ ...onlineHost, hostname })).toBe('local');
    }
  });

  it('zero auto-check delay disables the silent launch check (like negative)', async () => {
    const update = vi.fn(() => Promise.resolve());
    const register = vi.fn(async (h: RegistrarHooks) => fakeRegistrar(h, { update }));
    const manager = createUpdateManager({
      register,
      env: () => onlineHost,
      autoCheckDelayMs: 0,
      settleWaitMs: 100,
    });
    manager.init();
    await vi.advanceTimersByTimeAsync(5000);
    expect(register).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('fails loudly when registration.update() hangs (bounded, no stuck checking)', async () => {
    const manager = createUpdateManager({
      register: (h) =>
        Promise.resolve(fakeRegistrar(h, { update: () => new Promise<void>(() => {}) })),
      env: () => onlineHost,
      settleWaitMs: 100,
      updateTimeoutMs: 300,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    expect(manager.snapshot().phase).toBe('error');
    expect(manager.snapshot().log.join('\n')).toMatch(/timed out/);
    expect(manager.snapshot().canCheck).toBe(true);
  });

  it('reports missing registration as an error, never false up-to-date', async () => {
    const manager = createUpdateManager({
      register: (h) =>
        Promise.resolve(
          fakeRegistrar(h, {
            update: () => Promise.reject(new Error('no service worker registration')),
          }),
        ),
      env: () => onlineHost,
      settleWaitMs: 100,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    await check;
    expect(manager.snapshot().phase).toBe('error');
    expect(manager.snapshot().phase).not.toBe('up-to-date');
  });

  it('failed activation unfreezes the UI with a retry instead of sticking on applying', async () => {
    const reload = vi.fn();
    let onNeedRefresh: (() => void) | undefined;
    const manager = createUpdateManager({
      register: (h) => {
        onNeedRefresh = h.onNeedRefresh;
        return Promise.resolve({
          update: () => Promise.resolve(),
          applyUpdate: () => Promise.reject(new Error('stuck')),
        });
      },
      env: () => onlineHost,
      settleWaitMs: 100,
      reload,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    await check;
    onNeedRefresh?.();
    await manager.applyUpdate();
    expect(manager.snapshot().phase).toBe('update-available');
    expect(manager.snapshot().log.join('\n')).toMatch(/Activation failed/);
    expect(manager.snapshot().canCheck).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('apply is latched exactly-once per page load (double tap, one activation)', async () => {
    const applyUpdate = vi.fn(() => Promise.resolve());
    const reload = vi.fn();
    const manager = createUpdateManager({
      register: () => Promise.resolve({ update: () => Promise.resolve(), applyUpdate }),
      env: () => onlineHost,
      settleWaitMs: 100,
      reload,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    await check;
    await Promise.all([manager.applyUpdate(), manager.applyUpdate()]);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('offline phase stays checkable so the button itself is the retry', async () => {
    const manager = createUpdateManager({
      register: (h) => Promise.resolve(fakeRegistrar(h)),
      env: () => ({ ...onlineHost, online: false }),
      settleWaitMs: 100,
    });
    await manager.checkForUpdates(true);
    expect(manager.snapshot().phase).toBe('offline');
    expect(manager.snapshot().canCheck).toBe(true);
  });

  it('coming back online re-checks without a reload', async () => {
    let online = false;
    const update = vi.fn(() => Promise.resolve());
    const manager = createUpdateManager({
      register: (h) => Promise.resolve(fakeRegistrar(h, { update })),
      env: () => ({ ...onlineHost, online }),
      settleWaitMs: 100,
    });
    manager.init();
    expect(manager.snapshot().phase).toBe('offline');
    online = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(500);
    expect(update).toHaveBeenCalled();
  });

  it('returning to a visible tab re-checks after the resurface interval', async () => {
    const update = vi.fn(() => Promise.resolve());
    const manager = createUpdateManager({
      register: (h) => Promise.resolve(fakeRegistrar(h, { update })),
      env: () => onlineHost,
      settleWaitMs: 100,
      autoCheckDelayMs: -1,
      resurfaceIntervalMs: 1000,
    });
    manager.init();
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    await check;
    expect(update).toHaveBeenCalledTimes(1);
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    try {
      await vi.advanceTimersByTimeAsync(1500);
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
    }
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('platformNeedsFullClose: standalone, navigator.standalone, and iOS UA gate the full-close copy', () => {
    // jsdom default is a desktop browser: no full-close copy.
    expect(platformNeedsFullClose()).toBe(false);
    const restoreUA = stubUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    );
    try {
      expect(platformNeedsFullClose()).toBe(true);
    } finally {
      restoreUA();
    }
    expect(platformNeedsFullClose()).toBe(false);
    const restoreStandalone = stubStandaloneDisplay(true);
    try {
      expect(platformNeedsFullClose()).toBe(true);
    } finally {
      restoreStandalone();
    }
    expect(platformNeedsFullClose()).toBe(false);
  });

  it('post-reload worker signal on iOS names the full-close recovery (no reload loop)', async () => {
    const restoreUA = stubUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    );
    try {
      let onNeedRefresh: (() => void) | undefined;
      sessionStorage.setItem(APPLIED_FLAG, String(Date.now()));
      const manager = createUpdateManager({
        register: (h) => {
          onNeedRefresh = h.onNeedRefresh;
          return Promise.resolve(fakeRegistrar(h));
        },
        env: () => onlineHost,
        autoCheckDelayMs: -1,
        settleWaitMs: 100,
      });
      manager.init();
      expect(sessionStorage.getItem(APPLIED_FLAG)).toBeNull();
      onNeedRefresh?.();
      expect(manager.snapshot().phase).toBe('update-available');
      expect(manager.snapshot().log.join('\n')).toMatch(/fully close and reopen/);
    } finally {
      restoreUA();
    }
  });

  it('post-reload worker signal on desktop names closing other tabs (no reload loop)', async () => {
    // Desktop default (jsdom UA, no standalone): the old worker is usually
    // held by another open Folio tab, not by the OS.
    let onNeedRefresh: (() => void) | undefined;
    sessionStorage.setItem(APPLIED_FLAG, String(Date.now()));
    sessionStorage.setItem(APPLIED_FROM_FLAG, '1.9.7');
    const manager = createUpdateManager({
      register: (h) => {
        onNeedRefresh = h.onNeedRefresh;
        return Promise.resolve(fakeRegistrar(h));
      },
      env: () => onlineHost,
      autoCheckDelayMs: -1,
      settleWaitMs: 100,
      readVersion: () => '1.9.7',
    });
    manager.init();
    expect(sessionStorage.getItem(APPLIED_FLAG)).toBeNull();
    // Same version: proof stays armed, no verified-new line yet.
    expect(manager.snapshot().log.join('\n')).not.toMatch(/Updated /);
    onNeedRefresh?.();
    expect(manager.snapshot().phase).toBe('update-available');
    expect(manager.snapshot().log.join('\n')).toMatch(/close other Folio tabs/);
    expect(manager.snapshot().log.join('\n')).not.toMatch(/fully close and reopen/);
  });

  it('post-reload proof: a version change logs Updated old → new and clears the banner', async () => {
    sessionStorage.setItem(APPLIED_FLAG, String(Date.now()));
    sessionStorage.setItem(APPLIED_FROM_FLAG, '1.2.3');
    const manager = createUpdateManager({
      register: (h) => Promise.resolve(fakeRegistrar(h)),
      env: () => onlineHost,
      autoCheckDelayMs: -1,
      settleWaitMs: 100,
      readVersion: () => '1.9.7',
    });
    manager.init();
    expect(sessionStorage.getItem(APPLIED_FLAG)).toBeNull();
    expect(sessionStorage.getItem(APPLIED_FROM_FLAG)).toBeNull();
    expect(manager.snapshot().phase).toBe('idle');
    expect(manager.snapshot().updateAvailable).toBe(false);
    expect(manager.snapshot().updatedFrom).toBe('1.2.3');
    expect(manager.snapshot().log.join('\n')).toMatch(/Updated 1\.2\.3 → 1\.9\.7/);
  });

  it('post-reload proof: a build-time change verifies the update at the same version', async () => {
    sessionStorage.setItem(APPLIED_FLAG, String(Date.now()));
    sessionStorage.setItem(APPLIED_FROM_FLAG, '1.9.7');
    sessionStorage.setItem(APPLIED_BUILD_FLAG, '2026-10-04T00:00:00.000Z');
    const manager = createUpdateManager({
      register: (h) => Promise.resolve(fakeRegistrar(h)),
      env: () => onlineHost,
      autoCheckDelayMs: -1,
      settleWaitMs: 100,
      readVersion: () => '1.9.7',
      readBuildTime: () => '2026-10-05T00:00:00.000Z',
    });
    manager.init();
    expect(manager.snapshot().phase).toBe('idle');
    expect(manager.snapshot().updateAvailable).toBe(false);
    expect(manager.snapshot().log.join('\n')).toMatch(/Updated to the latest build/);
  });

  it('applyUpdate persists the running version beside the applied flag', async () => {
    const reload = vi.fn();
    const manager = createUpdateManager({
      register: () =>
        Promise.resolve({ update: () => Promise.resolve(), applyUpdate: () => Promise.resolve() }),
      env: () => onlineHost,
      settleWaitMs: 100,
      reload,
      readVersion: () => '1.9.7',
      readBuildTime: () => '2026-10-05T00:00:00.000Z',
      waitForActivation: () => Promise.resolve(),
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    await check;
    await manager.applyUpdate();
    expect(sessionStorage.getItem(APPLIED_FROM_FLAG)).toBe('1.9.7');
    expect(sessionStorage.getItem(APPLIED_BUILD_FLAG)).toBe('2026-10-05T00:00:00.000Z');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('applyUpdate gates reload on worker activation (never reloads early)', async () => {
    let releaseActivation!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const applyUpdate = vi.fn(() => Promise.resolve());
    const reload = vi.fn();
    const manager = createUpdateManager({
      register: () => Promise.resolve({ update: () => Promise.resolve(), applyUpdate }),
      env: () => onlineHost,
      settleWaitMs: 100,
      reload,
      waitForActivation: () => gate,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    await check;
    const applying = manager.applyUpdate();
    // Skip-waiting posted, but the activation gate is still held: the page
    // must stay put (an early reload would be served by the old worker).
    await vi.advanceTimersByTimeAsync(10);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(manager.snapshot().phase).toBe('applying');
    expect(reload).not.toHaveBeenCalled();
    releaseActivation();
    await applying;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('activation timeout unfreezes the UI with a retry (unlatch, no reload)', async () => {
    let onNeedRefresh: (() => void) | undefined;
    const reload = vi.fn();
    const manager = createUpdateManager({
      register: (h) => {
        onNeedRefresh = h.onNeedRefresh;
        return Promise.resolve({
          update: () => Promise.resolve(),
          applyUpdate: () => Promise.resolve(),
        });
      },
      env: () => onlineHost,
      settleWaitMs: 100,
      applyTimeoutMs: 1000,
      reload,
      // The new worker never takes control: the gate must time out loudly.
      waitForActivation: () => new Promise<void>(() => {}),
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    await check;
    onNeedRefresh?.();
    const applying = manager.applyUpdate();
    await vi.advanceTimersByTimeAsync(1500);
    await applying;
    expect(manager.snapshot().phase).toBe('update-available');
    expect(manager.snapshot().log.join('\n')).toMatch(/Activation failed/);
    expect(manager.snapshot().log.join('\n')).toMatch(/timed out/);
    expect(reload).not.toHaveBeenCalled();
    // The latch released: a retry is possible (still latched per attempt only).
    expect(manager.snapshot().canCheck).toBe(false);
  });
});
