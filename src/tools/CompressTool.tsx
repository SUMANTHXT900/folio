import { useEffect, useRef, useState } from 'react'
import { ToolHeading, DropZone, FileChip, Button, Card, Progress, formatBytes } from '../components/ui'
import { usePdfFiles } from '../hooks/usePdfFiles'
import { compressPdf } from '../lib/pdf'

const LEVELS = [
  { label: 'Best quality', quality: 0.85, targetWidth: 1240, hint: 'Minimal size reduction, crisp output' },
  { label: 'Balanced', quality: 0.6, targetWidth: 1000, hint: 'Good balance of size and clarity' },
  { label: 'Maximum compression', quality: 0.4, targetWidth: 800, hint: 'Smallest file, lower fidelity' },
] as const

export default function CompressTool() {
  const { files, setFiles, addFiles, busy, setBusy, error, setError } = usePdfFiles()
  const file = files[0] ?? null
  const [level, setLevel] = useState<number>(1)
  const [result, setResult] = useState<{ url: string; name: string; saved: number } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null)
  const resultUrlRef = useRef<string | null>(null)

  // revoke previous result URL when replaced or on unmount (blob leak fix)
  useEffect(() => () => { if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current) }, [])

  async function handleCompress() {
    if (!file) return
    setBusy(true)
    setError(null)
    setResult(null)
    setNote(null)
    setProg({ done: 0, total: 0 })
    try {
      const buf = file.data
      const inputBytes = buf.byteLength
      const { quality, targetWidth } = LEVELS[level]
      const out = await compressPdf(buf, quality, targetWidth, (done, total) => setProg({ done, total }))
      const outBytes = out.byteLength
      if (outBytes >= inputBytes) {
        // Compression did not help (e.g. text-only PDF or already-optimized).
        // Keep the original rather than shipping a larger file.
        const blob = new Blob([buf], { type: 'application/pdf' })
        const url = URL.createObjectURL(blob)
        resultUrlRef.current = url
        setResult({ url, name: file.name.replace(/\.pdf$/i, '') + '-compressed.pdf', saved: 0 })
        setNote('This PDF is already compact (mostly text or well-optimized), so re-compressing would make it larger. Your original file is kept unchanged.')
      } else {
        const blob = new Blob([out as unknown as BlobPart], { type: 'application/pdf' })
        const url = URL.createObjectURL(blob)
        resultUrlRef.current = url
        setResult({ url, name: file.name.replace(/\.pdf$/i, '') + '-compressed.pdf', saved: Math.round((1 - outBytes / inputBytes) * 100) })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Compression failed')
    } finally {
      setBusy(false)
    }
  }

  const saved = result?.saved ?? 0

  return (
    <div className="py-6">
      <ToolHeading icon={<CompressIcon />} name="Compress" desc="Shrink file size by re-rendering pages" />

      {!file && (
        <DropZone accept="application/pdf" multiple={false} onFiles={(f) => addFiles(f)} title="Drop a PDF to compress" cta="Select PDF" />
      )}

      {file && (
        <div className="space-y-5">
          <FileChip name={file.name} size={file.size} onRemove={() => { setFiles([]); setResult(null); setNote(null) }} />

          <Card>
            <p className="text-sm font-medium text-ink-700 dark:text-paper-100 mb-3">Compression level</p>
            <div className="grid gap-2">
              {LEVELS.map((lv, i) => (
                <button
                  key={lv.label}
                  onClick={() => setLevel(i)}
                  className={
                    'flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors ' +
                    (level === i
                      ? 'border-brass-400 bg-brass-400/10'
                      : 'border-paper-300 dark:border-ink-700 hover:border-brass-400/60')
                  }
                >
                  <span>
                    <span className="block text-sm font-medium text-ink-900 dark:text-paper-100">{lv.label}</span>
                    <span className="block text-xs text-ink-400 dark:text-ink-300">{lv.hint}</span>
                  </span>
                  <span className={'w-4 h-4 rounded-full border ' + (level === i ? 'border-brass-500 bg-brass-500' : 'border-paper-300 dark:border-ink-600')} />
                </button>
              ))}
            </div>
          </Card>

          {!result && (
            <>
              <Button onClick={handleCompress} disabled={busy} className="w-full">
                {busy ? 'Compressing…' : 'Compress'}
              </Button>
              {busy && prog && prog.total > 0 && (
                <Progress value={(prog.done / prog.total) * 100} label={`Rendering page ${prog.done} of ${prog.total}`} />
              )}
            </>
          )}

          {note && (
            <p className="text-sm text-ink-400 dark:text-ink-300 bg-paper-100 dark:bg-ink-800/60 rounded-xl px-4 py-3 border border-paper-200 dark:border-ink-700">
              {note}
            </p>
          )}

          {result && (
            <Card>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-ink-900 dark:text-paper-100">Done</span>
                <span className={'text-xs font-mono ' + (saved > 0 ? 'text-forest-600 dark:text-forest-400' : 'text-ink-400 dark:text-ink-300')}>
                  {saved > 0 ? `−${saved}%` : 'no reduction'}
                </span>
              </div>
              <a href={result.url} download={result.name} className="inline-flex items-center gap-2 rounded-lg bg-ink-900 dark:bg-paper-100 text-paper-100 dark:text-ink-900 px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity">
                Download compressed PDF
              </a>
            </Card>
          )}
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
    </div>
  )
}

function CompressIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M8 3l6 6m0 0V3H8m0 0v6h6" />
    </svg>
  )
}
