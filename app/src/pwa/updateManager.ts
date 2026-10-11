/**
 * PWA update manager — deliberately simple app updates.
 *
 * One Update button (About) plus an automatic check on every launch:
 * check → if a waiting worker is found, activate it and hard-reload
 * straight into it. No popups, no banners, no confirm step, no review
 * queue. The reload is gated on activation (`controllerchange`, bounded)
 * so the navigation lands on the new worker, never the old one.
 *
 * Hard requirement, verified against the installed `vite-plugin-pwa`
 * client: this manager assumes `registerType: 'prompt'` semantics. Under
 * `'autoUpdate'` the client never calls `onNeedRefresh` (it activates in
 * the background and force-reloads, and `updateSW(true)` is a skip-waiting
 * no-op) — the check below would go dead. See `vite.config.ts`.
 */

export type UpdatePhase =
  | 'unknown'
  | 'local'
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'applying'
  | 'up-to-date'
  | 'offline'
  | 'error';

export interface UpdateSnapshot {
  phase: UpdatePhase;
  checking: boolean;
  statusText: string;
  canCheck: boolean;
  /**
   * Pre-apply running version persisted at apply, consumed on next init.
   * Optional so older snapshots stay assignable; always populated by the
   * current manager (null when the version was never known).
   */
  updatedFrom?: string | null;
}

export interface UpdateEnv {
  hostname: string;
  secureContext: boolean;
  online: boolean;
  swSupported: boolean;
}

export type EnvClass = 'local' | 'unsupported' | 'ok';

/**
 * Classifies the runtime for OTA updates: localhost and insecure LAN
 * origins can never receive a worker update, and some
 * browsers/contexts have no Service Worker at all.
 *
 * Note: `location.hostname` strips IPv6 brackets, so the loopback check
 * is `'::1'`, never `'[::1]'`. Empty hostname covers `file://`.
 */
export function classifyEnv(env: UpdateEnv): EnvClass {
  // Brackets stripped defensively: location.hostname never yields them,
  // but callers/tests may pass the '[::1]' literal.
  const h = env.hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (
    h === '' ||
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0'
  )
    return 'local';
  const lan =
    h.startsWith('192.168.') ||
    h.startsWith('10.') ||
    h.endsWith('.local') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (lan && !env.secureContext) return 'local';
  if (!env.swSupported) return 'unsupported';
  return 'ok';
}

export function defaultEnv(): UpdateEnv {
  if (typeof window === 'undefined') {
    return { hostname: '', secureContext: false, online: false, swSupported: false };
  }
  return {
    hostname: window.location.hostname,
    secureContext: window.isSecureContext,
    online: navigator.onLine,
    swSupported: 'serviceWorker' in navigator,
  };
}

export interface Registrar {
  update: () => Promise<void>;
  applyUpdate: () => void | Promise<void>;
}

export interface RegistrarHooks {
  onNeedRefresh: () => void;
  onOfflineReady: () => void;
  onRegisterError: (error: unknown) => void;
}

/** Default wiring over `virtual:pwa-register` (production build only). */
async function defaultRegister(hooks: RegistrarHooks): Promise<Registrar> {
  const mod = await import('virtual:pwa-register');
  let registration: ServiceWorkerRegistration | undefined;
  const updateSW = mod.registerSW({
    onNeedRefresh: hooks.onNeedRefresh,
    onOfflineReady: hooks.onOfflineReady,
    onRegisterError: hooks.onRegisterError,
    onRegisteredSW: (_url, reg) => {
      registration = reg ?? undefined;
    },
  });
  return {
    update: async () => {
      const reg = registration ?? (await navigator.serviceWorker.getRegistration());
      if (!reg) throw new Error('no service worker registration (worker blocked or unsupported)');
      await reg.update();
    },
    // Prompt mode: skip-waiting + reload. (Under autoUpdate this is a no-op —
    // hence the prompt requirement documented at the top of this file.)
    applyUpdate: () => updateSW(true),
  };
}

export interface UpdateManagerOptions {
  register?: (hooks: RegistrarHooks) => Promise<Registrar>;
  env?: () => UpdateEnv;
  /** Page reload used after activation. Injectable so tests never navigate. */
  reload?: () => void;
  /**
   * Waits until the new worker controls the page after skip-waiting.
   * Default: one `navigator.serviceWorker` `controllerchange` (exactly-once,
   * resolves at once where no Service Worker container exists, e.g. tests).
   * Injectable so tests can hold or release the activation gate on demand.
   */
  waitForActivation?: () => Promise<void>;
  /** Running version reader. Default: the `__FOLIO_VERSION__` Vite define. Injectable for tests. */
  readVersion?: () => string | null;
  /** Running build-time reader. Default: the `__FOLIO_BUILD_TIME__` Vite define. Injectable for tests. */
  readBuildTime?: () => string | null;
  /** Silent launch-check delay. Zero/negative disables. */
  autoCheckDelayMs?: number;
  /** How long a manual check waits for the worker signal before calling it current. */
  settleWaitMs?: number;
  /** Upper bound on `registration.update()` before the check fails loudly. */
  updateTimeoutMs?: number;
  /** Upper bound on worker activation before the UI unfreezes with a retry. */
  applyTimeoutMs?: number;
  /** Re-check at most this often when the app returns to the foreground. */
  resurfaceIntervalMs?: number;
}

const UPDATE_TIMEOUT_DEFAULT_MS = 15000;
const APPLY_TIMEOUT_DEFAULT_MS = 8000;
const RESURFACE_DEFAULT_MS = 60 * 60 * 1000;
/** sessionStorage flag: set before the apply-reload, read on next launch. Exported for tests. */
export const APPLIED_FLAG = 'folio-update-applied-at';
/** sessionStorage slot beside APPLIED_FLAG: the running version at apply time. Exported for tests. */
export const APPLIED_FROM_FLAG = 'folio-update-applied-from';
/** sessionStorage slot beside APPLIED_FLAG: the running build time at apply time. Exported for tests. */
export const APPLIED_BUILD_FLAG = 'folio-update-applied-build';

export function statusTextFor(phase: UpdatePhase): string {
  switch (phase) {
    case 'unknown':
      return 'Preparing update check…';
    case 'local':
      return 'Preview build — update checks run on the deployed site.';
    case 'unsupported':
      return 'This browser cannot check for updates.';
    case 'idle':
      return 'Tap Update to check for the latest version.';
    case 'checking':
      return 'Checking for updates…';
    case 'applying':
      return 'Updating… reloading now.';
    case 'up-to-date':
      return 'Folio is up to date.';
    case 'offline':
      return 'You are offline — reconnect and tap Update.';
    case 'error':
      return 'Update check failed — tap Update to retry.';
  }
}

/** Running version from the Vite define. Null when unavailable (e.g. unit tests with no define). */
function readVersionDefine(): string | null {
  try {
    return typeof __FOLIO_VERSION__ !== 'undefined' ? __FOLIO_VERSION__ : null;
  } catch {
    return null;
  }
}

/** Running build time from the Vite define. Null when unavailable (e.g. unit tests with no define). */
function readBuildTimeDefine(): string | null {
  try {
    return typeof __FOLIO_BUILD_TIME__ !== 'undefined' ? __FOLIO_BUILD_TIME__ : null;
  } catch {
    return null;
  }
}

/**
 * True when a worker update only sticks after the app is fully closed:
 * installed (standalone display-mode), legacy iOS standalone, or any iOS
 * user agent. Otherwise the old worker is usually held by another open
 * Folio tab, and closing those tabs is enough. Exported for tests.
 */
export function platformNeedsFullClose(): boolean {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch {
      // Probe failed: fall through to the remaining signals.
    }
  }
  if (typeof navigator !== 'undefined') {
    if ((navigator as Navigator & { standalone?: unknown }).standalone === true) return true;
    if (typeof navigator.userAgent === 'string' && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves once the newly activated worker controls this page
 * (exactly-once `controllerchange`, per page load). Resolves at once where
 * no Service Worker container exists. A skip-waiting post that already
 * handed over control before this listener attaches also resolves at once
 * instead of waiting for a change that already happened.
 */
function defaultWaitForActivation(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve();
  }
  const container = navigator.serviceWorker;
  return new Promise<void>((resolve) => {
    container.addEventListener('controllerchange', () => resolve(), { once: true });
  });
}

/** Rejects if `work` takes longer than `ms`. Timer via globalThis: works in workers/tests, not just windows. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let id: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    id = globalThis.setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => {
    if (id !== undefined) globalThis.clearTimeout(id);
  });
}

export function createUpdateManager(options: UpdateManagerOptions = {}) {
  const register = options.register ?? defaultRegister;
  const readEnv = options.env ?? defaultEnv;
  const reloadFn =
    options.reload ??
    (() => {
      window.location.reload();
    });
  const autoCheckDelayMs = options.autoCheckDelayMs ?? 3000;
  const settleWaitMs = options.settleWaitMs ?? 5000;
  const updateTimeoutMs = options.updateTimeoutMs ?? UPDATE_TIMEOUT_DEFAULT_MS;
  const applyTimeoutMs = options.applyTimeoutMs ?? APPLY_TIMEOUT_DEFAULT_MS;
  const resurfaceIntervalMs = options.resurfaceIntervalMs ?? RESURFACE_DEFAULT_MS;
  const waitForActivation = options.waitForActivation ?? defaultWaitForActivation;
  const readVersion = options.readVersion ?? readVersionDefine;
  const readBuildTime = options.readBuildTime ?? readBuildTimeDefine;

  let phase: UpdatePhase = 'unknown';
  let checking = false;
  /** One-shot status override (e.g. the still-old note) — cleared on the next check. */
  let attention: string | null = null;
  let registrar: Registrar | null = null;
  let initialized = false;
  let listenersAttached = false;
  let checkGen = 0;
  let lastCheckAt = 0;
  let applyLatched = false;
  /** True when this launch follows our own apply-reload but the version proof did not verify the new build. */
  let justReloadedForUpdate = false;
  /** The version this launch reloaded from (arms the no-loop guard above). */
  let justReloadedFrom: string | null = null;
  /** Pre-apply running version consumed at init; drives the Updated vX → vY proof. */
  let updatedFrom: string | null = null;
  /** Exactly-once reload per page load: the manager's timed path contributes one navigation. */
  let reloadFired = false;
  let cached: UpdateSnapshot | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    cached = null;
    for (const fn of listeners) fn();
  };

  const setPhase = (next: UpdatePhase) => {
    phase = next;
    emit();
  };

  /** Reload exactly once: a throwing reload leaves the latch clear so a retry can still fire. */
  const fireReloadOnce = () => {
    if (reloadFired) return;
    reloadFn();
    reloadFired = true;
  };

  const snapshot = (): UpdateSnapshot => {
    // Cached: useSyncExternalStore requires a stable reference between
    // emissions, or React loops forever. Invalidated on every emit().
    if (cached === null) {
      cached = {
        phase,
        checking,
        statusText: attention ?? statusTextFor(phase),
        // 'applying' stays locked (the apply path is latched, exactly-once).
        canCheck:
          !checking &&
          (phase === 'idle' || phase === 'up-to-date' || phase === 'error' || phase === 'offline'),
        updatedFrom,
      };
    }
    return cached;
  };

  /**
   * A waiting worker was signalled — apply it straight away, no confirm.
   * The single exception is the post-reload still-old case: the apply just
   * ran yet the old worker is still in charge, so reloading again would
   * loop forever. Say so once instead, with the platform-correct remedy.
   */
  const onNeedRefresh = () => {
    if (justReloadedForUpdate) {
      justReloadedForUpdate = false;
      const nowVersion = readVersion();
      if (justReloadedFrom === null || nowVersion === null || nowVersion === justReloadedFrom) {
        attention = platformNeedsFullClose()
          ? 'Still on the old version after reload — fully close and reopen the app to finish.'
          : 'Still on the old version after reload — close other Folio tabs, then tap Update.';
        setPhase('up-to-date');
        return;
      }
      justReloadedFrom = null;
    }
    void applyUpdate();
  };

  const ensureRegistrar = async (): Promise<Registrar | null> => {
    if (registrar !== null) return registrar;
    try {
      registrar = await register({
        onNeedRefresh,
        onOfflineReady: () => {
          emit();
        },
        onRegisterError: () => {
          emit();
        },
      });
      return registrar;
    } catch {
      emit();
      return null;
    }
  };

  /** Retire an in-flight check (offline mid-check): unblocks the UI without lying about the result. */
  const retireCheck = (gen: number) => {
    if (checkGen !== gen) return;
    checkGen += 1;
    checking = false;
    setPhase('offline');
  };

  /** Check for an update; when one answers, it is applied immediately (no confirm step). */
  const checkForUpdates = async (manual = false): Promise<void> => {
    if (checking) return;
    const env = readEnv();
    if (!env.online) {
      if (manual) setPhase('offline');
      return;
    }
    if (classifyEnv(env) === 'local') {
      if (manual) setPhase('local');
      return;
    }
    if (classifyEnv(env) === 'unsupported') {
      if (manual) setPhase('unsupported');
      return;
    }
    const reg = await ensureRegistrar();
    if (reg === null) {
      if (manual) setPhase('error');
      return;
    }
    checking = true;
    attention = null;
    lastCheckAt = Date.now();
    const gen = (checkGen += 1);
    if (manual) setPhase('checking');
    else emit();
    try {
      // Bounded: a stalled update() must fail loudly, never hang the UI in
      // 'checking' with a dead button.
      await withTimeout(reg.update(), updateTimeoutMs, 'Re-fetching sw.js');
      // The worker signals via onNeedRefresh (which auto-applies); if
      // nothing arrives within the settle window the running build is
      // current.
      const settled = await new Promise<boolean>((resolve) => {
        const started = Date.now();
        const tick = () => {
          if (checkGen !== gen) {
            resolve(false);
            return;
          }
          if (applyLatched || phase === 'applying') {
            resolve(true);
            return;
          }
          if (Date.now() - started >= settleWaitMs) {
            resolve(false);
            return;
          }
          globalThis.setTimeout(tick, 200);
        };
        tick();
      });
      if (checkGen !== gen) return;
      if (!settled && manual) setPhase('up-to-date');
    } catch {
      if (checkGen !== gen) return;
      if (manual) setPhase('error');
    } finally {
      if (checkGen === gen) {
        checking = false;
        emit();
      }
    }
  };

  /**
   * Activate the waiting worker, wait until it controls this page, then
   * reload into it exactly once. Latched exactly-once per page load; a
   * failed activation unfreezes the UI with a retry instead of sticking
   * on 'applying' forever.
   */
  const applyUpdate = async (): Promise<void> => {
    const active = registrar;
    if (active === null || applyLatched || phase === 'applying') return;
    applyLatched = true;
    // Visible phase first: the reload lands a moment later, so this status
    // shows only briefly — but the run must acknowledge before the reload.
    setPhase('applying');
    try {
      // Invoked synchronously (not deferred): a throwing registrar fails
      // fast into the retry path below instead of an unhandled rejection.
      const activation = active.applyUpdate();
      await withTimeout(
        Promise.resolve(activation),
        applyTimeoutMs,
        'Activating the waiting worker',
      );
      // Gate the reload on activation: the new worker must control this
      // page before we navigate, or the early navigation is served by the
      // still-active OLD worker ("reloaded but old"). Bounded by the same
      // apply timeout; a timeout unlatches into the retry path below.
      // Single timed path: the plugin client also reloads on its own
      // controlling event, but both calls land in the same task and commit
      // as one navigation, while this latch guarantees the manager
      // contributes exactly one reload.
      await withTimeout(
        waitForActivation(),
        applyTimeoutMs,
        'Waiting for the new worker to take control',
      );
      try {
        sessionStorage.setItem(APPLIED_FLAG, String(Date.now()));
        const fromVersion = readVersion();
        if (fromVersion !== null) sessionStorage.setItem(APPLIED_FROM_FLAG, fromVersion);
        const fromBuild = readBuildTime();
        if (fromBuild !== null) sessionStorage.setItem(APPLIED_BUILD_FLAG, fromBuild);
      } catch {
        // Private mode / blocked storage: the resume hint is skipped,
        // the update itself still proceeds.
      }
      fireReloadOnce();
    } catch {
      applyLatched = false;
      // Back to a re-checkable phase; the status copy says to retry.
      setPhase('error');
    }
  };

  /** Foreground resurface: long-lived/mobile tabs re-check when visible again. */
  const attachResurfaceListeners = () => {
    if (listenersAttached) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    listenersAttached = true;
    window.addEventListener('online', () => {
      if (phase === 'offline') {
        setPhase('idle');
        void checkForUpdates(false);
      }
    });
    window.addEventListener('offline', () => {
      if (checking) retireCheck(checkGen);
    });
    const resurface = () => {
      if (document.visibilityState !== 'visible') return;
      if (checking || phase === 'applying') return;
      if (Date.now() - lastCheckAt < resurfaceIntervalMs) return;
      if (phase !== 'idle' && phase !== 'up-to-date') return;
      void checkForUpdates(false);
    };
    document.addEventListener('visibilitychange', resurface);
    // pageshow covers bfcache restores, where visibilitychange may not fire.
    window.addEventListener('pageshow', resurface);
  };

  /** Idempotent launch wiring: registers the worker, then a silent check that auto-applies. */
  const init = () => {
    if (initialized) return;
    initialized = true;
    // Post-reload proof: did the reload actually land the new build? A
    // version (or build-time) change verifies the update and resolves the
    // launch as up-to-date below. Anything else stays armed: a later
    // worker signal means the old worker is still in charge (the
    // still-old note, shown once, never a loop).
    let proofVerified = false;
    try {
      if (sessionStorage.getItem(APPLIED_FLAG) !== null) {
        sessionStorage.removeItem(APPLIED_FLAG);
        const fromVersion = sessionStorage.getItem(APPLIED_FROM_FLAG);
        sessionStorage.removeItem(APPLIED_FROM_FLAG);
        const fromBuild = sessionStorage.getItem(APPLIED_BUILD_FLAG);
        sessionStorage.removeItem(APPLIED_BUILD_FLAG);
        updatedFrom = fromVersion;
        const nowVersion = readVersion();
        const nowBuild = readBuildTime();
        if (
          (fromVersion !== null && nowVersion !== null && fromVersion !== nowVersion) ||
          (fromBuild !== null && nowBuild !== null && fromBuild !== nowBuild)
        ) {
          justReloadedForUpdate = false;
          justReloadedFrom = null;
          proofVerified = true;
        } else {
          justReloadedForUpdate = true;
          justReloadedFrom = fromVersion;
        }
      }
    } catch {
      // Blocked storage: skip the resume hint, nothing else changes.
    }
    const env = readEnv();
    const cls = classifyEnv(env);
    if (cls === 'local') {
      setPhase('local');
      return;
    }
    if (cls === 'unsupported') {
      setPhase('unsupported');
      return;
    }
    attachResurfaceListeners();
    if (!env.online) {
      setPhase('offline');
      return;
    }
    setPhase(proofVerified ? 'up-to-date' : 'idle');
    void ensureRegistrar().then((reg) => {
      if (reg === null) return;
      // Zero/negative disables the silent launch check.
      if (autoCheckDelayMs > 0 && typeof globalThis.setTimeout !== 'undefined') {
        globalThis.setTimeout(() => {
          void checkForUpdates(false);
        }, autoCheckDelayMs);
      }
    });
  };

  return {
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    snapshot,
    init,
    checkForUpdates,
    applyUpdate,
    /** Test escape hatch: retire timers from a superseded check. */
    __bumpGen: () => {
      checkGen += 1;
    },
  };
}

export type UpdateManager = ReturnType<typeof createUpdateManager>;

/** App singleton — the About card reads it; every launch auto-checks through it. */
export const updateManager = createUpdateManager();
