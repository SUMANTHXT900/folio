/**
 * DEV-only E2E handle for headless-browser verification of the rendering
 * subsystem (Lesson 12 acceptance) plus the thumbnail engine (Lesson 13).
 *
 * Everything here is lazily imported so the PDF.js runtime never enters any
 * bundle unless actually used, and this module no-ops entirely outside DEV
 * (Vite drops the branch from production builds, as with `__folioE2E`).
 * Exposes engine factories plus library diagnostics — no test UI needed.
 */

export interface RenderE2EHandle {
  /** Creates a fresh render engine (dynamically imports the PDF.js runtime). */
  createEngine: () => Promise<import('./PdfRenderEngine').PdfRenderEngine>;
  /** Creates a thumbnail engine bound to a fresh render engine. */
  createThumbnailEngines: () => Promise<{
    renders: import('./PdfRenderEngine').PdfRenderEngine;
    thumbnails: import('./PdfThumbnailEngine').PdfThumbnailEngine;
  }>;
  /** Library diagnostics: version and resolved local worker URL. */
  info: () => Promise<{ pdfjsVersion: string; workerSrc: string }>;
}

declare global {
  interface Window {
    __folioRenderE2E?: RenderE2EHandle;
  }
}

if (import.meta.env.DEV) {
  window.__folioRenderE2E = {
    createEngine: async () => {
      const { PdfJsRenderEngine } = await import('./PdfJsRenderEngine');
      return new PdfJsRenderEngine();
    },
    createThumbnailEngines: async () => {
      const { PdfJsRenderEngine } = await import('./PdfJsRenderEngine');
      const { DefaultPdfThumbnailEngine } = await import('./DefaultPdfThumbnailEngine');
      const renders = new PdfJsRenderEngine();
      const thumbnails = new DefaultPdfThumbnailEngine(renders);
      return { renders, thumbnails };
    },
    info: async () => {
      const { pdfjsVersion, pdfjsWorkerSrc } = await import('./pdfjs');
      return { pdfjsVersion: pdfjsVersion(), workerSrc: pdfjsWorkerSrc() };
    },
  };
}
