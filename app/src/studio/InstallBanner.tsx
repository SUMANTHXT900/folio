import { installPrompt, usePwaInstall } from '../pwa/usePwaInstall';

/**
 * Install banner — the phone install entry point. Renders only when the app
 * is NOT installed, the banner was NOT dismissed, and there is an honest
 * path forward: a stashed `beforeinstallprompt` (Chromium phones/desktops)
 * or iOS (Share → Add to Home Screen steps live in About). iOS links to
 * About instead of a dead button; Chromium spends the stashed prompt.
 * Dismissal persists in localStorage.
 */
export default function InstallBanner() {
  const state = usePwaInstall();
  if (state.installed || state.dismissed) return null;
  if (!state.canPrompt && state.platform !== 'ios') return null;

  return (
    <div
      role="region"
      aria-label="Install Folio"
      className="mb-4 flex items-center gap-3 rounded-2xl border border-brass-400/30 bg-brass-400/[0.08] px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-sm font-medium text-ink-900 dark:text-paper-100">
        Install Folio for one-tap offline PDFs.
      </p>
      {state.canPrompt ? (
        <button
          type="button"
          onClick={() => void installPrompt.promptInstall()}
          disabled={state.busy}
          className="shrink-0 rounded-xl bg-ink-900 dark:bg-paper-50 text-paper-50 dark:text-ink-900 px-4 min-h-[44px] text-sm font-medium shadow-sm hover:opacity-90 transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.busy ? 'Installing…' : 'Install'}
        </button>
      ) : (
        <a
          href="#/about"
          className="shrink-0 rounded-xl bg-ink-900 dark:bg-paper-50 text-paper-50 dark:text-ink-900 px-4 min-h-[44px] inline-flex items-center text-sm font-medium shadow-sm hover:opacity-90 transition-opacity"
        >
          How to install
        </a>
      )}
      <button
        type="button"
        aria-label="Dismiss install suggestion"
        onClick={() => installPrompt.dismiss()}
        className="shrink-0 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-lg leading-none text-ink-500 dark:text-ink-300 hover:opacity-70"
      >
        <span aria-hidden>✕</span>
      </button>
    </div>
  );
}
