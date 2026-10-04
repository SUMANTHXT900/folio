import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { usePwaUpdate } from './usePwaUpdate';

/**
 * Global update prompt. Renders only while a worker update waits —
 * otherwise it renders nothing (no layout, no listeners beyond the store).
 * Floats above the mobile tool nav (`z-50`) with safe-area clearance.
 *
 * The whole banner links to the About updates card, where the waiting
 * version is reviewed and applied with one tap. The banner itself never
 * applies or reloads — so while a StudioJob or an image import is
 * active it defers (copy says to finish the current task first) instead
 * of pushing the user toward a reload mid-task.
 */
export default function UpdateBanner() {
  const state = usePwaUpdate();
  const [dismissed, setDismissed] = useState(false);
  const busy = useBusyGuard();
  const applying = state.phase === 'applying';
  // Enter/exit is an opacity-only fade (180ms): the banner conditionally
  // mounts, so AnimatePresence plays both directions. Dismiss sets state
  // directly — unmount never waits on JS. No slide: banner motion stays
  // out of the theatrics bin.
  return (
    <AnimatePresence>
      {state.updateAvailable && !dismissed && (
        <motion.div
          role="alert"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="fixed inset-x-4 bottom-4 z-[70] pb-[env(safe-area-inset-bottom)]"
        >
          <div className="mx-auto flex max-w-xl items-center gap-2 rounded-2xl border border-brass-400/40 bg-ink-900/95 px-4 py-3 shadow-soft backdrop-blur dark:bg-paper-100 dark:text-ink-900 text-paper-50">
            <a
              href="#/about"
              className="flex min-w-0 flex-1 items-center gap-3"
              aria-label={busy ? 'Update ready — review after your current task' : undefined}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">A new version is ready</span>
                <span className="block truncate text-xs opacity-70">
                  {applying
                    ? 'Installing update… Reloading.'
                    : busy
                      ? 'Finish your current task first, then review.'
                      : 'Tap to review and update.'}
                </span>
              </span>
              <span
                aria-hidden
                className="shrink-0 rounded-xl bg-brass-400 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                {applying ? 'Installing…' : 'Review update'}
              </span>
            </a>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss update notice"
              className="shrink-0 rounded-full px-3 py-1 text-sm opacity-70 transition-opacity hover:opacity-100 hover:bg-white/10"
            >
              ✕
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Busy guard for deferred updates. There is no global StudioJob registry
 * (job handles stay tool-local by design), so this observes the
 * native-picker import progress marker in the DOM. The scanner-root
 * marker (camera live / review open) was removed with the D33 scanner
 * strip; the scanic integration wave re-arms a scanner marker through
 * this same query. No new stores — presence is read from state the
 * surface already publishes, via MutationObserver so the banner copy
 * defers the moment a session starts.
 */
function useBusyGuard(): boolean {
  const [busy, setBusy] = useState<boolean>(() =>
    typeof document === 'undefined'
      ? false
      : document.querySelector('[data-import-progress]') !== null,
  );
  useEffect(() => {
    const check = () => setBusy(document.querySelector('[data-import-progress]') !== null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return busy;
}
