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

describe('createUpdateManager (auto-apply, no confirm)', () => {
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

  it('auto-applies the moment a waiting worker signals (manual check, no confirm step)', async () => {
    let captured: RegistrarHooks | null = null;
    const reg = { update: vi.fn(() => Promise.resolve()), applyUpdate: vi.fn() };
    const manager = createUpdateManager({
      register: (hooks) => {
        captured = hooks;
        return Promise.resolve(reg);
      },
      env: () => onlineHost,
      reload: vi.fn(),
      waitForActivation: () => Promise.resolve(),
      readVersion: () => '1.10.2',
      readBuildTime: () => '2026-10-11T00:00:00.000Z',
    });
    manager.init();
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(0);
    captured!.onNeedRefresh();
    await vi.advanceTimersByTimeAsync(500);
    await check;
    expect(reg.applyUpdate).toHaveBeenCalledTimes(1);
    expect(manager.snapshot().phase).not.toBe('update-available');
  });

  it('auto-applies from the silent launch check too', async () => {
    let captured: RegistrarHooks | null = null;
    const reg = { update: vi.fn(() => Promise.resolve()), applyUpdate: vi.fn() };
    const manager = createUpdateManager({
      register: (hooks) => {
        captured = hooks;
        return Promise.resolve(reg);
      },
      env: () => onlineHost,
      reload: vi.fn(),
      autoCheckDelayMs: 1000,
      waitForActivation: () => Promise.resolve(),
    });
    manager.init();
    await vi.advanceTimersByTimeAsync(1000);
    captured!.onNeedRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(reg.applyUpdate).toHaveBeenCalledTimes(1);
  });

  it('never reload-loops: a post-reload signal with no version change says so once (desktop)', async () => {
    sessionStorage.setItem(APPLIED_FLAG, '123');
    sessionStorage.setItem(APPLIED_FROM_FLAG, '1.10.2');
    const reload = vi.fn();
    let captured: RegistrarHooks | null = null;
    const manager = createUpdateManager({
      register: (hooks) => {
        captured = hooks;
        return Promise.resolve(fakeRegistrar(hooks));
      },
      env: () => onlineHost,
      reload,
      readVersion: () => '1.10.2',
      readBuildTime: () => '2026-10-11T00:00:00.000Z',
    });
    manager.init();
    captured!.onNeedRefresh();
    expect(reload).not.toHaveBeenCalled();
    expect(manager.snapshot().statusText).toContain('close other Folio tabs');
  });

  it('still-old copy goes full-close on installed/iOS platforms', async () => {
    const restoreUa = stubUserAgent('iPhone');
    const restoreDisplay = stubStandaloneDisplay(false);
    try {
      sessionStorage.setItem(APPLIED_FLAG, '123');
      sessionStorage.setItem(APPLIED_FROM_FLAG, '1.10.2');
      let captured: RegistrarHooks | null = null;
      const manager = createUpdateManager({
        register: (hooks) => {
          captured = hooks;
          return Promise.resolve(fakeRegistrar(hooks));
        },
        env: () => onlineHost,
        reload: vi.fn(),
        readVersion: () => '1.10.2',
        readBuildTime: () => '2026-10-11T00:00:00.000Z',
      });
      manager.init();
      captured!.onNeedRefresh();
      expect(manager.snapshot().statusText).toContain('fully close and reopen');
    } finally {
      restoreUa();
      restoreDisplay();
    }
  });

  it('manual check with no signal settles up-to-date (and stays re-checkable)', async () => {
    const manager = createUpdateManager({
      register: (hooks) => Promise.resolve(fakeRegistrar(hooks)),
      env: () => onlineHost,
      reload: vi.fn(),
      settleWaitMs: 1000,
    });
    manager.init();
    const check = manager.checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(1500);
    await check;
    expect(manager.snapshot().phase).toBe('up-to-date');
    expect(manager.snapshot().canCheck).toBe(true);
  });

  it('applyUpdate gates reload on worker activation (never reloads early)', async () => {
    let releaseActivation!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const reload = vi.fn();
    const applyUpdate = vi.fn(() => Promise.resolve());
    const manager = createUpdateManager({
      register: () => Promise.resolve({ update: () => Promise.resolve(), applyUpdate }),
      env: () => onlineHost,
      reload,
      waitForActivation: () => gate,
      readVersion: () => '1.10.2',
      readBuildTime: () => '2026-10-11T00:00:00.000Z',
    });
    manager.init();
    await vi.advanceTimersByTimeAsync(0);
    const applying = manager.applyUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.snapshot().phase).toBe('applying');
    expect(reload).not.toHaveBeenCalled();
    releaseActivation();
    await applying;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('activation timeout unlatches with a retryable error (no stuck applying)', async () => {
    const manager = createUpdateManager({
      register: () =>
        Promise.resolve({ update: () => Promise.resolve(), applyUpdate: () => Promise.resolve() }),
      env: () => onlineHost,
      reload: vi.fn(),
      waitForActivation: () => new Promise<void>(() => {}),
      applyTimeoutMs: 1000,
    });
    manager.init();
    await vi.advanceTimersByTimeAsync(0);
    const applying = manager.applyUpdate();
    await vi.advanceTimersByTimeAsync(1500);
    await applying;
    expect(manager.snapshot().phase).toBe('error');
    expect(manager.snapshot().canCheck).toBe(true);
  });

  it('applyUpdate persists the running version beside the applied flag (proof for next launch)', async () => {
    const manager = createUpdateManager({
      register: () =>
        Promise.resolve({ update: () => Promise.resolve(), applyUpdate: () => Promise.resolve() }),
      env: () => onlineHost,
      reload: vi.fn(),
      waitForActivation: () => Promise.resolve(),
      readVersion: () => '1.10.2',
      readBuildTime: () => '2026-10-11T00:00:00.000Z',
    });
    manager.init();
    await vi.advanceTimersByTimeAsync(0);
    await manager.applyUpdate();
    expect(sessionStorage.getItem(APPLIED_FLAG)).not.toBeNull();
    expect(sessionStorage.getItem(APPLIED_FROM_FLAG)).toBe('1.10.2');
    expect(sessionStorage.getItem(APPLIED_BUILD_FLAG)).toBe('2026-10-11T00:00:00.000Z');
  });

  it('post-reload version change resolves up-to-date carrying where it came from', () => {
    sessionStorage.setItem(APPLIED_FLAG, '123');
    sessionStorage.setItem(APPLIED_FROM_FLAG, '1.10.1');
    const manager = createUpdateManager({
      env: () => onlineHost,
      readVersion: () => '1.10.2',
      readBuildTime: () => '2026-10-11T00:00:00.000Z',
    });
    manager.init();
    expect(manager.snapshot().phase).toBe('up-to-date');
    expect(manager.snapshot().updatedFrom).toBe('1.10.1');
  });

  it('offline manual check says offline and stays retryable', async () => {
    const manager = createUpdateManager({
      env: () => ({ ...onlineHost, online: false }),
    });
    manager.init();
    await manager.checkForUpdates(true);
    expect(manager.snapshot().phase).toBe('offline');
    expect(manager.snapshot().canCheck).toBe(true);
  });

  it('local manual check keeps the preview-build copy', async () => {
    const manager = createUpdateManager({
      env: () => ({ ...onlineHost, hostname: 'localhost' }),
    });
    manager.init();
    await manager.checkForUpdates(true);
    expect(manager.snapshot().phase).toBe('local');
    expect(manager.snapshot().statusText).toBe(
      'Preview build — update checks run on the deployed site.',
    );
  });

  it('platformNeedsFullClose is false on plain desktop', () => {
    const restoreDisplay = stubStandaloneDisplay(false);
    const restoreUa = stubUserAgent('Windows Chrome');
    try {
      expect(platformNeedsFullClose()).toBe(false);
    } finally {
      restoreDisplay();
      restoreUa();
    }
  });
});
