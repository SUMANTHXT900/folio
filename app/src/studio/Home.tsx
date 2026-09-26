import { motion } from 'framer-motion';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { TOOL_LIST } from './StudioApp';
import { getMostUsedId, recordToolOpen } from './toolUsage';

const ICONS: Record<string, React.ReactNode> = {
  merge: (
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
      <path d="M3 6h18M3 12h12M3 18h6" />
    </svg>
  ),
  split: (
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
      <path d="M12 3v18" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
    </svg>
  ),
  rearrange: (
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
      <path d="M3 8l6-5-6 5zm0 0 6 5M21 16l-6 5 6-5zm0 0-6-5" />
    </svg>
  ),
  rotate: (
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
      <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.75 1 6.4 2.6L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  ),
  compress: (
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
      <path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M8 3l6 6m0 0V3H8m0 0v6h6" />
    </svg>
  ),
  metadata: (
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
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </svg>
  ),
  images: (
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
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.5-3.5a2 2 0 0 0-3 0L6 20" />
    </svg>
  ),
};

/* Bento layout: the usage hero takes the large 2x2 slot on desktop, split
   goes tall whenever it is NOT the hero, rest standard. When merge is the
   hero (the zero-data default) this matches the original layout exactly.
   Mobile: single column, all full width — thumb-friendly. */
const HERO_SPAN = 'col-span-2 sm:col-span-2 lg:col-span-2 lg:row-span-2';
const BENTO: Record<string, string> = {
  merge: 'col-span-1 sm:col-span-1 lg:col-span-1',
  split: 'col-span-2 sm:col-span-1 lg:col-span-1 lg:row-span-2',
  rearrange: 'col-span-1 sm:col-span-1 lg:col-span-1',
  rotate: 'col-span-1 sm:col-span-1 lg:col-span-1',
  compress: 'col-span-2 sm:col-span-2 lg:col-span-1',
  metadata: 'col-span-1 sm:col-span-1 lg:col-span-1',
  images: 'col-span-1 sm:col-span-1 lg:col-span-1',
};

const TAGLINES: Record<string, string> = {
  merge: 'Combine two or more PDFs into one document. Set the order first.',
  split: 'Keep the pages you pick, or extract exact page ranges.',
  rearrange: 'Reorder pages with drag or arrows, then save.',
  rotate: 'Rotate single pages or the whole file in 90 degree steps.',
  compress: 'Reserved for a future update — not available yet.',
  metadata: 'Read and edit titles, authors, and dates.',
  images: 'Turn JPEG and PNG images into a PDF.',
};

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.15 } },
};
const cardV = {
  hidden: { opacity: 0, y: 16, scale: 0.98 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const },
  },
};

/* Compress is an engine Phase-2 placeholder (see CompressTool): its grid
   card stays visible but disabled — it never records usage and can never
   become the hero, which is picked from enabled tools only. */
const DISABLED_IDS: ReadonlySet<string> = new Set(['compress']);

export default function Home() {
  // Usage-based hero: the most-opened enabled tool, merge with zero data.
  // Read once per mount — navigating home remounts, so the hero is fresh.
  const [heroId] = useState(() =>
    getMostUsedId(TOOL_LIST.map((t) => t.id).filter((id) => !DISABLED_IDS.has(id))),
  );
  const heroTool =
    TOOL_LIST.find((t) => t.id === heroId) ?? TOOL_LIST.find((t) => t.id === 'merge')!;
  const otherTools = TOOL_LIST.filter((t) => t.id !== heroTool.id);

  return (
    <div className="py-6 sm:py-10 overflow-hidden">
      {/* hero — editorial, left-aligned on desktop */}
      <section className="relative max-w-2xl lg:max-w-none lg:grid lg:grid-cols-[1.2fr_1fr] lg:gap-10 lg:items-end mb-10 sm:mb-14 px-0.5">
        {/* soft glow behind hero */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 w-[38rem] h-[18rem] -z-10 opacity-60 blur-3xl"
          style={{
            background:
              'radial-gradient(40rem 14rem at 50% 0%, color-mix(in srgb, var(--color-brass-400) 14%, transparent), transparent 70%)',
          }}
        />

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="inline-flex items-center gap-2 text-xs font-medium text-brass-600 dark:text-brass-300 mb-4">
            <span className="relative flex w-1.5 h-1.5">
              <span className="absolute inline-flex w-full h-full rounded-full bg-forest-500 opacity-40 animate-ping" />
              <span className="relative inline-flex rounded-full w-1.5 h-1.5 bg-forest-500" />
            </span>
            Every tool works offline · nothing is uploaded
          </span>

          <h1 className="font-display text-[2.4rem] sm:text-6xl font-semibold tracking-tight text-ink-900 dark:text-paper-100 leading-[0.98] text-balance">
            <span className="block">PDF tools that</span>
            <span className="bg-gradient-to-r from-brass-500 via-brass-400 to-brass-200 dark:from-brass-400 dark:via-brass-300 dark:to-brass-200 bg-clip-text text-transparent inline-block pb-1.5">
              stay on your device
            </span>
          </h1>

          <p className="mt-4 text-[15px] sm:text-lg text-ink-500 dark:text-ink-300 leading-relaxed max-w-lg text-pretty">
            Merge, split, rearrange, rotate and more — processed entirely in your browser. Your
            documents never touch a server.
          </p>
        </motion.div>

        {/* proof line — editorial, quiet confidence instead of stat boxes */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.22 }}
          className="mt-5 lg:mt-0 lg:absolute lg:right-0 lg:bottom-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-medium text-ink-500 dark:text-ink-300 sm:flex-nowrap sm:whitespace-nowrap"
        >
          <span>
            <strong className="font-display text-brass-600 dark:text-brass-300 font-semibold">
              0
            </strong>{' '}
            servers touched
          </span>
          <span
            aria-hidden
            className="w-1 h-1 rounded-full bg-paper-400 dark:bg-ink-600 inline-block"
          />
          <span>
            <strong className="font-display text-brass-600 dark:text-brass-300 font-semibold">
              100%
            </strong>{' '}
            in your browser
          </span>
          <span
            aria-hidden
            className="w-1 h-1 rounded-full bg-paper-400 dark:bg-ink-600 inline-block"
          />
          <span>
            <strong className="font-display text-brass-600 dark:text-brass-300 font-semibold">
              ∞
            </strong>{' '}
            free
          </span>
        </motion.p>
      </section>

      {/* bento tool grid */}
      <motion.section
        variants={container}
        initial="hidden"
        animate="show"
        className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 auto-rows-[minmax(150px,auto)] lg:auto-rows-[minmax(170px,auto)] gap-3 sm:gap-4"
      >
        {[heroTool, ...otherTools].map((tool) => {
          const Comp = ICONS[tool.id];
          const isHero = tool.id === heroTool.id;
          const disabled = DISABLED_IDS.has(tool.id);
          const cardClass =
            'group relative overflow-hidden rounded-2xl border border-paper-300/70 dark:border-ink-700/90 bg-paper-50/95 dark:bg-ink-800/70 p-4 sm:p-6 shadow-soft transition-colors flex flex-col justify-between min-h-[44vw] sm:min-h-0 ' +
            (isHero ? HERO_SPAN : BENTO[tool.id] || '');
          const cardBody = (
            <>
              {/* mouse-following radial highlight — GPU only */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 ease-out"
                style={{
                  background: `radial-gradient(520px circle at var(--mx) var(--my), color-mix(in srgb, var(--color-brass-400) 16%, transparent), transparent 62%)`,
                  willChange: 'opacity',
                }}
              />

              <div className="relative flex items-start justify-between gap-3">
                <div
                  className={
                    'rounded-xl bg-paper-200 dark:bg-ink-700 flex items-center justify-center text-ink-700 dark:text-paper-100 group-hover:bg-brass-400/15 group-hover:text-brass-600 dark:group-hover:text-brass-300 transition-colors duration-300 ' +
                    (isHero ? 'w-12 h-12' : 'w-11 h-11')
                  }
                >
                  {Comp}
                </div>
                {isHero ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-brass-400/[0.14] border border-brass-400/30 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brass-600 dark:text-brass-200 shadow-sm">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M12 2l2.9 6.26L21 9.27l-4.5 4.39L17.8 20 12 16.77 6.2 20l1.3-6.34L3 9.27l6.1-1.01L12 2z" />
                    </svg>
                    Most used
                  </span>
                ) : disabled ? (
                  <span className="inline-flex items-center rounded-full bg-paper-200/80 dark:bg-ink-700/80 border border-paper-300 dark:border-ink-600 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-400 dark:text-ink-300">
                    Soon
                  </span>
                ) : null}
              </div>

              <div className="relative mt-auto pt-6">
                <h3
                  className={
                    'font-display font-semibold tracking-tight text-ink-900 dark:text-paper-100 ' +
                    (isHero ? 'text-xl sm:text-2xl' : 'text-base sm:text-lg')
                  }
                >
                  {tool.name}
                </h3>
                <p className="text-xs sm:text-sm text-ink-500 dark:text-ink-300 mt-1.5 leading-relaxed max-w-xs text-pretty">
                  {TAGLINES[tool.id]}
                </p>
              </div>

              {/* bottom accent */}
              <span className="pointer-events-none absolute bottom-0 left-4 right-4 h-px bg-gradient-to-r from-transparent via-brass-400/0 to-transparent group-hover:via-brass-400/40 transition-colors duration-500" />
            </>
          );
          if (disabled) {
            return (
              <motion.div
                key={tool.id}
                variants={cardV}
                aria-disabled="true"
                title="Reserved for a future update"
                className={cardClass + ' opacity-60 saturate-50 cursor-not-allowed'}
              >
                {cardBody}
              </motion.div>
            );
          }
          return (
            <motion.a
              key={tool.id}
              href={`#/${tool.id}`}
              // v1 limitation: only taps on these cards record usage —
              // direct-URL and bookmark visits to a tool never count.
              onClick={() => recordToolOpen(tool.id)}
              variants={cardV}
              whileHover={{ y: -4, transition: { duration: 0.22, ease: 'easeOut' } }}
              whileTap={{ scale: 0.985 }}
              onMouseMove={(e) => {
                const el = e.currentTarget as HTMLElement;
                const r = el.getBoundingClientRect();
                el.style.setProperty('--mx', `${e.clientX - r.left}px`);
                el.style.setProperty('--my', `${e.clientY - r.top}px`);
              }}
              style={{ '--mx': '50%', '--my': '30%' } as CSSProperties}
              className={
                cardClass + ' hover:border-brass-400/50 hover:shadow-lg hover:shadow-brass-400/10'
              }
            >
              {cardBody}
            </motion.a>
          );
        })}
      </motion.section>
    </div>
  );
}
