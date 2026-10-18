import { motion } from 'framer-motion';
import { installPrompt, usePwaInstall } from '../pwa/usePwaInstall';

const ease = [0.22, 1, 0.36, 1] as const;

/**
 * Install app — the one explicit home-screen entry point (PWA installability).
 *
 * Chromium fires `beforeinstallprompt` once per session when the manifest +
 * service worker qualify; the store stashes it and this button spends it —
 * no automatic mini-bar, no surprise dialog. iOS Safari never fires that
 * event, so iOS gets honest Share → Add to Home Screen steps instead of a
 * dead button. An installed app (standalone display mode, iOS standalone,
 * or the `appinstalled` event) renders proof copy, never a button.
 */
export default function InstallCard() {
  const state = usePwaInstall();
  const busy = state.busy;

  return (
    <motion.section
      id="install-app"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease }}
      aria-label="Install app"
      className="mb-6 rounded-2xl border border-paper-300/70 dark:border-ink-700 bg-paper-50/85 dark:bg-ink-800/60 p-5 shadow-soft scroll-mt-24"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-semibold tracking-tight text-ink-900 dark:text-paper-100">
            Install app
          </h2>
          {state.installed ? (
            <p className="mt-0.5 text-sm text-ink-500 dark:text-ink-300" role="status">
              Installed — Folio opens from your home screen and works fully offline.
            </p>
          ) : state.canPrompt ? (
            <p className="mt-0.5 text-sm text-ink-500 dark:text-ink-300" role="status">
              Add Folio to your home screen for one-tap offline PDFs.
            </p>
          ) : state.platform === 'ios' ? (
            <p className="mt-0.5 text-sm text-ink-500 dark:text-ink-300" role="status">
              iPhones install from Safari, not from a button here.
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-ink-500 dark:text-ink-300" role="status">
              This browser can install Folio from its own menu.
            </p>
          )}
          {state.outcome === 'accepted' && (
            <p className="mt-1 font-mono text-xs text-ink-500 dark:text-ink-300">
              Added — look for Folio on your home screen.
            </p>
          )}
          {state.outcome === 'dismissed' && (
            <p className="mt-1 font-mono text-xs text-ink-500 dark:text-ink-300">
              Install dismissed — you can retry anytime from here.
            </p>
          )}
        </div>
        {!state.installed && state.canPrompt && (
          <button
            type="button"
            onClick={() => void installPrompt.promptInstall()}
            disabled={busy}
            className="rounded-xl bg-ink-900 dark:bg-paper-50 text-paper-50 dark:text-ink-900 px-4 py-2 min-h-[44px] text-sm font-medium shadow-sm hover:opacity-90 transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Installing…' : 'Install app'}
          </button>
        )}
      </div>
      {!state.installed && !state.canPrompt && state.platform === 'ios' && (
        <ol className="mt-3 space-y-1.5 text-sm text-ink-500 dark:text-ink-300 list-decimal list-inside">
          <li>Tap the Share button in Safari&apos;s toolbar.</li>
          <li>Tap Add to Home Screen, then Add.</li>
          <li>Open Folio from your home screen — it works fully offline.</li>
        </ol>
      )}
      {!state.installed && !state.canPrompt && state.platform !== 'ios' && (
        <p className="mt-3 text-sm text-ink-500 dark:text-ink-300">
          Open your browser menu and choose Install, Install app, or Add to Home Screen.
        </p>
      )}
    </motion.section>
  );
}
