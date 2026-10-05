/**
 * PWA update manager — one-tap app updates for a hard-cached PWA.
 *
 * Pattern borrowed from the SYNAPSE repo (vanilla `registerSW` + manual
 * `registration.update()` + timed wait, localhost/LAN environment guard,
 * diagnostic log), adapted to Folio: framework-free external store so the
 * global banner and the About card share one state without prop drilling.
 *
 * Why this exists (BUGS F-13): with no update UI, users sat on the stale
 * precache after every deploy. The manager surfaces the pending update
 * (banner + About card) and applies it with one tap. Stale-chunk recovery
 * (`ErrorBlock`, F-12) stays as the backstop for pages that miss the banner.
 *
 * Hard requirement, verified against the installed `vite-plugin-pwa`
 * client: this manager assumes `registerType: 'prompt'` semantics. Under
 * `'autoUpdate'` the client never calls `onNeedRefresh` (it activates in
 * the background and force-reloads, and `updateSW(true)` is a skip-waiting
 * no-op) — the whole UI below would go dead. See `vite.config.ts`.
 */

export type UpdatePhase =
  | 'unknown'
  | 'local'
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'applying'
  | 'update-available'
  | 'up-to-date'
  | 'offline'
  | 'error';

export interface UpdateSnapshot {
  phase: UpdatePhase;
  /** True once the worker signals a waiting update — drives the banner. */
  updateAvailable: boolean;
  checking: boolean;
  statusText: string;
  /** Newest-last diagnostic lines (capped), rendered in About. */
  log: string[];
  canCheck: boolean;
}

export interface UpdateEnv {
  hostname: string;
  secureContext: boolean;
  online: boolean;
  swSupported: boolean;
}

export type EnvClass = 'local' | 'unsupported' | 'ok';

/**
 * Classifies the runtime for OTA updates (SYNAPSE logic, trimmed):
 * localhost and insecure LAN origins can never receive a worker update,
 * and some browsers/contexts have no Service Worker at all.
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
  maxLogLines?: number;
}

const MAX_LOG_DEFAULT = 30;
const UPDATE_TIMEOUT_DEFAULT_MS = 15000;
const APPLY_TIMEOUT_DEFAULT_MS = 8000;
const RESURFACE_DEFAULT_MS = 60 * 60 * 1000;
/** sessionStorage flag: set before the apply-reload, read on next launch. Exported for tests. */
export const APPLIED_FLAG = 'folio-update-applied-at';

export function statusTextFor(phase: UpdatePhase): string {
  switch (phase) {
    case 'unknown':
      return 'Preparing update check…';
    case 'local':
      return 'Preview build — update checks run on the deployed site.';
    case 'unsupported':
      return 'This browser cannot check for updates.';
    case 'idle':
      return 'Tap Check for updates to verify.';
    case 'checking':
      return 'Checking for updates…';
    case 'applying':
      return 'Installing update… Reloading.';
    case 'update-available':
      return 'A new version is ready.';
    case 'up-to-date':
      return 'Folio is up to date.';
    case 'offline':
      return 'You are offline — connect to check.';
    case 'error':
      return 'Update check failed — try again.';
  }
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
  const maxLog = options.maxLogLines ?? MAX_LOG_DEFAULT;

  let phase: UpdatePhase = 'unknown';
  let updateAvailable = false;
  let checking = false;
  let log: string[] = [];
  let registrar: Registrar | null = null;
  let initialized = false;
  let listenersAttached = false;
  let checkGen = 0;
  let lastCheckAt = 0;
  let applyLatched = false;
  /** True when this launch follows our own apply-reload (iOS may still serve the old worker). */
  let justReloadedForUpdate = false;
  let cached: UpdateSnapshot | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    cached = null;
    for (const fn of listeners) fn();
  };

  const pushLog = (line: string) => {
    // Every line carries the local wall-clock time it was pushed, so the
    // About details read as a real event log — because they are one.
    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':');
    log = [...log.slice(-(maxLog - 1)), `${ts} ${line}`];
  };

  const setPhase = (next: UpdatePhase) => {
    phase = next;
    emit();
  };

  const snapshot = (): UpdateSnapshot => {
    // Cached: useSyncExternalStore requires a stable reference between
    // emissions, or React loops forever. Invalidated on every emit().
    if (cached === null) {
      cached = {
        phase,
        updateAvailable,
        checking,
        statusText: statusTextFor(phase),
        log,
        // 'offline' stays checkable: it is the retry button once back online.
        // 'applying' stays locked (the apply path is latched, exactly-once).
        canCheck:
          !checking &&
          (phase === 'idle' || phase === 'up-to-date' || phase === 'error' || phase === 'offline'),
      };
    }
    return cached;
  };

  const onNeedRefresh = () => {
    updateAvailable = true;
    pushLog('Service worker reported a waiting update.');
    if (justReloadedForUpdate) {
      // The apply-reload happened but the old worker is still in charge —
      // the iOS standalone signature (worker updates only stick after the
      // app is fully closed). Say so plainly instead of looping reloads.
      pushLog('Still on the old version after reload — fully close and reopen the app to finish.');
      justReloadedForUpdate = false;
    }
    setPhase('update-available');
  };

  const ensureRegistrar = async (): Promise<Registrar | null> => {
    if (registrar !== null) return registrar;
    try {
      registrar = await register({
        onNeedRefresh,
        onOfflineReady: () => {
          pushLog('Assets cached for offline use.');
          emit();
        },
        onRegisterError: (error) => {
          pushLog(
            `Worker registration error: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
          emit();
        },
      });
      return registrar;
    } catch (error) {
      pushLog(`Registration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      emit();
      return null;
    }
  };

  /** Retire an in-flight check (offline mid-check): unblocks the UI without lying about the result. */
  const retireCheck = (gen: number, reason: string) => {
    if (checkGen !== gen) return;
    checkGen += 1;
    checking = false;
    pushLog(reason);
    setPhase('offline');
  };

  /** Silent or manual check. Manual runs always log; silent runs stay quiet unless an update is found. */
  const checkForUpdates = async (manual = false): Promise<void> => {
    if (checking) return;
    const env = readEnv();
    if (!env.online) {
      if (manual) {
        pushLog('No network connection detected.');
        setPhase('offline');
      }
      return;
    }
    if (classifyEnv(env) === 'local') {
      if (manual) {
        pushLog('Local origin detected — OTA updates disabled here.');
        setPhase('local');
      }
      return;
    }
    if (classifyEnv(env) === 'unsupported') {
      if (manual) {
        pushLog('Service Workers are not supported or are blocked.');
        setPhase('unsupported');
      }
      return;
    }
    const reg = await ensureRegistrar();
    if (reg === null) {
      if (manual) setPhase('error');
      return;
    }
    checking = true;
    lastCheckAt = Date.now();
    const gen = (checkGen += 1);
    // Literal truth for the settle window label (e.g. 5000ms → "5s").
    const secsValue = settleWaitMs / 1000;
    const secsLabel = Number.isInteger(secsValue) ? `${secsValue}s` : `${secsValue.toFixed(1)}s`;
    if (manual) {
      pushLog('Re-fetching sw.js from this host to check for a new version…');
      setPhase('checking');
    } else {
      emit();
    }
    try {
      // Bounded: a stalled update() must fail loudly, never hang the UI in
      // 'checking' with a dead button (previous behavior had no timeout —
      // the settle window only started after update() resolved).
      await withTimeout(reg.update(), updateTimeoutMs, 'Re-fetching sw.js');
      if (manual) pushLog(`Waiting ${secsLabel} for the worker to answer…`);
      // The worker signals via onNeedRefresh; if nothing arrives within
      // the settle window the running version is current (SYNAPSE wait).
      const settled = await new Promise<boolean>((resolve) => {
        const started = Date.now();
        const tick = () => {
          if (checkGen !== gen) {
            resolve(false);
            return;
          }
          if (updateAvailable) {
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
      if (!settled && !updateAvailable && manual) {
        pushLog(`No new version answered within ${secsLabel} — still on the current version.`);
        setPhase('up-to-date');
      }
    } catch (error) {
      if (checkGen !== gen) return;
      if (manual) {
        pushLog(`Connection failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        setPhase('error');
      }
    } finally {
      if (checkGen === gen) {
        checking = false;
        emit();
      }
    }
  };

  /**
   * One-tap apply: activates the waiting worker and reloads into it.
   * Latched exactly-once per page load; a failed activation unfreezes the
   * UI back to the waiting version with a retry instead of sticking on
   * 'applying' forever (the previous `void applyUpdate()` had no error
   * path at all — and under autoUpdate it was a silent no-op).
   */
  const applyUpdate = async (): Promise<void> => {
    const active = registrar;
    if (active === null || applyLatched || phase === 'applying') return;
    applyLatched = true;
    // Visible phase first: the reload lands a moment later, so this status
    // shows only briefly — but the tap must acknowledge before the reload.
    pushLog('Activating the waiting worker and reloading…');
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
      try {
        sessionStorage.setItem(APPLIED_FLAG, String(Date.now()));
      } catch {
        // Private mode / blocked storage: the iOS resume hint is skipped,
        // the update itself still proceeds.
      }
      reloadFn();
    } catch (error) {
      applyLatched = false;
      pushLog(
        `Activation failed (${error instanceof Error ? error.message : 'unknown error'}) — still on the waiting version. Retry, or reload manually.`,
      );
      // Back to the waiting version when one is known; plain error when the
      // apply was somehow tapped with no signalled update (banner keys on
      // the flag, so only the matching phase can unfreeze its UI).
      setPhase(updateAvailable ? 'update-available' : 'error');
    }
  };

  /** Foreground resurface: long-lived/mobile tabs re-check when visible again. */
  const attachResurfaceListeners = () => {
    if (listenersAttached) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    listenersAttached = true;
    window.addEventListener('online', () => {
      if (phase === 'offline') {
        pushLog('Back online — re-checking for updates.');
        setPhase('idle');
        void checkForUpdates(false);
      }
    });
    window.addEventListener('offline', () => {
      if (checking) retireCheck(checkGen, 'Connection lost mid-check — tap Check to retry.');
    });
    const resurface = () => {
      if (document.visibilityState !== 'visible') return;
      if (checking || updateAvailable) return;
      if (Date.now() - lastCheckAt < resurfaceIntervalMs) return;
      if (phase !== 'idle' && phase !== 'up-to-date') return;
      void checkForUpdates(false);
    };
    document.addEventListener('visibilitychange', resurface);
    // pageshow covers bfcache restores, where visibilitychange may not fire.
    window.addEventListener('pageshow', resurface);
  };

  /** Idempotent launch wiring: registers the worker, then a silent check. */
  const init = () => {
    if (initialized) return;
    initialized = true;
    try {
      if (sessionStorage.getItem(APPLIED_FLAG) !== null) {
        sessionStorage.removeItem(APPLIED_FLAG);
        justReloadedForUpdate = true;
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
    setPhase('idle');
    void ensureRegistrar().then((reg) => {
      if (reg === null) return;
      // Zero/negative disables the silent launch check (matches the option
      // comment; the old `>= 0` scheduled a 0ms check for zero).
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

/** App singleton — shared by the banner and the About card. */
export const updateManager = createUpdateManager();
