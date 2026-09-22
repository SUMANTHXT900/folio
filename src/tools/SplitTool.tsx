import { useEffect, useState, useMemo, memo, useCallback } from 'react'
import { ToolHeading, DropZone, FileChip, Button, Spinner, Card, DoneBanner, Progress } from '../components/ui'
import { usePdfFiles } from '../hooks/usePdfFiles'
import { usePageThumbs } from '../hooks/usePageThumbs'
import { removePages, splitRanges, shareAvailable } from '../lib/pdf'

const PAGE_LIMIT = 24

const ThumbTile = memo(function ThumbTile({ src, index, kept, onToggle }: { src: string; index: number; kept: boolean; onToggle: (i: number) => void }) {
  return (
    <button
      onClick={() => onToggle(index)}
      className={
        'relative rounded-lg overflow-hidden border-2 transition-all ' +
        (kept ? 'border-transparent hover:border-brass-400' : 'border-red-400/70 opacity-40')
      }
    >
      {src ? (
        <img src={src} alt={`Page ${index + 1}`} loading="lazy" decoding="async" className="w-full aspect-[3/4] object-cover bg-white" />
      ) : (
        <div className="w-full aspect-[3/4] bg-paper-200 dark:bg-ink-700 animate-pulse" />
      )}
      <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-paper-100 text-[11px] py-0.5 text-center">
        {kept ? `Page ${index + 1}` : 'removed'}
      </span>
    </button>
  )
})

export default function SplitTool() {
  const { files, setFiles, addFiles, error, busy, setBusy, setError } = usePdfFiles()
  const file = files[0] ?? null
  const { thumbs, load, fillAll, loading, progress } = usePageThumbs()
  const [count, setCount] = useState(0)
  const [keep, setKeep] = useState<boolean[]>([])
  const [mode, setMode] = useState<'pick' | 'ranges'>('pick')
  const [ranges, setRanges] = useState('')
  const [result, setResult] = useState<{ name: string; blob: Blob } | 'multi' | null>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    setResult(null)
    setShowAll(false)
    if (!file) { setKeep([]); setCount(0); return }
    let cancelled = false
    ;(async () => {
      const buf = file.data
      const { thumbs: t } = { thumbs: await load(buf, PAGE_LIMIT) }
      if (cancelled) return
      setCount(t.length)
      setKeep(new Array(t.length).fill(true))
    })()
    return () => { cancelled = true }
  }, [file, load])

  const toggle = useCallback((i: number) => {
    setKeep((prev) => prev.map((v, idx) => (idx === i ? !v : v)))
  }, [])

  const keepCount = useMemo(() => keep.filter(Boolean).length, [keep])
  const visibleThumbs = useMemo(() => {
    if (thumbs.length <= 30 || showAll) return thumbs
    return thumbs.slice(0, PAGE_LIMIT)
  }, [thumbs, showAll])
  const hiddenCount = thumbs.length - visibleThumbs.length

  async function handleCreate() {
    if (!file) return
    setBusy(true); setError(null); setResult(null)
    try {
      const buf = file.data
      if (mode === 'pick') {
        const keepIdx = keep.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)
        if (keepIdx.length === 0) throw new Error('Select at least one page to keep')
        const out = await removePages(buf, keepIdx)
        const blob = new Blob([out as unknown as BlobPart], { type: 'application/pdf' })
        setResult({ name: file.name.replace(/\.pdf$/i, '') + '-split.pdf', blob })
      } else {
        const parsed = ranges
          .split(/[,\n]/)
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p): [number, number] => {
            if (p.includes('-')) {
              const [a, b] = p.split('-').map((x) => parseInt(x, 10))
              return [a, b]
            }
            const n = parseInt(p, 10)
            return [n, n]
          })
          .filter(([a, b]) => !isNaN(a) && !isNaN(b))
        if (parsed.length === 0) throw new Error('Enter at least one page or range')
        const res = await splitRanges(buf, parsed)
        if (res.length === 1) {
          const blob = new Blob([res[0].bytes as unknown as BlobPart], { type: 'application/pdf' })
          setResult({ name: `${file.name.replace(/\.pdf$/i, '')}-p${res[0].range[0]}-${res[0].range[1]}.pdf`, blob })
        } else {
          for (const r of res) {
            const blob = new Blob([r.bytes as unknown as BlobPart], { type: 'application/pdf' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url; a.download = `${file.name.replace(/\.pdf$/i, '')}-p${r.range[0]}-${r.range[1]}.pdf`
            document.body.appendChild(a); a.click(); a.remove()
            setTimeout(() => URL.revokeObjectURL(url), 60_000)
          }
          setResult('multi')
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Split failed')
    } finally { setBusy(false) }
  }

  return (
    <div className="py-6">
      <ToolHeading icon={<SplitIcon />} name="Split" desc="Drop a PDF, then remove the pages you don't need — or extract exact ranges." />

      {!file && (
        <DropZone accept="application/pdf" multiple={false} onFiles={(f) => addFiles(f)} title="Drop a PDF to split" cta="Select PDF" />
      )}

      {file && (
        <div className="space-y-5">
          <FileChip name={file.name} size={file.size} onRemove={() => { setFiles([]); setResult(null) }} />

          <div className="flex gap-2">
            <button
              onClick={() => setMode('pick')}
              className={'flex-1 rounded-xl border px-4 py-2 text-sm transition-colors ' + (mode === 'pick' ? 'border-brass-400 bg-brass-400/10 text-ink-900 dark:text-paper-100' : 'border-paper-300 dark:border-ink-700 text-ink-400')}
            >Pick pages</button>
            <button
              onClick={() => setMode('ranges')}
              className={'flex-1 rounded-xl border px-4 py-2 text-sm transition-colors ' + (mode === 'ranges' ? 'border-brass-400 bg-brass-400/10 text-ink-900 dark:text-paper-100' : 'border-paper-300 dark:border-ink-700 text-ink-400')}
            >By ranges</button>
          </div>

          {mode === 'pick' && (
            <>
              {loading && (
                <div className="flex flex-col items-center gap-1">
                  <div className="flex items-center gap-2 text-sm text-ink-400 dark:text-ink-300"><Spinner /> Rendering pages…</div>
                  {progress && progress.total > 0 && progress.done < progress.total && (
                    <div className="w-full max-w-xs"><Progress value={(progress.done / progress.total) * 100} label={`${progress.done} of ${progress.total} pages`} /></div>
                  )}
                </div>
              )}
              {!loading && (
                <Card>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-medium text-ink-700 dark:text-paper-100">Tap a page to remove it</p>
                    <span className="text-xs font-mono tabular-nums rounded-full bg-paper-200/70 dark:bg-ink-900/60 px-2.5 py-1 text-ink-500 dark:text-ink-300">{keepCount}/{count} kept</span>
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                    {visibleThumbs.map((src, i) => (
                      <ThumbTile key={i} src={src} index={i} kept={keep[i]} onToggle={toggle} />
                    ))}
                    {hiddenCount > 0 && (
                      <button onClick={() => { setShowAll(true); void fillAll() }} className="rounded-lg border-2 border-dashed border-paper-300 dark:border-ink-700 flex flex-col items-center justify-center gap-1 aspect-[3/4] text-sm text-ink-500 hover:border-brass-400 hover:text-brass-600 transition-colors">
                        <span className="text-lg">+{hiddenCount}</span>
                        <span className="text-xs">{thumbs.filter(Boolean).length < thumbs.length ? 'Load more' : 'Show all'}</span>
                      </button>
                    )}
                  </div>
                  {thumbs.length > 30 && !showAll && (
                    <p className="text-xs text-ink-400 mt-3">Showing {PAGE_LIMIT} of {thumbs.length} pages — click “Show all” for the rest.</p>
                  )}
                  {showAll && thumbs.length > 30 && (
                    <button onClick={() => setShowAll(false)} className="mt-3 text-xs text-ink-400 hover:text-ink-700">Show less</button>
                  )}
                </Card>
              )}
            </>
          )}

          {mode === 'ranges' && (
            <Card>
              <p className="text-sm font-medium text-ink-700 dark:text-paper-100 mb-2">Pages to extract</p>
              <input
                value={ranges}
                onChange={(e) => setRanges(e.target.value)}
                placeholder="e.g. 1-3, 5, 8-10"
                className="w-full rounded-xl border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-900 px-4 py-2.5 text-sm text-ink-900 dark:text-paper-100 outline-none focus:border-brass-400"
              />
              <p className="text-xs text-ink-400 mt-2">One file per range; ranges produce multiple downloads.</p>
            </Card>
          )}

          {!result && (
            <Button onClick={handleCreate} disabled={busy} className="w-full">
              {busy ? 'Working…' : mode === 'pick' ? `Create PDF · ${keepCount} page${keepCount === 1 ? '' : 's'}` : 'Extract pages'}
            </Button>
          )}

          {result && result !== 'multi' && (
            <DoneBanner name={result.name} blob={result.blob} shareable={shareAvailable()} />
          )}

          {result === 'multi' && (
            <Card><p className="text-sm text-ink-400">Multiple files downloaded.</p></Card>
          )}
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}

      {preview !== null && thumbs[preview] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPreview(null)}>
          <img src={thumbs[preview]} alt={`Page ${preview + 1}`} className="max-w-3xl w-full rounded-xl shadow-2xl bg-white" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}

function SplitIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
    </svg>
  )
}
