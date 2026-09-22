import { PDFDocument, degrees } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export type PdfFile = {
  id: string
  name: string
  size: number
  data: ArrayBuffer
}

export function makeId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function stripExt(name: string): string {
  return name.replace(/\.\w+$/, '')
}

export async function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer()
}

/* ---------- helpers: hashing + caches ---------- */

function hashBuffer(buf: ArrayBuffer): string {
  // fast non-crypto hash: FNV-ish over first/last 16k + length
  const u8 = new Uint8Array(buf)
  const len = u8.length
  let h = 2166136261 >>> 0
  const head = Math.min(len, 16384)
  for (let i = 0; i < head; i++) h = Math.imul(h ^ u8[i], 16777619)
  if (len > 32768) {
    for (let i = len - 16384; i < len; i++) h = Math.imul(h ^ u8[i], 16777619)
  }
  return `${len}-${h >>> 0}`
}

// pageCount cache keyed by buffer hash — avoids re-parsing same pdfjs doc
const pageCountCache = new Map<string, number>()

export async function pageCount(buffer: ArrayBuffer): Promise<number> {
  const key = hashBuffer(buffer)
  const cached = pageCountCache.get(key)
  if (cached !== undefined) return cached
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise
  const n = doc.numPages
  await doc.destroy()
  pageCountCache.set(key, n)
  // LRU bound: keep at most 20 entries
  if (pageCountCache.size > 20) {
    const first = pageCountCache.keys().next().value as string
    pageCountCache.delete(first)
  }
  return n
}

/** Synchronous cache read — no pdfjs load */
export function getCachedPageCount(buffer: ArrayBuffer): number | undefined {
  return pageCountCache.get(hashBuffer(buffer))
}

export function preloadPdfWorker(): void {
  // Hint browser to fetch worker early; pdfjs already sets workerSrc
  try {
    const link = document.createElement('link')
    link.rel = 'preload'
    link.as = 'script'
    link.href = workerUrl
    document.head.appendChild(link)
  } catch { /* ignore */ }
}

/* ---------- renderThumb: OffscreenCanvas path ---------- */

function createCanvas(w: number, h: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null; toDataUrl: (q: number) => Promise<string> | string } {
  // Prefer OffscreenCanvas when available (no layout thrash, worker-friendly)
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const oc = new OffscreenCanvas(w, h)
      // OffscreenCanvas getContext may return OffscreenCanvasRenderingContext2D
      const ctx = oc.getContext('2d') as unknown as CanvasRenderingContext2D | null
      return {
        canvas: oc,
        ctx,
        toDataUrl: async (q: number) => {
          // convertToBlob is async and often faster; fallback to sync path if missing
          if ('convertToBlob' in oc) {
            const blob = await (oc as any).convertToBlob({ type: 'image/jpeg', quality: q })
            return await new Promise<string>((res) => {
              const fr = new FileReader()
              fr.onload = () => res(fr.result as string)
              fr.readAsDataURL(blob)
            })
          }
          // fallback: transfer to visible canvas briefly (should not happen in modern browsers)
          const c = document.createElement('canvas')
          c.width = w; c.height = h
          const c2 = c.getContext('2d')!
          // draw not needed - caller draws on oc directly; if we reach here, use oc fallback string
          // Return empty and let caller fallback
          void c2
          return ''
        },
      }
    } catch { /* fall through to DOM canvas */ }
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  return {
    canvas,
    ctx,
    toDataUrl: (q: number) => canvas.toDataURL('image/jpeg', q),
  }
}

/** Compute a render scale that targets a specific on-screen pixel width,
 *  accounting for device pixel ratio, without ever exceeding a sane ceiling. */
function scaleForTargetWidth(nativeWidthPt: number, targetCssWidthPx: number, maxScale = 2): number {
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const targetPx = targetCssWidthPx * dpr
  return Math.max(0.2, Math.min(maxScale, targetPx / nativeWidthPt))
}

export async function renderThumb(
  buffer: ArrayBuffer,
  pageNum: number,
  scale = 0.4,
): Promise<string> {
  // load a fresh pdfjs doc per call (kept simple for single-page callers)
  // batch callers (usePageThumbs) reuse one doc — see usePageThumbs optimization
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise
  try {
    const page = await doc.getPage(pageNum)
    const viewport = page.getViewport({ scale })
    const w = Math.max(1, Math.floor(viewport.width))
    const h = Math.max(1, Math.floor(viewport.height))

    // OffscreenCanvas path
    if (typeof OffscreenCanvas !== 'undefined') {
      try {
        const oc = new OffscreenCanvas(w, h)
        const ctx = oc.getContext('2d') as unknown as CanvasRenderingContext2D | null
        if (ctx) {
          ;(ctx as any).fillStyle = '#fff'
          ctx.fillRect(0, 0, w, h)
          await page.render({ canvasContext: ctx as any, viewport }).promise
          if ('convertToBlob' in oc) {
            const blob = await (oc as any).convertToBlob({ type: 'image/jpeg', quality: 0.78 })
            const url: string = await new Promise((res) => {
              const fr = new FileReader()
              fr.onload = () => res(fr.result as string)
              fr.readAsDataURL(blob)
            })
            if (url) return url
          }
          // OffscreenCanvas fallback: no convertToBlob — fall through to DOM canvas
        }
      } catch { /* fall through */ }
    }

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    await page.render({ canvasContext: ctx, viewport }).promise
    return canvas.toDataURL('image/jpeg', 0.78)
  } finally {
    await doc.destroy()
  }
}

/* ---------- Full-res single-page render (tap-to-inspect) ---------- */
export async function renderPageFullRes(buffer: ArrayBuffer, pageNum: number): Promise<string> {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise
  try {
    const page = await doc.getPage(pageNum)
    const base = page.getViewport({ scale: 1 })
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    // ~1.6x page size is sharp for a full-screen modal; cap absolute canvas width
    const MAX_CANVAS_W = 1800
    const scale = Math.min(1.6 * dpr, MAX_CANVAS_W / base.width)
    const viewport = page.getViewport({ scale })
    const w = Math.max(1, Math.floor(viewport.width))
    const h = Math.max(1, Math.floor(viewport.height))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    await page.render({ canvasContext: ctx, viewport }).promise
    return canvas.toDataURL('image/jpeg', 0.92)
  } finally {
    await doc.destroy()
  }
}

/**
 * ThumbSession — keeps ONE pdfjs document open and renders ranges on demand.
 * Huge PDFs (1000+ pages) render only what the grid needs, instantly;
 * further ranges stream on demand without ever re-parsing the buffer.
 */
export class ThumbSession {
  private doc: pdfjsLib.PDFDocumentProxy | null = null
  private targetWidthPx: number

  constructor(private buffer: ArrayBuffer, targetWidthPx = 240) {
    this.targetWidthPx = targetWidthPx
  }

  async open(): Promise<void> {
    if (!this.doc) {
      this.doc = await pdfjsLib.getDocument({ data: new Uint8Array(this.buffer.slice(0)) }).promise
    }
  }

  get numPages(): number {
    return this.doc?.numPages ?? 0
  }

  /** Render 1-indexed inclusive range; returns map page->dataURL. */
  async range(start: number, end: number, signal?: AbortSignal): Promise<Map<number, string>> {
    await this.open()
    const out = new Map<number, string>()
    for (let n = start; n <= end; n++) {
      if (signal?.aborted) break
      if (!this.doc || n > this.doc.numPages) break
      const page = await this.doc!.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const effScale = scaleForTargetWidth(base.width, this.targetWidthPx)
      const viewport = page.getViewport({ scale: effScale })
      const w = Math.max(1, Math.floor(viewport.width))
      const h = Math.max(1, Math.floor(viewport.height))
      let dataUrl = ''
      if (typeof OffscreenCanvas !== 'undefined') {
        try {
          const oc = new OffscreenCanvas(w, h)
          const ctx = oc.getContext('2d') as unknown as CanvasRenderingContext2D | null
          if (ctx) {
            ;(ctx as any).fillStyle = '#fff'
            ctx.fillRect(0, 0, w, h)
            await page.render({ canvasContext: ctx as any, viewport }).promise
            if ('convertToBlob' in oc) {
              const blob = await (oc as any).convertToBlob({ type: 'image/webp', quality: 0.85 })
              dataUrl = await new Promise<string>((res) => {
                const fr = new FileReader()
                fr.onload = () => res(fr.result as string)
                fr.readAsDataURL(blob)
              })
            }
          }
        } catch { /* DOM fallback */ }
      }
      if (!dataUrl) {
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, w, h)
        await page.render({ canvasContext: ctx, viewport }).promise
        dataUrl = canvas.toDataURL('image/jpeg', 0.85)
      }
      out.set(n, dataUrl)
      if ((n - start) % 4 === 3) await new Promise<void>((r) => setTimeout(r, 0))
    }
    return out
  }

  async close(): Promise<void> {
    try { await this.doc?.destroy() } catch { /* noop */ }
    this.doc = null
  }
}

/**
 * Series renderer — loads the pdfjs document ONCE, then renders every requested
 * page from that single instance, reporting progress after each small chunk.
 * targetWidthPx = on-screen CSS width the thumb displays at; scale is computed
 * per-page (DPR-aware) so we render exactly enough pixels — no more.
 */
export async function renderThumbSeries(
  buffer: ArrayBuffer,
  total: number,
  targetWidthPx = 240,
  signal?: AbortSignal,
  onChunk?: (map: Map<number, string>) => void,
  startPage = 1,
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise
  try {
    const CHUNK = 3
    for (let start = startPage; start <= total; start += CHUNK) {
      if (signal?.aborted) break
      const end = Math.min(start + CHUNK - 1, total)
      const chunk = new Map<number, string>()
      for (let n = start; n <= end; n++) {
        if (signal?.aborted) break
        const page = await doc.getPage(n)
        const base = page.getViewport({ scale: 1 })
        const effScale = scaleForTargetWidth(base.width, targetWidthPx)
        const viewport = page.getViewport({ scale: effScale })
        const w = Math.max(1, Math.floor(viewport.width))
        const h = Math.max(1, Math.floor(viewport.height))

        let dataUrl = ''
        // OffscreenCanvas fast path
        if (typeof OffscreenCanvas !== 'undefined') {
          try {
            const oc = new OffscreenCanvas(w, h)
            const ctx = oc.getContext('2d') as unknown as CanvasRenderingContext2D | null
            if (ctx) {
              ;(ctx as any).fillStyle = '#fff'
              ctx.fillRect(0, 0, w, h)
              await page.render({ canvasContext: ctx as any, viewport }).promise
              if ('convertToBlob' in oc) {
                const blob = await (oc as any).convertToBlob({ type: 'image/webp', quality: 0.85 })
                dataUrl = await new Promise<string>((res) => {
                  const fr = new FileReader()
                  fr.onload = () => res(fr.result as string)
                  fr.readAsDataURL(blob)
                })
              }
            }
          } catch { /* DOM fallback */ }
        }
        if (!dataUrl) {
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')!
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, w, h)
          await page.render({ canvasContext: ctx, viewport }).promise
          dataUrl = canvas.toDataURL('image/jpeg', 0.85)
        }
        chunk.set(n, dataUrl)
      }
      for (const [k, v] of chunk) out.set(k, v)
      onChunk?.(chunk)
      // brief yield so React can paint arriving thumbs without blocking input
      await new Promise<void>((r) => setTimeout(r, 0))
    }
  } finally {
    await doc.destroy()
  }
  return out
}

export async function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // keep the blob alive long enough for slow save sheets (esp. mobile)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/* Direct save via anchor — works from a real user-gesture context on
   mobile Chrome/Safari and everywhere on desktop. Never auto-invokes
   the OS share sheet (that confused users — see v1.2.1). */
export async function downloadBytes(bytes: Uint8Array, name: string): Promise<'downloaded'> {
  await downloadBlob(new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }), name)
  return 'downloaded'
}

/* Deliberate share — invoked ONLY by an explicit user tap on a Share button. */
export async function sharePdf(bytes: Uint8Array | Blob, name: string): Promise<'shared' | 'unavailable'> {
  const nav = navigator as Navigator & {
    canShare?: (d: { files?: File[] }) => boolean
    share?: (d: { files?: File[]; title?: string }) => Promise<void>
  }
  if (!nav.share || !nav.canShare) return 'unavailable'
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' })
  const file = new File([blob], name, { type: 'application/pdf' })
  if (!nav.canShare({ files: [file] })) return 'unavailable'
  try {
    await nav.share({ files: [file], title: name })
    return 'shared'
  } catch {
    return 'unavailable'
  }
}

/* Can this device show a share sheet with files? (used to render Share buttons) */
export function shareAvailable(): boolean {
  const nav = navigator as Navigator & {
    canShare?: (d: { files?: File[] }) => boolean
  }
  try {
    return !!nav.canShare && nav.canShare({ files: [new File([new Blob(['x'])], 't.pdf', { type: 'application/pdf' })] })
  } catch {
    return false
  }
}

/* ---------- Merge ---------- */
export async function mergePdfs(
  files: ArrayBuffer[],
  onProgress?: (stage: string, fileIndex?: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    onProgress?.(`Reading file ${i + 1} of ${files.length}…`, i)
    const src = await PDFDocument.load(files[i], { ignoreEncryption: true })
    onProgress?.(`Copying pages from file ${i + 1}…`, i)
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((p) => out.addPage(p))
    // yield so the UI can paint stage updates
    await new Promise((r) => setTimeout(r, 0))
  }
  onProgress?.('Building output PDF…')
  return out.save()
}

/* ---------- Split / Extract ranges ---------- */
export type PageRange = [number, number] // 1-indexed inclusive

export async function splitRanges(
  buffer: ArrayBuffer,
  ranges: PageRange[],
): Promise<{ bytes: Uint8Array; range: PageRange }[]> {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const total = src.getPageCount()
  const results: { bytes: Uint8Array; range: PageRange }[] = []
  for (const [a, b] of ranges) {
    const indices: number[] = []
    const start = Math.max(1, a)
    const end = Math.min(b, total)
    for (let i = start; i <= end; i++) indices.push(i - 1)
    if (indices.length === 0) continue
    const doc = await PDFDocument.create()
    const pages = await doc.copyPages(src, indices)
    pages.forEach((p) => doc.addPage(p))
    results.push({ bytes: await doc.save(), range: [start, end] })
  }
  return results
}

export async function splitEveryN(
  buffer: ArrayBuffer,
  pagesPerFile: number,
): Promise<{ bytes: Uint8Array; range: PageRange }[]> {
  // avoid double pdfjs load: get count via pdf-lib (already need it for splitRanges)
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const total = src.getPageCount()
  // prime cache
  pageCountCache.set(hashBuffer(buffer), total)
  const ranges: PageRange[] = []
  for (let start = 1; start <= total; start += pagesPerFile) {
    ranges.push([start, Math.min(start + pagesPerFile - 1, total)])
  }
  return splitRanges(buffer, ranges)
}

/* ---------- Remove selected pages (keep the rest) ---------- */
export async function removePages(
  buffer: ArrayBuffer,
  keep: number[], // 0-based page indices to keep, in order
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const out = await PDFDocument.create()
  for (const idx of keep) {
    if (idx < 0 || idx >= doc.getPageCount()) continue
    const [copied] = await out.copyPages(doc, [idx])
    out.addPage(copied)
  }
  if (out.getPageCount() === 0) throw new Error('Keep at least one page')
  return out.save()
}

/* ---------- Rearrange ---------- */
export async function reorderPages(
  buffer: ArrayBuffer,
  order: number[], // 0-indexed target page numbers, in desired sequence
): Promise<Uint8Array> {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const doc = await PDFDocument.create()
  const pages = await doc.copyPages(src, order)
  pages.forEach((p) => doc.addPage(p))
  return doc.save()
}

/* ---------- Rotate ---------- */
export async function rotateOnePage(
  buffer: ArrayBuffer,
  pageIndex: number,
  deltaDeg = 90,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const page = doc.getPage(pageIndex)
  const cur = page.getRotation().angle
  page.setRotation(degrees(cur + deltaDeg))
  return doc.save()
}

export async function rotateAllPages(
  buffer: ArrayBuffer,
  deltaDeg: number,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true })
  for (const page of doc.getPages()) {
    const cur = page.getRotation().angle
    page.setRotation(degrees(cur + deltaDeg))
  }
  return doc.save()
}

/* ---------- Apply rotation map (page index -> net clockwise increments) ---------- */
export async function applyRotations(
  buffer: ArrayBuffer,
  rotations: Record<number, number>,
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const pages = doc.getPages()
  for (const [idx, turns] of Object.entries(rotations)) {
    const t = ((turns % 4) + 4) % 4
    if (t === 0) continue
    const page = pages[parseInt(idx, 10)]
    if (!page) continue
    const cur = page.getRotation().angle
    page.setRotation(degrees(cur + t * 90))
  }
  const out = await doc.save()
  return out.buffer.slice(0) as ArrayBuffer
}

/* ---------- Compress (rasterize to JPEG) ---------- */
export async function compressPdf(
  buffer: ArrayBuffer,
  quality: number, // 0..1 JPEG quality
  targetWidth: number, // max output width in px; never upscales
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const src = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise
  const outPdf = await PDFDocument.create()
  const total = src.numPages
  try {
    for (let i = 1; i <= total; i++) {
      const page = await src.getPage(i)
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(1, targetWidth / base.width) // never upscale -> avoids growth
      const viewport = page.getViewport({ scale })
      const w = Math.floor(viewport.width)
      const h = Math.floor(viewport.height)

      // OffscreenCanvas + arrayBuffer path — no blocking base64 round-trip
      let bytes: Uint8Array
      if (typeof OffscreenCanvas !== 'undefined') {
        const oc = new OffscreenCanvas(w, h)
        const ctx = oc.getContext('2d') as unknown as CanvasRenderingContext2D
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, w, h)
        await page.render({ canvasContext: ctx as any, viewport }).promise
        const blob = await (oc as any).convertToBlob({ type: 'image/jpeg', quality })
        bytes = new Uint8Array(await (blob as Blob).arrayBuffer())
      } else {
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, w, h)
        await page.render({ canvasContext: ctx, viewport }).promise
        bytes = Uint8Array.from(atob(canvas.toDataURL('image/jpeg', quality).split(',')[1]), (c) => c.charCodeAt(0))
      }

      const img = await outPdf.embedJpg(bytes)
      const p = outPdf.addPage([viewport.width, viewport.height])
      p.drawImage(img, { x: 0, y: 0, width: viewport.width, height: viewport.height })
      onProgress?.(i, total)
      // yield to the event loop so the UI can paint the progress bar
      await new Promise((r) => setTimeout(r, 0))
    }
  } finally {
    await src.destroy()
  }
  return outPdf.save()
}
