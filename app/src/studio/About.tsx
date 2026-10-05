import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { updateManager, usePwaUpdate } from '../pwa/usePwaUpdate';
import { formatIso } from '../utils/format';
import { ToolHeading } from './components/ui';
import { DEV_NOTES } from './devNotes';

declare const __FOLIO_VERSION__: string;
declare const __FOLIO_BUILD_TIME__: string;

type Entry = {
  version: string;
  date: string;
  title: string;
  status: 'shipped' | 'latest' | 'planned';
  changes: string[];
};

const ENTRIES: Entry[] = [
  {
    version: 'v1.0.0',
    date: '2026 · 01',
    title: 'Foundation',
    status: 'shipped',
    changes: [
      'First public release — four local PDF tools: Merge, Split, Rearrange & Rotate (Compress was listed but reserved).',
      '100% in-browser with a local Rust/WASM engine + PDF.js rendering — no uploads, no servers.',
      'Editorial design system (paper / ink / brass / forest, Fraunces + Inter).',
      'Offline-ready PWA scaffold.',
    ],
  },
  {
    version: 'v1.1.0',
    date: '2026 · 08',
    title: 'Refine & focus',
    status: 'shipped',
    changes: [
      'Removed non-working converters — Folio does one thing well: PDFs that never leave your device.',
      'Page viewer (pdf.js canvas) and a precise Split picker with range + thumbnail selection.',
      'Rearrange & Split UX polish: drag-to-reorder, clearer drop zones, safer file handling.',
    ],
  },
  {
    // dynamic — always reflects package.json version via Vite define
    version: `v${typeof __FOLIO_VERSION__ !== 'undefined' ? __FOLIO_VERSION__ : '1.1.0'} · dev`,
    date: 'now · latest',
    title: 'Scanner + real engine underneath',
    status: 'latest',
    changes: [
      'On-device document scanner on scanic — ML detection by default with classical as silent fallback; original-feed capture with main-lens default and a persisted camera pick.',
      'Auto-accept review with thin-handle adjust, a calm loupe, and a fullscreen finder.',
      'Warped pages commit as full-res JPEG; originals stay byte-identical.',
      'Every tool still runs on the local Rust/WASM engine — Compress stays reserved.',
    ],
  },
];

const ease = [0.22, 1, 0.36, 1] as const;

export type FolioChannel = 'production' | 'dev-preview' | 'local';

/**
 * Which channel this page is being served from (D36 dev-channel card).
 * Production is the one canonical host; localhost is a local build; every
 * other host — dev-folio-pdf.pages.dev, *.pages.dev previews, LAN origins —
 * is a dev preview. The card renders on every channel except production,
 * so a fresh load proves which build actually landed.
 */
export function folioChannel(hostname: string): FolioChannel {
  if (hostname === 'folio-pdf.pages.dev') return 'production';
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'local';
  return 'dev-preview';
}

const CHANNEL_BADGE: Record<Exclude<FolioChannel, 'production'>, string> = {
  'dev-preview': 'Dev preview',
  local: 'Local build',
};

/**
 * Build-channel card — visible on every host EXCEPT production. Reuses the
 * update manager's own status line (no parallel SW bookkeeping) and the
 * append-only DEV_NOTES list so "did the update land?" is answerable from
 * the page itself: version + build stamp + the latest shipped wave.
 */
function DevChannelCard() {
  const state = usePwaUpdate();
  const channel = folioChannel(typeof window !== 'undefined' ? window.location.hostname : '');
  const latest = DEV_NOTES[0];
  // Hooks run unconditionally; production (or an empty notes list) renders
  // nothing at all — hence the early return AFTER the hooks above.
  if (channel === 'production' || !latest) return null;
  const earlier = DEV_NOTES.slice(1);
  const version = typeof __FOLIO_VERSION__ !== 'undefined' ? __FOLIO_VERSION__ : '1.1.0';
  const buildTime = typeof __FOLIO_BUILD_TIME__ !== 'undefined' ? __FOLIO_BUILD_TIME__ : '';
  return (
    <motion.section
      data-dev-channel={channel}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease }}
      aria-label="Build channel"
      className="mb-6 rounded-2xl border border-brass-500/25 dark:border-brass-400/20 bg-brass-400/[0.05] dark:bg-brass-400/[0.07] p-5 shadow-soft"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-base font-semibold tracking-tight text-ink-900 dark:text-paper-100">
              Build channel
            </h2>
            <span className="inline-flex items-center rounded-full border border-brass-500/30 bg-brass-400/[0.12] px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-brass-600 dark:text-brass-300">
              {CHANNEL_BADGE[channel]}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-ink-500 dark:text-ink-300">
            A non-production build — this card exists so a fresh load proves which update actually
            landed.
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-brass-500/25 bg-brass-400/[0.08] px-3 py-1 font-mono text-xs text-brass-600 dark:text-brass-300">
          v{version}
        </span>
        <time
          dateTime={buildTime || undefined}
          className="inline-flex items-center rounded-full border border-paper-300 dark:border-ink-700 bg-paper-50/70 dark:bg-ink-800/60 px-3 py-1 font-mono text-xs text-ink-500 dark:text-ink-300"
        >
          Built {buildTime ? formatIso(buildTime) : '— time unavailable'}
        </time>
      </div>

      <div className="mt-3 rounded-xl bg-ink-900/[0.04] dark:bg-ink-950/60 p-3">
        <p className="text-[10px] font-medium uppercase tracking-wider text-ink-400 dark:text-ink-300">
          Service worker
        </p>
        <p className="mt-0.5 text-xs text-ink-500 dark:text-ink-300" role="status">
          {state.statusText}
        </p>
      </div>

      <div className="mt-4">
        <p className="text-[10px] font-medium uppercase tracking-wider text-ink-400 dark:text-ink-300">
          Shipped waves · newest first
        </p>
        <div className="mt-2 rounded-xl border border-brass-400/30 bg-paper-50/70 dark:bg-ink-800/50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-brass-600 dark:text-brass-300">
              {latest.build}
            </span>
            <span className="inline-flex items-center rounded-full border border-brass-400/40 bg-brass-400/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-brass-600 dark:text-brass-300">
              current
            </span>
            <span className="ml-auto font-mono text-xs text-ink-400 dark:text-ink-300">
              {latest.date}
            </span>
          </div>
          <ul className="mt-2.5 space-y-1.5">
            {latest.notes.map((note) => (
              <li
                key={note.slice(0, 24)}
                className="flex gap-2.5 text-sm text-ink-500 dark:text-ink-300 leading-relaxed"
              >
                <span
                  aria-hidden
                  className="mt-[7px] w-1 h-1 rounded-full bg-brass-500/60 shrink-0"
                />
                <span className="text-pretty">{note}</span>
              </li>
            ))}
          </ul>
        </div>
        {earlier.length > 0 && (
          <div className="mt-2 space-y-2">
            {earlier.map((entry) => (
              <details
                key={`${entry.build}-${entry.date}`}
                className="group rounded-xl border border-paper-300/70 dark:border-ink-700 bg-paper-50/60 dark:bg-ink-800/40"
              >
                <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-3 text-xs text-ink-500 dark:text-ink-300">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                    className="shrink-0 transition-transform group-open:rotate-90"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                  <span className="font-mono font-semibold text-brass-600 dark:text-brass-300">
                    {entry.build}
                  </span>
                  <span className="ml-auto font-mono">{entry.date}</span>
                </summary>
                <ul className="px-3 pb-3 space-y-1.5">
                  {entry.notes.map((note) => (
                    <li
                      key={note.slice(0, 24)}
                      className="flex gap-2.5 text-sm text-ink-500 dark:text-ink-300 leading-relaxed"
                    >
                      <span
                        aria-hidden
                        className="mt-[7px] w-1 h-1 rounded-full bg-brass-500/60 shrink-0"
                      />
                      <span className="text-pretty">{note}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-ink-400 dark:text-ink-300 leading-relaxed">
        This preview build may change daily — production is{' '}
        <a
          href="https://folio-pdf.pages.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-brass-400/60 underline-offset-2 hover:text-brass-600 dark:hover:text-brass-300 transition-colors"
        >
          folio-pdf.pages.dev
        </a>
        .
      </p>
    </motion.section>
  );
}

function UpdateCard() {
  const state = usePwaUpdate();
  const [showLog, setShowLog] = useState(false);
  // Auto-expand when an update arrives (the banner links here), but the
  // toggle stays authoritative: it owns the state, so Hide always hides.
  useEffect(() => {
    if (state.updateAvailable) setShowLog(true);
  }, [state.updateAvailable]);
  const expanded = showLog;
  const applying = state.phase === 'applying';
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease }}
      aria-label="App updates"
      className="mb-6 rounded-2xl border border-paper-300/70 dark:border-ink-700 bg-paper-50/85 dark:bg-ink-800/60 p-5 shadow-soft"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-semibold tracking-tight text-ink-900 dark:text-paper-100">
            App updates
          </h2>
          <p className="mt-0.5 text-sm text-ink-500 dark:text-ink-300" role="status">
            {state.statusText}
          </p>
        </div>
        <span className="inline-flex items-center rounded-full border border-brass-500/25 bg-brass-400/[0.08] px-3 py-1 font-mono text-xs text-brass-600 dark:text-brass-300">
          v{typeof __FOLIO_VERSION__ !== 'undefined' ? __FOLIO_VERSION__ : '1.1.0'}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void updateManager.checkForUpdates(true)}
          disabled={!state.canCheck}
          className="rounded-xl border border-paper-300 dark:border-ink-700 px-4 py-2 min-h-[44px] text-sm font-medium text-ink-700 dark:text-paper-100 transition-colors hover:bg-paper-200 dark:hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.checking ? 'Checking…' : 'Check for updates'}
        </button>
        {state.updateAvailable && (
          <button
            type="button"
            onClick={() => updateManager.applyUpdate()}
            disabled={applying}
            className="rounded-xl bg-ink-900 dark:bg-paper-50 text-paper-50 dark:text-ink-900 px-4 py-2 text-sm font-medium shadow-sm hover:opacity-90 transition-opacity disabled:cursor-wait disabled:opacity-70"
          >
            {applying ? 'Installing…' : 'Update now'}
          </button>
        )}
        {state.log.length > 0 && (
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            aria-expanded={expanded}
            className="text-xs text-ink-400 dark:text-ink-300 hover:text-ink-700 dark:hover:text-paper-100 transition-colors px-2 py-2 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
          >
            {expanded ? 'Hide details' : 'Details'}
          </button>
        )}
      </div>
      {expanded && state.log.length > 0 && (
        <ol className="mt-3 space-y-1 rounded-xl bg-ink-900/[0.04] dark:bg-ink-950/60 p-3 font-mono text-[11px] leading-relaxed text-ink-500 dark:text-ink-300">
          {state.log.map((line, i) => (
            <li key={i}>› {line}</li>
          ))}
        </ol>
      )}
    </motion.section>
  );
}

export default function About() {
  return (
    <div className="py-2">
      <ToolHeading
        icon={
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4l2.5 2.5" />
          </svg>
        }
        name="About Folio"
        desc="Private PDF tools — built so your documents never have to leave your hands."
      />

      {/* App updates — one-tap escape from a hard-cached PWA (F-13).
          The worker downloads in the background and waits; this card
          surfaces the waiting version and applies it on tap, with
          diagnostics for debugging stale installs on phones. */}
      <UpdateCard />

      {/* Dev channel — visible on every host except production (D36). The
          card itself returns null on folio-pdf.pages.dev, so production
          stays identical to before. */}
      <DevChannelCard />

      {/* split layout: sticky mission left, scrolling content right */}
      <div className="grid lg:grid-cols-[minmax(280px,5fr)_minmax(320px,7fr)] gap-6 lg:gap-10">
        {/* LEFT — mission + privacy proof */}
        <div className="lg:sticky lg:top-24 self-start space-y-5">
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease }}
            className="rounded-2xl border border-paper-300/70 dark:border-ink-700 bg-paper-50/85 dark:bg-ink-800/60 p-6 shadow-soft"
          >
            <h2 className="font-display text-xl font-semibold tracking-tight text-ink-900 dark:text-paper-100">
              What is Folio?
            </h2>
            <p className="text-sm text-ink-500 dark:text-ink-300 mt-3 leading-relaxed">
              Six tools that do one thing well. Every operation — merging, splitting, rotating,
              document properties — runs inside your browser on a local Rust engine (WebAssembly)
              with PDF.js rendering. There is no server to upload to, because there is no upload at
              all.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {['Offline-first', 'No uploads', 'No accounts'].map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center rounded-full bg-forest-500/[0.09] dark:bg-forest-500/15 border border-forest-500/20 px-3 py-1 text-xs font-medium text-forest-600 dark:text-forest-300"
                >
                  {t}
                </span>
              ))}
            </div>
          </motion.section>

          {/* privacy proof — the data flow */}
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.08, ease }}
            className="rounded-2xl border border-brass-500/25 dark:border-brass-400/20 bg-brass-400/[0.05] dark:bg-brass-400/[0.07] p-6 shadow-soft"
          >
            <h3 className="font-display text-base font-semibold tracking-tight text-ink-900 dark:text-paper-100">
              Where does my file go?
            </h3>
            <ol className="mt-4 space-y-0">
              {[
                ['Your device', 'You pick or drop a file'],
                ['Browser memory', 'pdf.js reads it locally'],
                ['Back to you', 'Result downloads instantly'],
              ].map(([t, s], i) => (
                <li key={t} className="relative flex gap-3 pb-4 last:pb-0">
                  {i < 2 && (
                    <span
                      aria-hidden
                      className="absolute left-[13px] top-7 bottom-0 w-px bg-brass-500/30 dark:bg-brass-400/25"
                    />
                  )}
                  <span className="relative w-7 h-7 shrink-0 rounded-full bg-ink-900 dark:bg-paper-100 text-paper-50 dark:text-ink-900 flex items-center justify-center text-xs font-bold font-mono">
                    {i + 1}
                  </span>
                  <span className="pt-0.5">
                    <span className="block text-sm font-semibold text-ink-900 dark:text-paper-100">
                      {t}
                    </span>
                    <span className="block text-xs text-ink-500 dark:text-ink-300 mt-0.5">{s}</span>
                  </span>
                </li>
              ))}
            </ol>
            {/* the crossed-out server */}
            <div className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-dashed border-red-500/35 bg-red-500/[0.05] px-3 py-2.5">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="text-red-500/80"
              >
                <rect x="3" y="4" width="18" height="6" rx="1.5" />
                <rect x="3" y="14" width="18" height="6" rx="1.5" />
                <path d="M7 7h.01M7 17h.01" />
              </svg>
              <span className="text-xs font-medium text-red-600/90 dark:text-red-400/90 line-through decoration-red-500/60">
                cloud server
              </span>
              <span className="text-[11px] text-ink-400 dark:text-ink-300">— never involved</span>
            </div>
          </motion.section>

          {/* open source */}
          <motion.a
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.14, ease }}
            href="https://github.com/SUMANTHXT900/folio"
            target="_blank"
            rel="noopener noreferrer"
            whileHover={{ y: -2 }}
            className="block rounded-2xl border border-paper-300/70 dark:border-ink-700 bg-paper-50/85 dark:bg-ink-800/60 p-5 shadow-soft hover:border-brass-400/40 transition-colors group"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold tracking-tight text-ink-900 dark:text-paper-100">
                  Open source
                </h3>
                <p className="text-xs text-ink-500 dark:text-ink-300 mt-1 leading-relaxed">
                  Read the code that handles your files.
                </p>
              </div>
              <span className="w-9 h-9 rounded-full border border-paper-200 dark:border-ink-700 flex items-center justify-center text-ink-400 group-hover:text-brass-500 group-hover:border-brass-400/40 transition-colors shrink-0">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M7 17 17 7M9 7h8v8" />
                </svg>
              </span>
            </div>
          </motion.a>
        </div>

        {/* RIGHT — version tree */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.06, ease }}
          aria-label="Version history"
        >
          <div className="flex items-center justify-between mb-5 lg:mb-6">
            <h2 className="font-display text-xl font-semibold tracking-tight text-ink-900 dark:text-paper-100">
              Version tree
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-brass-500/25 bg-brass-400/[0.08] px-3 py-1 font-mono text-xs text-brass-600 dark:text-brass-300">
              v{typeof __FOLIO_VERSION__ !== 'undefined' ? __FOLIO_VERSION__ : '1.1.0'}
            </span>
          </div>

          <ol className="relative">
            {/* spine */}
            <span
              aria-hidden
              className="absolute left-[7px] top-2 bottom-2 w-px bg-gradient-to-b from-brass-400/60 via-paper-300 dark:via-ink-700 to-transparent"
            />
            {ENTRIES.map((e, i) => (
              <motion.li
                key={`${e.version}-${i}`}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.42, delay: Math.min(0.12 + i * 0.07, 0.2), ease }}
                className="relative pl-8 pb-6 last:pb-0 group/item"
              >
                {/* node dot */}
                <span
                  aria-hidden
                  className={
                    'absolute left-0 top-1.5 w-[15px] h-[15px] rounded-full border-2 transition-colors ' +
                    (e.status === 'latest'
                      ? 'bg-brass-400 border-brass-400/40 shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-brass-400)_22%,transparent)]'
                      : e.status === 'shipped'
                        ? 'bg-brass-400/70 border-paper-100 dark:border-ink-800'
                        : 'bg-transparent border-dashed border-ink-400/70 dark:border-ink-500')
                  }
                />
                <div
                  className={
                    'rounded-2xl border p-5 shadow-soft transition-[transform,border-color,box-shadow] duration-300 group-hover/item:-translate-y-0.5 ' +
                    (e.status === 'latest'
                      ? 'border-brass-400/40 bg-brass-400/[0.07] dark:bg-brass-400/[0.09]'
                      : e.status === 'planned'
                        ? 'border-paper-300/70 dark:border-ink-700/80 bg-paper-50/50 dark:bg-ink-800/30 border-dashed'
                        : 'border-paper-300/70 dark:border-ink-700 bg-paper-50/85 dark:bg-ink-800/60 group-hover/item:border-brass-400/30')
                  }
                >
                  <div className="flex items-center gap-2.5 flex-wrap mb-2.5">
                    <span className="font-mono text-sm font-semibold text-brass-600 dark:text-brass-300 tabular-nums">
                      {e.version}
                    </span>
                    <span
                      className={
                        'text-[10px] font-medium uppercase tracking-wider rounded-full px-2 py-0.5 border ' +
                        (e.status === 'latest'
                          ? 'border-brass-400/40 text-brass-600 dark:text-brass-300 bg-brass-400/10'
                          : e.status === 'shipped'
                            ? 'border-forest-500/25 text-forest-600 dark:text-forest-300 bg-forest-500/[0.08]'
                            : 'border-ink-400/40 dark:border-ink-500/50 text-ink-400 dark:text-ink-300')
                      }
                    >
                      {e.status}
                    </span>
                    <span className="text-xs text-ink-400 dark:text-ink-300 ml-auto font-mono">
                      {e.date}
                    </span>
                  </div>
                  <h3 className="font-display text-lg font-semibold tracking-tight text-ink-900 dark:text-paper-100">
                    {e.title}
                  </h3>
                  <ul className="mt-2.5 space-y-1.5">
                    {e.changes.map((c) => (
                      <li
                        key={c.slice(0, 24)}
                        className="flex gap-2.5 text-sm text-ink-500 dark:text-ink-300 leading-relaxed"
                      >
                        <span
                          aria-hidden
                          className="mt-[7px] w-1 h-1 rounded-full bg-brass-500/60 shrink-0"
                        />
                        <span className="text-pretty">{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </motion.li>
            ))}
          </ol>

          {/* Coming soon — honest aspirations, not a roadmap promise.
              Nothing below is committed, scheduled, or dated. */}
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.42,
              delay: Math.min(0.12 + ENTRIES.length * 0.07, 0.2),
              ease,
            }}
            className="mt-6 rounded-2xl border border-dashed border-paper-300/70 dark:border-ink-700/80 bg-paper-50/50 dark:bg-ink-800/30 p-5 shadow-soft"
          >
            <span className="text-[10px] font-medium uppercase tracking-wider rounded-full px-2 py-0.5 border border-ink-400/40 dark:border-ink-500/50 text-ink-400 dark:text-ink-300">
              Coming soon
            </span>
            <h3 className="font-display text-lg font-semibold tracking-tight text-ink-900 dark:text-paper-100 mt-2.5">
              Ideas under consideration
            </h3>
            <ul className="mt-2.5 space-y-1.5">
              {[
                'Compress — smaller files, still fully on-device.',
                'Easier sharing and lightweight annotation ideas.',
              ].map((c) => (
                <li
                  key={c.slice(0, 24)}
                  className="flex gap-2.5 text-sm text-ink-500 dark:text-ink-300 leading-relaxed"
                >
                  <span
                    aria-hidden
                    className="mt-[7px] w-1 h-1 rounded-full bg-brass-500/60 shrink-0"
                  />
                  <span className="text-pretty">{c}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-400 dark:text-ink-300 leading-relaxed">
              Nothing here is promised, scheduled, or dated — these are directions being explored,
              not commitments.
            </p>
            <a
              href="https://github.com/SUMANTHXT900/folio/issues/new"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-2 rounded-xl border border-paper-300 dark:border-ink-700 px-4 py-2 text-sm font-medium text-ink-700 dark:text-paper-100 transition-colors hover:bg-paper-200 dark:hover:bg-ink-700"
            >
              Suggest a feature
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M7 17 17 7M9 7h8v8" />
              </svg>
            </a>
          </motion.div>
        </motion.section>
      </div>

      {/* developer strip */}
      <motion.footer
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="mt-10 pt-6 border-t border-paper-200/80 dark:border-ink-800/80 flex flex-col sm:flex-row items-center justify-between gap-3"
      >
        <p className="text-xs text-ink-400 dark:text-ink-300">
          Built by{' '}
          <span className="font-medium text-ink-600 dark:text-paper-100">
            Sai Sumanth Giduthuri
          </span>{' '}
          · ECE @ GITAM
        </p>
        <div className="flex items-center gap-4 text-xs">
          <a
            href="https://www.linkedin.com/in/sai-sumanth-giduthuri-0a9956329/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-brass-600 dark:hover:text-brass-300 transition-colors"
          >
            LinkedIn
          </a>
          <a
            href="https://github.com/SUMANTHXT900"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-brass-600 dark:hover:text-brass-300 transition-colors"
          >
            GitHub
          </a>
          <a href="#/" className="hover:text-brass-600 dark:hover:text-brass-300 transition-colors">
            Folio
          </a>
        </div>
      </motion.footer>
      <p className="mt-3 text-center text-[11px] text-ink-400 dark:text-ink-300">
        Document scanning by scanic (MIT © marquaye) — detector assets self-hosted, runs fully
        on-device.
      </p>
    </div>
  );
}
