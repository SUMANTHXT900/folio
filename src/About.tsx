import { motion } from 'framer-motion'
import { ToolHeading } from './components/ui'

declare const __FOLIO_VERSION__: string

type Entry = {
  version: string
  date: string
  title: string
  status: 'shipped' | 'latest' | 'planned'
  changes: string[]
}

const ENTRIES: Entry[] = [
  {
    version: 'v1.0.0',
    date: '2026 · 01',
    title: 'Foundation',
    status: 'shipped',
    changes: [
      'First public release — five local PDF tools: Merge, Split, Rearrange, Rotate & Compress.',
      '100% in-browser with pdf-lib + pdfjs-dist — no uploads, no servers.',
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
    // dynamic — always reflects package.json version via Vite define (currently v1.1.0 + polish on dev)
    version: `v${typeof __FOLIO_VERSION__ !== 'undefined' ? __FOLIO_VERSION__ : '1.1.0'} · dev`,
    date: 'now · latest',
    title: 'Polish — motion, shine & perf',
    status: 'latest',
    changes: [
      'Bento home grid, proof-strip stats and a real select-CTA drop zone.',
      'Theme wave transition, mouse-follow card shine, 60fps motion pass.',
      'Engine: cached thumbnails, lazy tool chunks, paginated grids for large PDFs.',
      'Dark-mode contrast fixes across every surface.',
    ],
  },
  {
    version: 'v1.2.0',
    date: 'planned',
    title: 'Sign & annotate',
    status: 'planned',
    changes: [
      'Draw/type e-signatures and place them on any page.',
      'Form-fill overlay and text annotation.',
      'Watermark & page-number stamps.',
    ],
  },
  {
    version: 'v2.0.0',
    date: 'next',
    title: 'Batch & OCR',
    status: 'planned',
    changes: [
      'Batch queue — run Merge/Split/Rotate across dozens of files.',
      'Local OCR for scanned PDFs (on-device, still private).',
    ],
  },
]

const ease = [0.22, 1, 0.36, 1] as const

export default function About() {
  return (
    <div className="py-2">
      <ToolHeading
        icon={
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4l2.5 2.5" />
          </svg>
        }
        name="About Folio"
        desc="Private PDF tools — built so your documents never have to leave your hands."
      />

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
            <h2 className="font-display text-xl font-semibold tracking-tight text-ink-900 dark:text-paper-100">What is Folio?</h2>
            <p className="text-sm text-ink-500 dark:text-ink-300 mt-3 leading-relaxed">
              Five tools that do one thing well. Every operation — merging, splitting,
              rotating, compressing — runs inside your browser using pdf-lib and pdf.js.
              There is no server to upload to, because there is no upload at all.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {['Offline-first', 'No tracking', 'No accounts'].map((t) => (
                <span key={t} className="inline-flex items-center rounded-full bg-forest-500/[0.09] dark:bg-forest-500/15 border border-forest-500/20 px-3 py-1 text-xs font-medium text-forest-600 dark:text-forest-300">{t}</span>
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
            <h3 className="font-display text-base font-semibold tracking-tight text-ink-900 dark:text-paper-100">Where does my file go?</h3>
            <ol className="mt-4 space-y-0">
              {[
                ['Your device', 'You pick or drop a file'],
                ['Browser memory', 'pdf.js reads it locally'],
                ['Back to you', 'Result downloads instantly'],
              ].map(([t, s], i) => (
                <li key={t} className="relative flex gap-3 pb-4 last:pb-0">
                  {i < 2 && <span aria-hidden className="absolute left-[13px] top-7 bottom-0 w-px bg-brass-500/30 dark:bg-brass-400/25" />}
                  <span className="relative w-7 h-7 shrink-0 rounded-full bg-ink-900 dark:bg-paper-100 text-paper-50 dark:text-ink-900 flex items-center justify-center text-xs font-bold font-mono">{i + 1}</span>
                  <span className="pt-0.5">
                    <span className="block text-sm font-semibold text-ink-900 dark:text-paper-100">{t}</span>
                    <span className="block text-xs text-ink-500 dark:text-ink-300 mt-0.5">{s}</span>
                  </span>
                </li>
              ))}
            </ol>
            {/* the crossed-out server */}
            <div className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-dashed border-red-500/35 bg-red-500/[0.05] px-3 py-2.5">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="text-red-500/80"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></svg>
              <span className="text-xs font-medium text-red-600/90 dark:text-red-400/90 line-through decoration-red-500/60">cloud server</span>
              <span className="text-[11px] text-ink-400 dark:text-ink-300">— never involved</span>
            </div>
          </motion.section>

          {/* open source */}
          <motion.a
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.14, ease }}
            href="https://github.com/SUMANTHXT900/pdf-studio"
            target="_blank"
            rel="noopener noreferrer"
            whileHover={{ y: -2 }}
            className="block rounded-2xl border border-paper-300/70 dark:border-ink-700 bg-paper-50/85 dark:bg-ink-800/60 p-5 shadow-soft hover:border-brass-400/40 transition-colors group"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold tracking-tight text-ink-900 dark:text-paper-100">Open source</h3>
                <p className="text-xs text-ink-500 dark:text-ink-300 mt-1 leading-relaxed">Read the code that touches your files — every line of it.</p>
              </div>
              <span className="w-9 h-9 rounded-full border border-paper-200 dark:border-ink-700 flex items-center justify-center text-ink-400 group-hover:text-brass-500 group-hover:border-brass-400/40 transition-colors shrink-0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M9 7h8v8" /></svg>
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
            <h2 className="font-display text-xl font-semibold tracking-tight text-ink-900 dark:text-paper-100">Version tree</h2>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-brass-500/25 bg-brass-400/[0.08] px-3 py-1 font-mono text-xs text-brass-600 dark:text-brass-300">
              v{typeof __FOLIO_VERSION__ !== 'undefined' ? __FOLIO_VERSION__ : '1.1.0'}
            </span>
          </div>

          <ol className="relative">
            {/* spine */}
            <span aria-hidden className="absolute left-[7px] top-2 bottom-2 w-px bg-gradient-to-b from-brass-400/60 via-paper-300 dark:via-ink-700 to-transparent" />
            {ENTRIES.map((e, i) => (
              <motion.li
                key={`${e.version}-${i}`}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.42, delay: 0.12 + i * 0.07, ease }}
                className="relative pl-8 pb-6 last:pb-0 group/item"
              >
                {/* node dot */}
                <span aria-hidden className={
                  'absolute left-0 top-1.5 w-[15px] h-[15px] rounded-full border-2 transition-colors ' +
                  (e.status === 'latest'
                    ? 'bg-brass-400 border-brass-400/40 shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-brass-400)_22%,transparent)]'
                    : e.status === 'shipped'
                      ? 'bg-brass-400/70 border-paper-100 dark:border-ink-800'
                      : 'bg-transparent border-dashed border-ink-400/70 dark:border-ink-500')
                } />
                <div className={
                  'rounded-2xl border p-5 shadow-soft transition-all duration-300 group-hover/item:-translate-y-0.5 ' +
                  (e.status === 'latest'
                    ? 'border-brass-400/40 bg-brass-400/[0.07] dark:bg-brass-400/[0.09]'
                    : e.status === 'planned'
                      ? 'border-paper-300/70 dark:border-ink-700/80 bg-paper-50/50 dark:bg-ink-800/30 border-dashed'
                      : 'border-paper-300/70 dark:border-ink-700 bg-paper-50/85 dark:bg-ink-800/60 group-hover/item:border-brass-400/30')
                }>
                  <div className="flex items-center gap-2.5 flex-wrap mb-2.5">
                    <span className="font-mono text-sm font-semibold text-brass-600 dark:text-brass-300 tabular-nums">{e.version}</span>
                    <span className={
                      'text-[10px] font-medium uppercase tracking-wider rounded-full px-2 py-0.5 border ' +
                      (e.status === 'latest'
                        ? 'border-brass-400/40 text-brass-600 dark:text-brass-300 bg-brass-400/10'
                        : e.status === 'shipped'
                          ? 'border-forest-500/25 text-forest-600 dark:text-forest-300 bg-forest-500/[0.08]'
                          : 'border-ink-400/40 dark:border-ink-500/50 text-ink-400 dark:text-ink-300')
                    }>{e.status}</span>
                    <span className="text-xs text-ink-400 dark:text-ink-300 ml-auto font-mono">{e.date}</span>
                  </div>
                  <h3 className="font-display text-lg font-semibold tracking-tight text-ink-900 dark:text-paper-100">{e.title}</h3>
                  <ul className="mt-2.5 space-y-1.5">
                    {e.changes.map((c) => (
                      <li key={c.slice(0, 24)} className="flex gap-2.5 text-sm text-ink-500 dark:text-ink-300 leading-relaxed">
                        <span aria-hidden className="mt-[7px] w-1 h-1 rounded-full bg-brass-500/60 shrink-0" />
                        <span className="text-pretty">{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </motion.li>
            ))}
          </ol>
        </motion.section>
      </div>

      {/* developer strip */}
      <motion.footer
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.4 }}
        className="mt-10 pt-6 border-t border-paper-200/80 dark:border-ink-800/80 flex flex-col sm:flex-row items-center justify-between gap-3"
      >
        <p className="text-xs text-ink-400 dark:text-ink-300">
          Built by <span className="font-medium text-ink-600 dark:text-paper-100">Sai Sumanth Giduthuri</span> · ECE @ GITAM
        </p>
        <div className="flex items-center gap-4 text-xs">
          <a href="https://www.linkedin.com/in/sai-sumanth-giduthuri-0a9956329/" target="_blank" rel="noopener noreferrer" className="hover:text-brass-600 dark:hover:text-brass-300 transition-colors">LinkedIn</a>
          <a href="https://github.com/SUMANTHXT900" target="_blank" rel="noopener noreferrer" className="hover:text-brass-600 dark:hover:text-brass-300 transition-colors">GitHub</a>
          <a href="#/" className="hover:text-brass-600 dark:hover:text-brass-300 transition-colors">Folio</a>
        </div>
      </motion.footer>
    </div>
  )
}
