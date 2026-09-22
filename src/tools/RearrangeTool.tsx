import { useEffect, useState, useMemo, memo, useCallback } from 'react'
import { Reorder } from 'framer-motion'
import { ToolHeading, DropZone, FileChip, Button, Spinner, Card, DoneBanner, Progress } from '../components/ui'
import { usePdfFiles } from '../hooks/usePdfFiles'
import { usePageThumbs } from '../hooks/usePageThumbs'
import { reorderPages, shareAvailable } from '../lib/pdf'

const PAGE_LIMIT = 24

const RearrangeRow = memo(function RearrangeRow({ pageIdx, pos, thumb, onMoveUp, onMoveDown, onPreview, isFirst, isLast }: { pageIdx: number; pos: number; thumb: string; onMoveUp: () => void; onMoveDown: () => void; onPreview: () => void; isFirst: boolean; isLast: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-800/60 px-3 py-2">
      <span className="w-6 text-center text-xs font-mono text-ink-400">{pos + 1}</span>
      <button onClick={onPreview} className="flex-1 flex items-center gap-3 text-left">
        {thumb ? (
          <img src={thumb} alt={`Page ${pageIdx + 1}`} loading="lazy" decoding="async" className="w-10 h-14 object-cover rounded border border-paper-300 dark:border-ink-700" />
        ) : (
          <div className="w-10 h-14 rounded bg-paper-200 dark:bg-ink-700 animate-pulse" />
        )}
        <span className="text-sm text-ink-700 dark:text-paper-100">Page {pageIdx + 1}</span>
      </button>
      <div className="flex flex-col">
        <button onClick={onMoveUp} disabled={isFirst} className="px-1.5 py-0.5 text-ink-400 hover:text-brass-500 disabled:opacity-30" aria-label="Move up">↑</button>
        <button onClick={onMoveDown} disabled={isLast} className="px-1.5 py-0.5 text-ink-400 hover:text-brass-500 disabled:opacity-30" aria-label="Move down">↓</button>
      </div>
    </div>
  )
})

export default function RearrangeTool() {
  const { files, setFiles, addFiles, error, busy, setBusy, setError } = usePdfFiles()
  const file = files[0] ?? null
  const { thumbs, load, fillAll, loading, progress, renderPreview } = usePageThumbs()
  const [order, setOrder] = useState<number[]>([])
  const [result, setResult] = useState<{ name: string; blob: Blob } | null>(null)
  const [viewer, setViewer] = useState<number | null>(null)
  const [hiRes, setHiRes] = useState<Record<number, string>>({})

  // render the inspected page at full res IN THE WORKER (cached per page)
  useEffect(() => {
    if (viewer === null || !file) return
    const pageNum = order[viewer] + 1
    if (hiRes[pageNum]) return
    let cancelled = false
    ;(async () => {
      try {
        const url = await renderPreview(file.data, pageNum)
        if (!cancelled) setHiRes((prev) => ({ ...prev, [pageNum]: url }))
      } catch { /* keep thumb fallback */ }
    })()
    return () => { cancelled = true }
  }, [viewer, file, order, hiRes, renderPreview])
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    setResult(null)
    setShowAll(false)
    if (!file) { setOrder([]); return }
    let cancelled = false
    ;(async () => {
      const buf = file.data
      const t = await load(buf, PAGE_LIMIT)
      if (!cancelled) setOrder(Array.from({ length: t.length }, (_, i) => i))
    })()
    return () => { cancelled = true }
  }, [file, load])
  const visibleOrder = useMemo(() => {
    if (order.length <= 30 || showAll) return order
    return order.slice(0, PAGE_LIMIT)
  }, [order, showAll])
  const hiddenCount = order.length - visibleOrder.length

  const handleRearrange = useCallback(async () => {
    if (!file) return
    setBusy(true); setError(null); setResult(null)
    try {
      const buf = file.data
      const out = await reorderPages(buf, order)
      const blob = new Blob([out as unknown as BlobPart], { type: 'application/pdf' })
      setResult({ name: file.name.replace(/\.pdf$/i, '') + '-rearranged.pdf', blob })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rearrange failed')
    } finally { setBusy(false) }
  }, [file, order, setBusy, setError])

  const move = useCallback((idx: number, dir: -1 | 1) => {
    setOrder((prev) => {
      const next = [...prev]
      const j = idx + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }, [])

  return (
    <div className="py-6">
      <ToolHeading icon={<RearrangeIcon />} name="Rearrange" desc="Drag to reorder, or use the arrows — click a page to preview it" />

      {!file && (
        <DropZone accept="application/pdf" multiple={false} onFiles={(f) => addFiles(f)} title="Drop a PDF to rearrange" cta="Select PDF" />
      )}

      {file && (
        <div className="space-y-5">
          <FileChip name={file.name} size={file.size} onRemove={() => { setFiles([]); setResult(null) }} />

          {loading && (
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center gap-2 text-sm text-ink-400"><Spinner /> Rendering page previews…</div>
              {progress && progress.total > 0 && progress.done < progress.total && (
                <div className="w-full max-w-xs"><Progress value={(progress.done / progress.total) * 100} label={`${progress.done} of ${progress.total} pages`} /></div>
              )}
            </div>
          )}

          {!loading && order.length > 0 && (
            <Card>
              <p className="text-sm font-medium text-ink-700 dark:text-paper-100 mb-3">Drag, click to preview, or use arrows</p>
              <Reorder.Group axis="y" values={order} onReorder={setOrder} className="space-y-2">
                {visibleOrder.map((pageIdx, i) => (
                  <Reorder.Item key={pageIdx} value={pageIdx} className="list-none">
                    <RearrangeRow
                      pageIdx={pageIdx}
                      pos={i}
                      thumb={thumbs[pageIdx]}
                      onMoveUp={() => move(i, -1)}
                      onMoveDown={() => move(i, 1)}
                      onPreview={() => setViewer(i)}
                      isFirst={i === 0}
                      isLast={i === order.length - 1}
                    />
                  </Reorder.Item>
                ))}
              </Reorder.Group>
              {hiddenCount > 0 && (
                <button onClick={() => { setShowAll(true); if (file) void load(file.data) }} className="mt-3 w-full rounded-xl border-2 border-dashed border-paper-300 dark:border-ink-700 py-3 text-sm text-ink-500 hover:border-brass-400 hover:text-brass-600 transition-colors">
                  {thumbs.filter(Boolean).length < order.length ? `Load & show ${Math.min(hiddenCount, 48)} more of ${hiddenCount}` : `Show ${hiddenCount} more pages`}
                </button>
              )}
              {hiddenCount === 0 && order.length > 30 && showAll && (
                <button onClick={() => setShowAll(false)} className="mt-3 text-xs text-ink-400 hover:text-ink-700">Show less</button>
              )}
            </Card>
          )}

          {!result && order.length > 0 && (
            <Button onClick={handleRearrange} disabled={busy} className="w-full">
              {busy ? <Spinner /> : 'Save rearranged PDF'}
            </Button>
          )}

          {result && (
            <DoneBanner name={result.name} blob={result.blob} shareable={shareAvailable()} />
          )}
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}

      {viewer !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setViewer(null)}
        >
          <div className="max-w-3xl w-full max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2 text-paper-100 shrink-0">
              <span className="font-display text-lg">Page {order[viewer] + 1}</span>
              <button onClick={() => setViewer(null)} className="rounded-full bg-white/10 px-3 py-1 text-sm hover:bg-white/20">Close</button>
            </div>
            {(() => {
              const pageNum = order[viewer] + 1
              const hi = hiRes[pageNum]
              const fallback = thumbs[order[viewer]]
              return hi ? (
                <img src={hi} alt={`Page ${pageNum} (full resolution)`} className="w-full rounded-xl shadow-2xl bg-white object-contain max-h-[82vh]" />
              ) : (
                <>
                  {fallback && <img src={fallback} alt={`Page ${pageNum}`} className="w-full rounded-xl shadow-2xl bg-white opacity-80" />}
                  {!fallback && <div className="h-64 rounded-xl bg-white/20 animate-pulse" />}
                  <p className="mt-2 text-center text-xs text-paper-100/80">Rendering full-resolution view…</p>
                </>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
function RearrangeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8l6-5-6 5zm0 0 6 5M21 16l-6 5 6-5zm0 0-6-5" />
    </svg>
  )
}
