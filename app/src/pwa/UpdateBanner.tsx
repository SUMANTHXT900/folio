import { updateManager, usePwaUpdate } from './usePwaUpdate';

/**
 * Global one-tap update prompt. Renders only while a worker update waits —
 * otherwise it renders nothing (no layout, no listeners beyond the store).
 * Floats above the mobile tool nav (`z-50`) with safe-area clearance.
 */
export default function UpdateBanner() {
  const state = usePwaUpdate();
  if (!state.updateAvailable) return null;
  return (
    <div role="alert" className="fixed inset-x-4 bottom-4 z-[70] pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex max-w-xl items-center gap-3 rounded-2xl border border-brass-400/40 bg-ink-900/95 px-4 py-3 shadow-soft backdrop-blur dark:bg-paper-100 dark:text-ink-900 text-paper-50">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">A new version is ready</span>
          <span className="block truncate text-xs opacity-70">
            Update now to continue with the latest version.
          </span>
        </span>
        <button
          type="button"
          onClick={() => updateManager.applyUpdate()}
          className="shrink-0 rounded-xl bg-brass-400 px-4 py-2 text-sm font-semibold text-ink-900 transition-opacity hover:opacity-90"
        >
          Update now
        </button>
      </div>
    </div>
  );
}
