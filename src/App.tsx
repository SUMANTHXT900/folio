import { useEffect, useState, type ReactNode, lazy, Suspense, useMemo, useRef } from 'react'
import React from 'react'
import { motion, AnimatePresence, useScroll, useSpring, MotionConfig } from 'framer-motion'
import Home from './Home'
import About from './About'

// lazy tools — keep hash routing snappy by code-splitting per tool
const MergeTool = lazy(() => import('./tools/MergeTool'))
const SplitTool = lazy(() => import('./tools/SplitTool'))
const RearrangeTool = lazy(() => import('./tools/RearrangeTool'))
const RotateTool = lazy(() => import('./tools/RotateTool'))
const CompressTool = lazy(() => import('./tools/CompressTool'))

export type ToolId =
  | 'merge'
  | 'split'
  | 'rearrange'
  | 'rotate'
  | 'compress'

function ToolFallback() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <span className="w-8 h-8 rounded-full border-2 border-paper-300 dark:border-ink-700 border-t-brass-500 animate-spin" />
      <p className="text-sm text-ink-400">Loading tool…</p>
    </div>
  )
}

/* Error boundary — a failed lazy-chunk import (stale SW, interrupted fetch,
   back/forward cache restore) previously blanked the whole app. Now we show
   a recovery card that reloads the route cleanly. */
class RouteErrorBoundary extends React.Component<
  { children: ReactNode; resetKey: string },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      const isChunk = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(this.state.error.message)
      return (
        <div className="flex flex-col items-center justify-center gap-4 py-20 px-4 text-center">
          <span className="w-12 h-12 rounded-2xl bg-brass-400/15 text-brass-600 dark:text-brass-300 flex items-center justify-center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" x2="12" y1="9" y2="13" /><line x1="12" x2="12.01" y1="17" y2="17.01" /></svg>
          </span>
          <div>
            <p className="font-display text-lg font-semibold text-ink-900 dark:text-paper-100">This view hit a snag</p>
            <p className="text-sm text-ink-500 dark:text-ink-300 mt-1 max-w-sm">
              {isChunk
                ? 'A new app version was released while this page was open.'
                : 'Something went wrong while rendering this view.'}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { window.location.hash = '#/' }}
              className="rounded-xl border border-paper-300 dark:border-ink-700 px-4 py-2 text-sm font-medium text-ink-700 dark:text-paper-100 hover:bg-paper-200 dark:hover:bg-ink-800 transition-colors"
            >
              Go home
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-xl bg-ink-900 dark:bg-paper-50 text-paper-50 dark:text-ink-900 px-4 py-2 text-sm font-medium shadow-sm hover:opacity-90 transition-opacity"
            >
              Reload app
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash.replace(/^#\/?/, '').replace(/\/$/, '')
}

function ScrollProgress() {
  const { scrollYProgress } = useScroll()
  const scaleX = useSpring(scrollYProgress, { stiffness: 300, damping: 30, restDelta: 0.001 })
  return (
    <motion.div
      style={{ scaleX }}
      className="fixed top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-brass-500 via-brass-400 to-forest-400 origin-left z-[60] pointer-events-none"
    />
  )
}

function ThemeWave({ x, y, dark, onDone }: { x: number; y: number; dark: boolean; onDone: () => void }) {
  const size = Math.hypot(window.innerWidth, window.innerHeight) * 2
  return (
    <motion.div
      initial={{ clipPath: `circle(0px at ${x}px ${y}px)` }}
      animate={{ clipPath: `circle(${size}px at ${x}px ${y}px)` }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      onAnimationComplete={onDone}
      className="fixed inset-0 z-[55] pointer-events-none"
      style={{ background: dark ? '#17130e' : '#f7f3eb' }}
    />
  )
}

/* GPU-composited theme reveal via the View Transitions API.
   Falls back to an instant switch when unsupported (or reduced motion). */
function useThemeTransition(
  setDark: (v: boolean) => void,
  onFallback?: (x: number, y: number, next: boolean) => void,
): (e?: React.MouseEvent) => void {
  const inFlight = useRef(false)
  return (e?: React.MouseEvent) => {
    // e.detail > 0 only for real pointer clicks (keyboard activation = 0)
    const isPointer = !!e && e.detail > 0
    const x = isPointer ? e!.clientX : window.innerWidth - 40
    const y = isPointer ? e!.clientY : 24
    const nextDark = !document.documentElement.classList.contains('dark')
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { ready: Promise<void> }
    }
    if (reduce) { setDark(nextDark); return }
    if (!doc.startViewTransition) { onFallback?.(x, y, nextDark); return }
    if (inFlight.current) return // ignore rapid re-clicks mid-transition

    inFlight.current = true
    const vt = doc.startViewTransition(() => setDark(nextDark))
    void vt.ready.then(() => {
      const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
      // symmetric ease-in-out — gentle start, steady sweep, soft finish.
      // Optimized for perceptual smoothness (visible across viewport), not speed.
      const anim = document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        {
          duration: 800,
          easing: 'cubic-bezier(0.45, 0, 0.25, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      )
      // C4/#19: hold the guard until the VISUAL animation truly finishes
      return anim.finished
    }).catch(() => {}).finally(() => { inFlight.current = false })
  }
}

/* Snapshot layering — old view sits below while the new one is circle-revealed */
const VT_CSS = `
::view-transition-old(root), ::view-transition-new(root) { animation: none; mix-blend-mode: normal; }
::view-transition-old(root) { z-index: 1; }
::view-transition-new(root) { z-index: 2; }
`

export default function App() {
  const route = useHashRoute()
  const id = route as ToolId
  const isAbout = route === 'about'
  const isHome = !route
  const isTool = (['merge', 'split', 'rearrange', 'rotate', 'compress'] as string[]).includes(id)
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const saved = localStorage.getItem('folio-theme')
    if (saved) return saved === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  const [fallbackWave, setFallbackWave] = useState<{ x: number; y: number; dark: boolean } | null>(null)
  // C3: browsers without View Transitions get the branded ThemeWave reveal
  const handleToggleDark = useThemeTransition(setDark, (x, y, next) => {
    setDark(next)
    setFallbackWave({ x, y, dark: next })
  })

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', dark)
    localStorage.setItem('folio-theme', dark ? 'dark' : 'light')
    // B3: keep mobile browser chrome in sync with the app theme
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? '#17130e' : '#faf7f2')
  }, [dark])

  // memoize rendered page node — avoids re-creating on unrelated state changes
  const pageNode = useMemo(() => {
    if (isTool) {
      const map: Record<string, ReactNode> = {
        merge: <MergeTool />,
        split: <SplitTool />,
        rearrange: <RearrangeTool />,
        rotate: <RotateTool />,
        compress: <CompressTool />,
      }
      return (
        <RouteErrorBoundary resetKey={route}>
          <Suspense fallback={<ToolFallback />}>{map[id]}</Suspense>
        </RouteErrorBoundary>
      )
    }
    if (isAbout) return <About />
    return (
      <RouteErrorBoundary resetKey={route}>
        <Home />
      </RouteErrorBoundary>
    )
  }, [id, isTool, isAbout, route])

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen flex flex-col pb-[76px] sm:pb-0">
        <style>{VT_CSS}</style>
        <ScrollProgress />
        {fallbackWave && (
          <ThemeWave x={fallbackWave.x} y={fallbackWave.y} dark={fallbackWave.dark} onDone={() => setFallbackWave(null)} />
        )}

      {/* Header — no redundant back-link inside tools (they have their own); shows brand + theme only */}
      <Header dark={dark} onToggleDark={handleToggleDark} />

      <AnimatePresence mode="wait">
        <motion.main
          key={route || 'home'}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          className="flex-1"
        >
          <Page>{pageNode}</Page>
        </motion.main>
      </AnimatePresence>

      <Footer />
      {!isHome && isTool && <MobileNav route={route} />}
      </div>
    </MotionConfig>
  )
}

function Page({ children }: { children: ReactNode }) {
  return <div className="max-w-5xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-10">{children}</div>
}

function Header({ dark, onToggleDark }: { dark: boolean; onToggleDark: (e?: React.MouseEvent) => void }) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  return (
    <header
      className={
        'sticky top-0 z-40 border-b transition-colors duration-300 ' +
        (scrolled
          ? 'glass bg-paper-100/85 dark:bg-ink-950/85 border-paper-300/70 dark:border-ink-800/70 shadow-soft'
          : 'bg-transparent border-transparent')
      }
    >
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
        <a href="#/" className="flex items-center gap-2.5 group" aria-label="Folio home">
          <motion.div
            whileHover={{ rotate: 6, scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 15 }}
            className="w-9 h-9 rounded-xl bg-ink-900 dark:bg-paper-100 flex items-center justify-center shadow-sm ring-1 ring-black/5 dark:ring-white/10"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="2.5" y="2" width="4" height="16" rx="1" className="fill-brass-400" />
              <rect x="8" y="2" width="4" height="16" rx="1" className="fill-brass-300" />
              <rect x="13.5" y="2" width="4" height="16" rx="1" className="fill-brass-500" />
            </svg>
          </motion.div>
          <div className="hidden sm:block">
            <span className="font-display text-[17px] font-semibold leading-none tracking-tight text-ink-900 dark:text-paper-100">Folio</span>
            <span className="block text-[11px] text-ink-400 dark:text-ink-300 leading-none mt-0.5 tracking-wide">private PDF tools</span>
          </div>
        </a>

        <nav className="flex items-center gap-1.5" aria-label="Primary">
          <motion.a
            href="#/about"
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            className="text-sm text-ink-500 hover:text-ink-900 dark:text-ink-300 dark:hover:text-paper-100 transition-colors px-3 py-2 rounded-full hover:bg-paper-200/60 dark:hover:bg-ink-800/70 mr-1"
          >
            About
          </motion.a>
          <motion.button
            onClick={onToggleDark}
            aria-label="Toggle theme"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.94, rotate: 12 }}
            transition={{ type: 'spring', stiffness: 400, damping: 18 }}
            className="w-9 h-9 rounded-full border border-paper-300 dark:border-ink-700 bg-paper-50/60 dark:bg-ink-800/60 backdrop-blur flex items-center justify-center hover:bg-paper-200 dark:hover:bg-ink-700 hover:border-brass-400/40 transition-colors shadow-sm text-ink-700 dark:text-paper-100"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={dark ? 'sun' : 'moon'}
                initial={{ rotate: -30, opacity: 0, scale: 0.8 }}
                animate={{ rotate: 0, opacity: 1, scale: 1 }}
                exit={{ rotate: 30, opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              >
                {dark ? <SunIcon /> : <MoonIcon />}
              </motion.span>
            </AnimatePresence>
          </motion.button>
        </nav>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer className="border-t border-paper-200/70 dark:border-ink-800/70 py-6 mt-8 mb-2 sm:mb-0">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-ink-400 dark:text-ink-300">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-full bg-forest-500/10 dark:bg-forest-500/15 border border-forest-500/15 flex items-center justify-center text-forest-600 dark:text-forest-300">
            <LockIcon />
          </span>
          <span>100% in-browser — files never leave your device.</span>
        </div>
        <div className="flex items-center gap-4">
          <a href="#/about" className="hover:text-ink-900 dark:hover:text-paper-100 transition-colors">About</a>
          <a href="https://www.linkedin.com/in/sai-sumanth-giduthuri-0a9956329/" target="_blank" rel="noopener noreferrer" className="hover:text-ink-900 dark:hover:text-paper-100 transition-colors">LinkedIn</a>
          <a href="https://github.com/SUMANTHXT900/pdf-studio" target="_blank" rel="noopener noreferrer" className="hover:text-ink-900 dark:hover:text-paper-100 transition-colors">GitHub</a>
          <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-paper-200 dark:border-ink-700 bg-paper-50 dark:bg-ink-800 px-2.5 py-1 font-mono text-[11px] text-ink-400 dark:text-ink-300">
            <span className="w-1.5 h-1.5 rounded-full bg-forest-500" /> v{__FOLIO_VERSION__}
          </span>
        </div>
      </div>
    </footer>
  )
}

export const TOOL_LIST: { id: ToolId; name: string; tagline: string }[] = [
  { id: 'merge', name: 'Merge', tagline: 'Combine PDFs into one' },
  { id: 'split', name: 'Split', tagline: 'Extract pages or break apart' },
  { id: 'rearrange', name: 'Rearrange', tagline: 'Reorder pages' },
  { id: 'rotate', name: 'Rotate', tagline: 'Fix page orientation' },
  { id: 'compress', name: 'Compress', tagline: 'Shrink file size' },
]

/* Mobile bottom nav — only shown inside tools (home already IS the nav).
   Utility-focused: back home + sibling tools for quick hopping. */
function MobileNav({ route }: { route: string }) {
  const active = route as ToolId
  return (
    <nav className="sm:hidden fixed bottom-0 inset-x-0 z-50 glass bg-paper-100/92 dark:bg-ink-950/92 border-t border-paper-300/60 dark:border-ink-800/60 pb-[env(safe-area-inset-bottom)]" aria-label="Tools">
      <div className="grid grid-cols-6 gap-0.5 px-2 py-1.5">
        <a href="#/" className="relative flex flex-col items-center justify-center gap-0.5 py-1.5 rounded-xl min-h-[52px]" aria-label="All tools">
          <span className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-400 dark:text-ink-300">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>
          </span>
          <span className="text-[9.5px] text-ink-400 dark:text-ink-300">Home</span>
        </a>
        {TOOL_LIST.map((t) => {
          const isActive = active === t.id
          return (
            <a key={t.id} href={`#/${t.id}`} className="relative flex flex-col items-center justify-center gap-0.5 py-1.5 rounded-xl min-h-[52px]" aria-current={isActive ? 'page' : undefined}>
              {isActive && (
                <motion.span
                  layoutId="mobile-active"
                  className="absolute inset-x-0.5 inset-y-0 rounded-xl bg-brass-400/12 border border-brass-400/20"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className={'relative w-8 h-8 rounded-lg flex items-center justify-center transition-colors ' + (isActive ? 'text-brass-600 dark:text-brass-300' : 'text-ink-400 dark:text-ink-300')}>
                {ICONS_MOBILE[t.id]}
              </span>
              <span className={'relative text-[9.5px] leading-none ' + (isActive ? 'text-brass-600 dark:text-brass-300 font-semibold' : 'text-ink-400 dark:text-ink-300')}>{t.name}</span>
            </a>
          )
        })}
      </div>
    </nav>
  )
}

const ICONS_MOBILE: Record<ToolId, React.ReactNode> = {
  merge: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M3 12h12M3 18h6" /></svg>
  ),
  split: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18" /><circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" /></svg>
  ),
  rearrange: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l6-5-6 5zm0 0 6 5M21 16l-6 5 6-5zm0 0-6-5" /></svg>
  ),
  rotate: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.75 1 6.4 2.6L21 8" /><path d="M21 3v5h-5" /></svg>
  ),
  compress: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M8 3l6 6m0 0V3H8m0 0v6h6" /></svg>
  ),
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}
function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}
function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}
