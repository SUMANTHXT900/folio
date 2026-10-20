/**
 * Build-time image preparation for Images → PDF.
 *
 * Two paths:
 * - Unrotated pages take the zero-copy direct path: raw file bytes are
 *   forwarded untouched (engine EXIF/DPI handling applies as before).
 * - Rotated pages are decoded to a canvas, rotated, and re-encoded as
 *   JPEG (white-filled, q0.95 — same generation-1 quality as capture/import)
 *   REGARDLESS of source format. PNG sources
 *   must not stay PNG here: the engine embeds PNGs as uncompressed raw
 *   RGB, so a rotated screenshot would balloon ~8× versus its JPEG
 *   encoding (5-2). The engine sniffs content magic (not extensions) to
 *   pick the JPEG embed path, so the bytes stay correct downstream even
 *   though the page name keeps its original extension.
 *   Canvas output carries no EXIF, so the engine reads orientation 1
 *   and cannot double-rotate.
 *
 * The canvas renderer is injectable so the selection logic is unit
 * tested without a DOM canvas; the browser implementation lives here
 * alongside it.
 */

import type { ImagePage, ImageRotation } from './imagePages';
import {
  encodeBitmapToJpeg,
  EncodeWorkerUnavailableError,
  MAX_IMPORT_LONG_EDGE,
} from './imageImport';

export interface PreparedImage {
  name: string;
  bytes: Uint8Array;
}

/** Quarters turns the canvas path supports (0 never reaches it). */
export type NonZeroRotation = Exclude<ImageRotation, 0>;

export interface ImageRenderer {
  rotateToBytes(file: File | Blob, degrees: NonZeroRotation, mime: string): Promise<Uint8Array>;
}

/** Output MIME is always JPEG: rotated PNGs re-encoded as PNG would
 * embed downstream as uncompressed raw RGB (~8× the JPEG bytes). The
 * engine sniffs content magic (not the page-name extension) to pick
 * the JPEG embed path, so JPEG bytes under a `.png` name stay correct.
 * Quality and white-fill match the import normalization path. */
export function outputMime(_file: File | Blob): string {
  return 'image/jpeg';
}

/**
 * Pure decision: rotated canvas size for a source bitmap, clamped to the
 * shared import pixel budget (`MAX_IMPORT_LONG_EDGE`, same as gallery
 * imports) so a rotated 48MP original cannot bypass normalization at
 * build time. Aspect preserved via the swap, never upscaled. Exported for
 * unit tests.
 */
export function rotationTargetSize(
  sourceWidth: number,
  sourceHeight: number,
  degrees: NonZeroRotation,
  maxLongEdge: number = MAX_IMPORT_LONG_EDGE,
): { width: number; height: number } {
  const swap = degrees === 90 || degrees === 270;
  let width = swap ? sourceHeight : sourceWidth;
  let height = swap ? sourceWidth : sourceHeight;
  const longest = Math.max(sourceWidth, sourceHeight);
  if (Number.isFinite(longest) && longest > maxLongEdge && longest > 0) {
    const scale = maxLongEdge / longest;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  return { width, height };
}

/**
 * Prepares one page's bytes in collection order. Unrotated pages never
 * touch the renderer (byte-identical passthrough).
 */
export async function preparePageBytes(
  page: ImagePage,
  renderer: ImageRenderer,
): Promise<PreparedImage> {
  if (page.rotationDeg === 0) {
    const buffer = await page.file.arrayBuffer();
    return { name: page.name, bytes: new Uint8Array(buffer) };
  }
  const bytes = await renderer.rotateToBytes(page.file, page.rotationDeg, outputMime(page.file));
  return { name: page.name, bytes };
}

/**
 * Browser renderer: decode → rotate → re-encode as JPEG. White-fills
 * before drawing so transparent PNG pixels composite to white (JPEG
 * has no alpha; an unfilled canvas would bake them to black) — the
 * same fill as the import normalization path, so rotated screenshots
 * match their imported look. Canvas sizing is clamped to the shared
 * import pixel budget (`rotationTargetSize`) so rotated originals cannot
 * bypass normalization. The JPEG encode runs in `imageEncode.worker`
 * (same pattern as `imageImport.resizeToJpeg`: worker first, verbatim
 * source-canvas `toBlob` fallback when workers are unavailable — no
 * second canvas, no re-draw); the rotation draw itself stays on the
 * calling thread. Canvases are released (width/height reset) as soon as
 * the blob exists; no frames retained.
 */
export const browserImageRenderer: ImageRenderer = {
  async rotateToBytes(file: File | Blob, degrees: NonZeroRotation, mime: string) {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      const target = rotationTargetSize(bitmap.width, bitmap.height, degrees);
      canvas.width = target.width;
      canvas.height = target.height;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('2D canvas unavailable for image rotation.');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((degrees * Math.PI) / 180);
      // Scaled draw: when the pixel budget clamps the canvas below the
      // rotated source size, fit the source into the canvas (aspect
      // preserved — scale is identical on both axes); unclamped batches
      // keep scale 1, byte-identical to the old full-size draw.
      const rotatedW = degrees === 90 || degrees === 270 ? bitmap.height : bitmap.width;
      const rotatedH = degrees === 90 || degrees === 270 ? bitmap.width : bitmap.height;
      const fitScale =
        rotatedW > 0 && rotatedH > 0
          ? Math.min(1, target.width / rotatedW, target.height / rotatedH)
          : 1;
      const drawW = bitmap.width * fitScale;
      const drawH = bitmap.height * fitScale;
      ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH);
      const width = canvas.width;
      const height = canvas.height;
      // Snapshot for the worker: the transfer neuters only the snapshot,
      // never the source bitmap (released in `finally` below). The source
      // canvas is kept alive until the worker/fallback settles so the
      // fallback can encode it directly (no second canvas, no re-draw).
      let snapshot: ImageBitmap | null = null;
      try {
        snapshot = await createImageBitmap(canvas);
      } catch {
        snapshot = null;
      }
      if (snapshot !== null) {
        try {
          return await encodeBitmapToJpeg(snapshot, { width, height }, 0.95);
        } catch (error) {
          if (!(error instanceof EncodeWorkerUnavailableError)) throw error;
          return sourceCanvasToJpegBytes(canvas, mime);
        } finally {
          snapshot.close();
          canvas.width = 0;
          canvas.height = 0;
        }
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.95));
      canvas.width = 0;
      canvas.height = 0;
      if (blob === null) throw new Error('Image re-encode failed during rotation.');
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      bitmap.close();
    }
  },
};

/**
 * Main-thread fallback for a rotated page (worker unavailable): encodes
 * the SOURCE canvas directly via `toBlob` — the exact white-filled pixels
 * the worker would have read from a snapshot, with no second canvas and
 * no re-draw (the old snapshot re-draw is gone). The caller still owns
 * canvas release via width/height reset after the blob exists.
 */
async function sourceCanvasToJpegBytes(
  canvas: HTMLCanvasElement,
  mime: string,
): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.95));
  if (blob === null) throw new Error('Image re-encode failed during rotation.');
  return new Uint8Array(await blob.arrayBuffer());
}
