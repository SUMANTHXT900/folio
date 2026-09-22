import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { sharePdf } from '../lib/pdf'

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  className = '',
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'primary' | 'ghost' | 'danger'
  className?: string
  type?: 'button' | 'submit'
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-400/40 focus-visible:ring-offset-1 focus-visible:ring-offset-paper-100 dark:focus-visible:ring-offset-ink-950'
  const styles = {
    primary:
      'bg-ink-900 text-paper-50 hover:bg-ink-800 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200 shadow-sm hover:shadow-md active:shadow-sm',
    ghost:
      'border border-paper-300 dark:border-ink-700 text-ink-700 dark:text-paper-100 hover:bg-paper-200 dark:hover:bg-ink-800 hover:border-brass-400/30',
    danger:
      'border border-red-600/30 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30',
  }[variant]
  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.98, y: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 20 }}
      className={`${base} ${styles} ${className}`}
    >
      {children}
    </motion.button>
  )
}

export function DropZone({
  accept,
  multiple,
  onFiles,
  title = 'Drop your PDF here',
  hint = 'or pick a file — it opens instantly, right here',
  cta = 'Select file',
}: {
  accept?: string
  multiple?: boolean
  onFiles: (files: File[]) => void
  title?: string
  hint?: string
  cta?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length) onFiles(files)
      }}
      className={`relative w-full overflow-hidden rounded-2xl border-2 border-dashed p-8 sm:p-14 flex flex-col items-center justify-center gap-4 text-center transition-colors ${
        over
          ? 'border-brass-400 bg-brass-400/[0.08] shadow-[0_0_0_5px_color-mix(in_srgb,var(--color-brass-400)_16%,transparent)] scale-[1.005]'
          : 'border-brass-500/35 dark:border-brass-400/25 bg-paper-50/70 dark:bg-ink-800/40 hover:bg-paper-50 dark:hover:bg-ink-800/60 hover:border-brass-400/60'
      }`}
    >
      {/* subtle grid */}
      <span aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.05] dark:opacity-[0.07]"
        style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, var(--color-brass-500) 1px, transparent 0)', backgroundSize: '20px 20px' }} />

      <motion.div
        animate={over ? { y: -3, scale: 1.06 } : { y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 400, damping: 17 }}
        className={`relative w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm ring-1 transition-colors ${
          over ? 'bg-brass-400 text-white ring-brass-400/40' : 'bg-ink-900 dark:bg-paper-100 text-paper-50 dark:text-ink-900 ring-black/5 dark:ring-white/10'
        }`}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" x2="12" y1="3" y2="15" />
        </svg>
      </motion.div>

      <div className="relative">
        <p className="font-display text-lg font-semibold text-ink-900 dark:text-paper-100">{title}</p>
        <p className="text-sm text-ink-500 dark:text-ink-300 mt-1">{hint}</p>
        <AnimatePresence>
          {over && (
            <motion.p initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-xs font-semibold text-brass-600 dark:text-brass-300 mt-1.5 tracking-wide uppercase">
              release to add
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* real CTA button */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="relative inline-flex items-center gap-2 rounded-xl bg-ink-900 dark:bg-paper-50 text-paper-50 dark:text-ink-900 px-5 py-2.5 text-sm font-medium shadow-sm hover:shadow-md hover:-translate-y-px active:translate-y-0 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-400/50 focus-visible:ring-offset-2 focus-visible:ring-offset-paper-50 dark:focus-visible:ring-offset-ink-800"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        </svg>
        {cta}
      </button>

      <span className="relative inline-flex items-center gap-1.5 text-[11px] text-ink-500 dark:text-ink-300 rounded-full border border-brass-500/20 dark:border-brass-400/20 bg-brass-400/[0.07] dark:bg-brass-400/[0.09] px-3 py-1">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        PDF only · processed locally · never uploaded
      </span>

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          if (files.length) onFiles(files)
          e.target.value = ''
        }}
      />
    </motion.div>
  )
}

export function FileChip({
  name,
  size,
  onRemove,
}: {
  name: string
  size: number
  onRemove: () => void
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-center gap-3 rounded-xl border border-paper-300/70 dark:border-ink-700 bg-paper-50 dark:bg-ink-800/60 px-4 py-3 shadow-sm"
    >
      <span className="w-9 h-9 rounded-lg bg-brass-400/15 text-brass-600 dark:text-brass-300 flex items-center justify-center shrink-0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink-900 dark:text-paper-100 truncate">{name}</p>
        <p className="text-xs text-ink-400 dark:text-ink-300">{formatBytes(size)}</p>
      </div>
      <motion.button
        onClick={onRemove}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.92 }}
        className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
        aria-label={`Remove ${name}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </motion.button>
    </motion.div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-10">
      <span className="relative w-10 h-10">
        <span className="absolute inset-0 rounded-full border-[3px] border-paper-200 dark:border-ink-700" />
        <motion.span
          animate={{ rotate: 360 }}
          transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
          className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-brass-500"
        />
      </span>
      {label && <p className="text-sm text-ink-400 dark:text-ink-300">{label}</p>}
    </div>
  )
}

export function ToolHeading({ icon, name, desc }: { icon: React.ReactNode; name: string; desc: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="mb-8"
    >
      {/* single back-link (header no longer duplicates it) */}
      <a href="#/" className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-brass-600 dark:text-ink-300 dark:hover:text-brass-300 transition-colors mb-4 group">
        <span className="w-6 h-6 rounded-full border border-paper-200 dark:border-ink-700 bg-paper-50 dark:bg-ink-800 flex items-center justify-center group-hover:border-brass-400/40 group-hover:-translate-x-0.5 transition-all">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </span>
        All tools
      </a>
      <div className="flex items-start gap-4">
        <motion.div
          initial={{ scale: 0.9, rotate: -4 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 18, delay: 0.08 }}
          className="w-12 h-12 rounded-2xl bg-ink-900 dark:bg-paper-50 text-paper-50 dark:text-ink-900 flex items-center justify-center shrink-0 shadow-sm ring-1 ring-black/5 dark:ring-white/10"
        >
          {icon}
        </motion.div>
        <div className="min-w-0">
          <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-ink-900 dark:text-paper-100">{name}</h1>
          <p className="text-sm text-ink-500 dark:text-ink-300 mt-1 leading-relaxed max-w-xl">{desc}</p>
        </div>
      </div>
    </motion.div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className={`rounded-2xl border border-paper-300/70 dark:border-ink-700 bg-paper-50/80 dark:bg-ink-800/60 backdrop-blur p-6 shadow-soft ${className}`}
    >
      {children}
    </motion.div>
  )
}

/* Determinate progress bar (compress) + staged status line (fast ops) */
export function Progress({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <div className="mt-4" role="status" aria-live="polite">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-ink-500 dark:text-ink-300">{label ?? 'Working…'}</span>
        <span className="text-xs font-mono tabular-nums text-brass-600 dark:text-brass-300">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-paper-200 dark:bg-ink-700 overflow-hidden">
        {/* scaleX keeps the animation compositor-only (#21) */}
        <div className="h-full w-full rounded-full origin-left bg-gradient-to-r from-brass-500 to-brass-300">
          <motion.div
            className="h-full w-full rounded-full bg-gradient-to-r from-brass-500 to-brass-300"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: pct / 100 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            style={{ transformOrigin: 'left' }}
          />
        </div>
      </div>
    </div>
  )
}

/* Staged indicator for single-step ops (merge/split/rotate) */
export function StageLine({ stage }: { stage: string }) {
  return (
    <div className="mt-4 flex items-center gap-2.5" role="status" aria-live="polite">
      <motion.span
        animate={{ opacity: [0.35, 1, 0.35] }}
        transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
        className="w-2 h-2 rounded-full bg-brass-400"
      />
      <span className="text-sm text-ink-500 dark:text-ink-300">{stage}</span>
    </div>
  )
}

/* Result banner: ALWAYS shows a real tappable "Save to device" anchor (works
   even where programmatic saves are blocked) + an optional Share button. */
export function DoneBanner({ name, blob, shareable = false }: { name: string; blob?: Blob; shareable?: boolean }) {
  const [url, setUrl] = useState<string | undefined>(() => (blob ? URL.createObjectURL(blob) : undefined))
  const [shared, setShared] = useState(false)

  // revoke on unmount and whenever the url is replaced — prevents blob leaks
  useEffect(() => {
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [url])
  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 380, damping: 24 }}
      className="mt-5 rounded-xl border border-forest-500/30 bg-forest-500/[0.08] px-4 py-3.5"
    >
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 rounded-full bg-forest-500/15 text-forest-600 dark:text-forest-300 flex items-center justify-center shrink-0 mt-0.5">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-forest-600 dark:text-forest-300">
            {name}
          </p>
          <p className="text-xs text-forest-600/80 dark:text-forest-300/80 mt-0.5 break-all">
            Ready — tap “Save to device” if it didn’t save automatically.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 pl-11">
        {url && (
          <a
            href={url}
            download={name}
            className="inline-flex items-center gap-2 rounded-lg bg-forest-600 hover:bg-forest-500 text-white px-4 py-2.5 text-sm font-semibold shadow-sm transition-colors min-h-[44px]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></svg>
            Save to device
          </a>
        )}
        {shareable && blob && (
          <button
            type="button"
            onClick={async () => {
              const r = await sharePdf(blob, name)
              if (r === 'shared') setShared(true)
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-forest-500/40 text-forest-600 dark:text-forest-300 px-4 py-2.5 text-sm font-medium hover:bg-forest-500/[0.08] transition-colors min-h-[44px]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" x2="15.42" y1="13.51" y2="17.49" /><line x1="15.41" x2="8.59" y1="6.51" y2="10.49" /></svg>
            {shared ? 'Shared ✓' : 'Share…'}
          </button>
        )}
      </div>
    </motion.div>
  )
}
