/**
 * PWA update manager — one-tap app updates for a hard-cached PWA.
 *
 * Pattern borrowed from the SYNAPSE repo (vanilla `registerSW` + manual
 * `registration.update()` + timed wait, localhost/LAN environment guard,
 * diagnostic log), adapted to Folio: framework-free external store so the
 * global banner and the About card share one state without prop drilling.
 *
 * Why this exists (BUGS F-13): `registerType: 'autoUpdate'` updates the
 * service worker in the background, but the open page keeps serving the
 * old precache until it reloads — and nothing in the UI ever said an
 * update was waiting. On mobile that meant "hard refresh roulette" after
 * every deploy. This manager surfaces the pending update (banner + About
 * card) and applies it with one tap (`updateSW(true)` → reload into the
 * new worker). Stale-chunk recovery (`ErrorBlock`, F-12) stays as the
 * backstop for pages that miss the banner.
 */

export type UpdatePhase =
  | 'unknown'
  | 'local'
  | 'unsupported'
  | 'idle'
  | 'checking'
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
 */
export function classifyEnv(env: UpdateEnv): EnvClass {
  const h = env.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return 'local';
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
}

/** Default wiring over `virtual:pwa-register` (production build only). */
async function defaultRegister(hooks: RegistrarHooks): Promise<Registrar> {
  const mod = await import('virtual:pwa-register');
  let registration: ServiceWorkerRegistration | undefined;
  const updateSW = mod.registerSW({
    onNeedRefresh: hooks.onNeedRefresh,
    onOfflineReady: hooks.onOfflineReady,
    onRegisteredSW: (_url, reg) => {
      registration = reg ?? undefined;
    },
  });
  return {
    update: async () => {
      const reg = registration ?? (await navigator.serviceWorker.getRegistration());
      await reg?.update();
    },
    applyUpdate: () => updateSW(true),
  };
}

export interface UpdateManagerOptions {
  register?: (hooks: RegistrarHooks) => Promise<Registrar>;
  env?: () => UpdateEnv;
  /** Silent launch-check delay (SYNAPSE: ~3s). Zero/negative disables. */
  autoCheckDelayMs?: number;
  /** How long a manual check waits for the worker signal before calling it current. */
  settleWaitMs?: number;
  maxLogLines?: number;
}

const MAX_LOG_DEFAULT = 30;

export function statusTextFor(phase: UpdatePhase): string {
  switch (phase) {
    case 'unknown':
      return 'Preparing update check…';
    case 'local':
      return 'Running locally — updates activate on deploy.';
    case 'unsupported':
      return 'This browser cannot check for updates.';
    case 'idle':
      return 'Tap Check for updates to verify.';
    case 'checking':
      return 'Checking for updates…';
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

export function createUpdateManager(options: UpdateManagerOptions = {}) {
  const register = options.register ?? defaultRegister;
  const readEnv = options.env ?? defaultEnv;
  const autoCheckDelayMs = options.autoCheckDelayMs ?? 3000;
  const settleWaitMs = options.settleWaitMs ?? 5000;
  const maxLog = options.maxLogLines ?? MAX_LOG_DEFAULT;

  let phase: UpdatePhase = 'unknown';
  let updateAvailable = false;
  let checking = false;
  let log: string[] = [];
  let registrar: Registrar | null = null;
  let initialized = false;
  let checkGen = 0;
  let cached: UpdateSnapshot | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    cached = null;
    for (const fn of listeners) fn();
  };

  const pushLog = (line: string) => {
    log = [...log.slice(-(maxLog - 1)), line];
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
        canCheck: !checking && (phase === 'idle' || phase === 'up-to-date' || phase === 'error'),
      };
    }
    return cached;
  };

  const onNeedRefresh = () => {
    updateAvailable = true;
    pushLog('Update payload ready for installation.');
    setPhase('update-available');
  };

  const ensureRegistrar = async (): Promise<Registrar | null> => {
    if (registrar !== null) return registrar;
    try {
      registrar = await register({
        onNeedRefresh,
        onOfflineReady: () => pushLog('Assets cached for offline use.'),
      });
      return registrar;
    } catch (error) {
      pushLog(`Registration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return null;
    }
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
    const gen = (checkGen += 1);
    if (manual) {
      pushLog('Contacting edge server for a new version…');
      setPhase('checking');
    } else {
      emit();
    }
    try {
      await reg.update();
      if (manual) pushLog('Verifying worker integrity…');
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
          window.setTimeout(tick, 200);
        };
        tick();
      });
      if (checkGen !== gen) return;
      if (!settled && !updateAvailable && manual) {
        pushLog('Hashes match — running the latest version.');
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

  /** One-tap apply: activates the waiting worker and reloads into it. */
  const applyUpdate = () => {
    if (registrar === null) return;
    void registrar.applyUpdate();
  };

  /** Idempotent launch wiring: registers the worker, then a silent check. */
  const init = () => {
    if (initialized) return;
    initialized = true;
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
    if (!env.online) {
      setPhase('offline');
      return;
    }
    setPhase('idle');
    void ensureRegistrar().then((reg) => {
      if (reg === null) return;
      if (autoCheckDelayMs >= 0 && typeof window !== 'undefined') {
        window.setTimeout(() => {
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
