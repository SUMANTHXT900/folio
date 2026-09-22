import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCachedPageCount, pageCount, renderThumbSeries } from '../lib/pdf'
// Vite worker import — separate bundle, instantiated lazily
import PdfRenderWorker from '../workers/pdfRender.worker?worker'

// ---------- hash + global cache ----------
function hashBuffer(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf)
  const len = u8.length
  let h = 2166136261 >>> 0
  const head = Math.min(len, 16384)
  for (let i = 0; i < head; i++) h = Math.imul(h ^ u8[i], 16777619)
  if (len > 32768) for (let i = len - 16384; i < len; i++) h = Math.imul(h ^ u8[i], 16777619)
  return `${len}-${h >>> 0}`
}

/**
 * Blob-URL thumbnail cache (#15) with an LRU (#16).
 * Entries store object URLs; eviction revokes them.
 */
const thumbCache = new Map<string, string[]>() // key -> array of object URLs ('' = hole)
const MAX_CACHE_ENTRIES = 6
const liveUrls = new Set<string>()

function makeThumbUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob)
  liveUrls.add(url)
  return url
}
function revokeUrl(url: string) {
  if (!url) return
  URL.revokeObjectURL(url)
  liveUrls.delete(url)
}
function getCache(key: string): string[] | undefined {
  const v = thumbCache.get(key)
  if (v) {
    // LRU touch
    thumbCache.delete(key)
    thumbCache.set(key, v)
  }
  return v
}
function setCache(key: string, val: string[]) {
  thumbCache.set(key, val)
  while (thumbCache.size > MAX_CACHE_ENTRIES) {
    const first = thumbCache.keys().next().value as string
    const evicted = thumbCache.get(first)
    thumbCache.delete(first)
    evicted?.forEach(revokeUrl)
  }
}

/** Pages rendered in the blocking first phase — matches grid PAGE_LIMIT. */
export const THUMB_INITIAL = 24

// ---------- hook ----------
export function usePageThumbs() {
  const [thumbs, setThumbs] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const workerRef = useRef<Worker | null>(null)
  const docIdRef = useRef(0)
  const reqRef = useRef(0)
  const pendingRef = useRef<Map<number, (m: any) => void>>(new Map())

  const memoizedThumbs = useMemo(() => thumbs, [thumbs])

  /** Ensure the worker exists and has this buffer open. Resolves numPages.
   *  Rejects on timeout/error so callers can fall back to main-thread rendering. */
  const ensureDoc = useCallback(async (buffer: ArrayBuffer): Promise<{ id: number; numPages: number }> => {
    if (!workerRef.current) {
      const w = new PdfRenderWorker()
      w.onerror = (e) => {
        // surface worker load failures visibly; reject ALL pending promises
        console.error('[pdfRender] worker error:', e.message || e)
        for (const [k, resolver] of [...pendingRef.current]) {
          pendingRef.current.delete(k)
        }
      }
      w.onmessage = (ev: MessageEvent) => {
        const msg = ev.data
        // ignore foreign protocol messages (e.g. pdf.js internal handshake)
        if (msg == null || typeof msg !== 'object' || msg.type == null) return
        const resolver = pendingRef.current.get(msg.reqId ?? -1)
        if (resolver) {
          pendingRef.current.delete(msg.reqId ?? -1)
          resolver(msg)
        }
      }
      workerRef.current = w
    }
    const id = ++docIdRef.current
    const reqId = ++reqRef.current
    const copy = buffer.slice(0)
    const p = new Promise<any>((resolve, reject) => {
      pendingRef.current.set(reqId, (m: any) => {
        if (m.type === 'error') reject(new Error(m.message))
        else resolve(m)
      })
      setTimeout(() => {
        if (pendingRef.current.has(reqId)) {
          pendingRef.current.delete(reqId)
          reject(new Error('worker init timeout'))
        }
      }, 8000) // fail fast → caller falls back to main thread
    })
    // transfer the copy — zero-copy handoff
    workerRef.current.postMessage({ type: 'init', id, buffer: copy }, [copy])
    const msg = await p
    return { id, numPages: msg.numPages as number }
  }, [])

  /** Render one range in the worker. Resolves map page→objectURL. */
  const renderRange = useCallback(async (
    id: number,
    start: number,
    end: number,
    width = 240,
    signal?: AbortSignal,
  ): Promise<Map<number, string>> => {
    const w = workerRef.current
    if (!w || signal?.aborted) return new Map()
    const reqId = ++reqRef.current
    const p = new Promise<Map<number, string>>((resolve, reject) => {
      pendingRef.current.set(reqId, (m: any) => {
        if (m.type === 'error') reject(new Error(m.message))
        else if (m.type === 'thumbs') {
          const out = new Map<number, string>()
          for (const [n, blob] of m.map as [number, Blob][]) out.set(n, makeThumbUrl(blob))
          resolve(out)
        }
      })
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    w.postMessage({ type: 'range', id, reqId, start, end, width })
    return p
  }, [])

  /** Full-res preview blob URL via worker. Caller owns revocation. */
  const renderPreview = useCallback(async (buffer: ArrayBuffer, pageNum: number): Promise<string> => {
    const { id } = await ensureDoc(buffer)
    const w = workerRef.current!
    const reqId = ++reqRef.current
    const p = new Promise<string>((resolve, reject) => {
      pendingRef.current.set(reqId, (m: any) => {
        if (m.type === 'error') reject(new Error(m.message))
        else if (m.type === 'preview') resolve(makeThumbUrl(m.blob))
      })
    })
    w.postMessage({ type: 'preview', id, reqId, page: pageNum })
    return p
  }, [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    const w = workerRef.current
    if (w) {
      if (docIdRef.current) w.postMessage({ type: 'close', id: docIdRef.current })
      docIdRef.current = 0
    }
  }, [])

  useEffect(() => () => stop(), [stop])

  /**
   * Phase 1 only: open doc in WORKER, render first wave, resolve.
   * Remaining pages fill on a detached loop (never awaited by tools).
   */
  const load = useCallback(async (buffer: ArrayBuffer, initialCount: number = THUMB_INITIAL): Promise<string[]> => {
    const key = hashBuffer(buffer)

    const cached = getCache(key)
    if (cached) {
      setThumbs(cached)
      setLoading(false)
      setProgress(null)
      return cached
    }

    stop()
    const ac = new AbortController()
    abortRef.current = ac

    setLoading(true)
    setProgress({ done: 0, total: 0 })
    // Track which engine we used so backgroundFill matches it
    let workerFailed = false
    try {
      let total: number
      let map: Map<number, string>
      try {
        const { numPages } = await ensureDoc(buffer)
        total = numPages
      } catch (e) {
        // WORKER UNAVAILABLE → fall back to proven main-thread series renderer
        console.warn('[thumbs] worker unavailable, using main thread:', (e as Error).message)
        workerFailed = true
        const cachedCount = getCachedPageCount(buffer)
        total = cachedCount !== undefined ? cachedCount : await pageCount(buffer)
      }
      if (abortRef.current?.signal.aborted) return []

      const arr: string[] = new Array(total).fill('')
      setThumbs([...arr])
      setProgress({ done: 0, total })

      if (workerFailed) {
        // Main-thread fallback (v1.4.0 path — known good)
        const first = Math.min(initialCount, total)
        await renderThumbSeries(buffer, first, 240, ac.signal, (chunk) => {
          for (const [p2, url] of chunk) arr[p2 - 1] = url
          if (!ac.signal.aborted) {
            setThumbs([...arr])
            setProgress({ done: arr.filter(Boolean).length, total })
          }
        })
        setLoading(false)
        if (first < total && !ac.signal.aborted) {
          void (async () => {
            // background fill on main thread, idle-paced
            const CHUNK = 6
            let s = first + 1
            try {
              while (s <= total && !ac.signal.aborted) {
                await new Promise((r) => setTimeout(r, 60))
                if (ac.signal.aborted) return
                const e2 = Math.min(s + CHUNK - 1, total)
                // NOTE: renderThumbSeries(buffer, END, ..., startPage) — 2nd arg
                // is the loop CEILING, so pass e2 (not total)
                const m2 = await renderThumbSeries(buffer, e2, 240, ac.signal, undefined, s)
                for (const [p3, url] of m2) arr[p3 - 1] = url
                setThumbs([...arr])
                setProgress({ done: arr.filter(Boolean).length, total })
                s = e2 + 1
              }
              if (!ac.signal.aborted && arr.every(Boolean)) setCache(key, [...arr])
            } catch { /* aborted */ }
          })()
        } else if (arr.every(Boolean)) setCache(key, [...arr])
        return arr
      }

      // Worker path
      const first = Math.min(initialCount, total)
      map = await renderRange(docIdRef.current, 1, first, 240, ac.signal)
      for (const [p2, url] of map) arr[p2 - 1] = url
      setThumbs([...arr])
      setLoading(false)

      if (first < total && !ac.signal.aborted) {
        setProgress({ done: map.size, total })
        void backgroundFill(key, arr, ac, total, first + 1)
      } else {
        setProgress(null)
        if (arr.every(Boolean)) setCache(key, [...arr])
      }
      return arr
    } catch (e: any) {
      if (e?.name === 'AbortError') return []
      throw e
    }
  }, [stop])

  /** Detached idle-ish background fill. Never awaited by tools. */
  const backgroundFill = useCallback(async (
    key: string,
    arr: string[],
    ac: AbortController,
    total: number,
    startAt: number,
  ) => {
    const WAVE = 24
    let start = startAt
    try {
      while (start <= total && !ac.signal.aborted) {
        await new Promise((r) => setTimeout(r, 60)) // soft pacing
        if (ac.signal.aborted) return
        const end = Math.min(start + WAVE - 1, total)
        const map = await renderRange(docIdRef.current, start, end, 240, ac.signal)
        if (ac.signal.aborted) return
        for (const [p2, url] of map) arr[p2 - 1] = url
        setThumbs([...arr])
        setProgress({ done: arr.filter(Boolean).length, total })
        start = end + 1
      }
      if (!ac.signal.aborted && arr.every(Boolean)) {
        setCache(key, [...arr])
        setProgress(null)
      }
    } catch { /* aborted */ }
  }, [])

  /** Show All / Load more: resume ONLY missing pages. */
  const fillAll = useCallback(async (): Promise<void> => {
    setThumbs((prevArr) => {
      const holes = prevArr.some((v) => !v)
      if (!holes) return prevArr
      ;(async () => {
        const CHUNK = 24
        let s = prevArr.findIndex((v) => !v) + 1
        const total = prevArr.length
        while (s <= total && !(abortRef.current?.signal.aborted)) {
          const e2 = Math.min(s + CHUNK - 1, total)
          try {
            const map = await renderRange(docIdRef.current, s, e2, 240, abortRef.current?.signal)
            for (const [p2, url] of map) prevArr[p2 - 1] = url
            setThumbs([...prevArr])
            s = e2 + 1
          } catch { return }
        }
      })()
      return prevArr
    })
  }, [])

  const cancel = useCallback(() => {
    stop()
    setLoading(false)
    setProgress(null)
  }, [stop])

  return { thumbs: memoizedThumbs, load, fillAll, loading, progress, cancel, renderPreview }
}

const abortRef = { current: null as AbortController | null }
