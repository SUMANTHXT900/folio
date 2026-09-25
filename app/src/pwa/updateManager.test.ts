import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyEnv,
  createUpdateManager,
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
      'update-available',
      'up-to-date',
      'offline',
      'error',
    ] as const;
    for (const phase of phases) {
      expect(statusTextFor(phase).length).toBeGreaterThan(0);
    }
  });
});

describe('createUpdateManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

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
    const manager = createUpdateManager({
      register: () =>
        Promise.resolve({ update: () => Promise.resolve(), applyUpdate: () => applied?.() }),
      env: () => onlineHost,
      settleWaitMs: 100,
    });
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(300);
    await check;
    applied = vi.fn();
    manager.applyUpdate();
    expect(applied).toHaveBeenCalledTimes(1);
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
});
