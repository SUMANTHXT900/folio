/**
 * PDF.js configuration singleton.
 *
 * Owns the only PDF.js global mutation in the application:
 * `GlobalWorkerOptions.workerSrc` pointed at the locally bundled worker
 * (`pdfjs-dist/build/pdf.worker.min.mjs?url`, emitted by Vite as a
 * same-origin asset in dev and `dist/` in production). No CDN, no remote
 * worker, no network.
 *
 * Deliberately NOT configured: `cMapUrl` / `standardFontDataUrl` are left
 * unset, so PDF.js never fetches font or CMap assets over the network.
 * Standard 14 fonts fall back to system fonts (offline-safe); documents
 * requiring Adobe CMaps (typically CJK CID fonts) will render without
 * those glyphs until a future lesson bundles the CMaps locally.
 */

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let configured = false;

/** Returns the configured PDF.js library namespace (idempotent). */
export function pdfjs(): typeof pdfjsLib {
  if (!configured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    configured = true;
  }
  return pdfjsLib;
}

/** PDF.js library version (e.g. `6.3.289`), for diagnostics and E2E. */
export function pdfjsVersion(): string {
  return pdfjs().version;
}

/** The resolved local worker asset URL (same-origin, bundled by Vite). */
export function pdfjsWorkerSrc(): string {
  pdfjs();
  return pdfjsLib.GlobalWorkerOptions.workerSrc;
}
