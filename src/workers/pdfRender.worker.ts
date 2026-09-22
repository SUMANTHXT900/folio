/// <reference lib="webworker" />
/**
 * pdfRender.worker — moves ALL pdf.js rasterization off the main thread.
 *
 * Protocol (postMessage):
 *   → { type:'init', id, buffer }                 (buffer transferred)
 *   → { type:'range', id, reqId, start, end, width }
 *   → { type:'preview', id, reqId, page, maxW }
 *   → { type:'close', id }
 *
 * Replies:
 *   ← { type:'ready', id }
 *   ← { type:'thumbs', id, reqId, map: [[page, blob], ...], done?: [start,end] }
 *   ← { type:'preview', id, reqId, blob }
 *   ← { type:'error', id, reqId?, message }
 *
 * Blobs are posted (structured clone, cheap) — main thread wraps them in
 * URL.createObjectURL, so no base64 ever crosses a thread boundary (#15).
 */
import * as pdfjsLib from 'pdfjs-dist'
// resolve the pdf.js engine worker to a real asset URL (Vite ?url) —
// inside OUR worker, pdf.js runs as a "fake worker" on this same thread,
// which is fine: this whole thread is already off the main UI thread.
import pdfJsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfJsWorkerUrl

type DocEntry = { doc: pdfjsLib.PDFDocumentProxy }
const docs = new Map<number, DocEntry>()

function targetScale(baseWidthPt: number, cssWidthPx: number): number {
  const dpr = Math.min(2, Math.max(1, (self as any).devicePixelRatio || 1))
  return Math.max(0.2, Math.min(2, (cssWidthPx * dpr) / baseWidthPt))
}

async function renderPage(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  cssWidthPx: number,
  quality = 0.85,
): Promise<Blob | null> {
  const page = await doc.getPage(pageNum)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.max(0.2, Math.min(2, (cssWidthPx * ((self as any).devicePixelRatio || 1)) / base.width))
  const viewport = page.getViewport({ scale })
  const w = Math.max(1, Math.floor(viewport.width))
  const h = Math.max(1, Math.floor(viewport.height))

  const oc = new OffscreenCanvas(w, h)
  const ctx = oc.getContext('2d') as unknown as CanvasRenderingContext2D | null
  if (!ctx) return null
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  await page.render({ canvasContext: ctx as any, viewport }).promise
  return await (oc as any).convertToBlob({ type: 'image/webp', quality })
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data
  try {
    if (msg.type === 'init') {
      const doc = await pdfjsLib.getDocument({
        data: new Uint8Array(msg.buffer),
        isEvalSupported: false,
      }).promise
      docs.set(msg.id, { doc })
      ;(self as any).postMessage({ type: 'ready', id: msg.id, numPages: doc.numPages })
      return
    }

    if (msg.type === 'range') {
      const entry = docs.get(msg.id)
      if (!entry) throw new Error('document not open')
      const out: [number, Blob][] = []
      for (let n = msg.start; n <= msg.end; n++) {
        if (n > entry.doc.numPages) break
        const blob = await renderPage(entry.doc, n, msg.width)
        if (blob) out.push([n, blob])
        // yield so queued messages (cancel etc.) get processed
        if ((n - msg.start) % 6 === 5) await new Promise((r) => setTimeout(r, 0))
      }
      ;(self as any).postMessage({ type: 'thumbs', id: msg.id, reqId: msg.reqId, map: out, done: [msg.start, msg.end] })
      return
    }

    if (msg.type === 'preview') {
      const entry = docs.get(msg.id)
      if (!entry) throw new Error('document not open')
      // sharp full-screen render: target modal width × DPR, capped
      const MAXW = 1800
      const dpr = Math.min(2, Math.max(1, (self as any).devicePixelRatio || 1))
      const page = await entry.doc.getPage(msg.page)
      const base = page.getViewport({ scale: 1 })
      const cssW = Math.min(MAXW / dpr, 900)
      void cssW
      const scale = Math.min(1.6 * dpr, MAXW / base.width)
      const viewport = page.getViewport({ scale })
      const w = Math.floor(viewport.width)
      const h = Math.floor(viewport.height)
      const oc = new OffscreenCanvas(w, h)
      const ctx = oc.getContext('2d') as unknown as CanvasRenderingContext2D
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, w, h)
      await page.render({ canvasContext: ctx as any, viewport }).promise
      const blob = await (oc as any).convertToBlob({ type: 'image/jpeg', quality: 0.92 })
      ;(self as any).postMessage({ type: 'preview', id: msg.id, reqId: msg.reqId, blob })
      return
    }

    if (msg.type === 'close') {
      const entry = docs.get(msg.id)
      if (entry) {
        try { await entry.doc.destroy() } catch { /* noop */ }
        docs.delete(msg.id)
      }
    }
  } catch (e: any) {
    ;(self as any).postMessage({ type: 'error', id: msg?.id, reqId: msg?.reqId, message: String(e?.message || e) })
  }
}
