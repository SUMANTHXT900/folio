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
import { encodeBitmapToJpeg, EncodeWorkerUnavailableError } from './imageImport';

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
 * match their imported look. The JPEG encode runs in `imageEncode.worker`
 * (same pattern as `imageImport.resizeToJpeg`: worker first, verbatim
 * main-thread `toBlob` fallback when workers are unavailable); the
 * rotation draw itself stays on the calling thread. Canvases are
 * released (width/height reset) as soon as the blob exists; no frames
 * retained.
 */
export const browserImageRenderer: ImageRenderer = {
  async rotateToBytes(file: File | Blob, degrees: NonZeroRotation, mime: string) {
    const bitmap = await createImageBitmap(file);
    try {
      const swap = degrees === 90 || degrees === 270;
      const canvas = document.createElement('canvas');
      canvas.width = swap ? bitmap.height : bitmap.width;
      canvas.height = swap ? bitmap.width : bitmap.height;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('2D canvas unavailable for image rotation.');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((degrees * Math.PI) / 180);
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      const width = canvas.width;
      const height = canvas.height;
      // Snapshot for the worker: the transfer neuters only the snapshot,
      // never the source bitmap (released in `finally` below).
      let snapshot: ImageBitmap | null = null;
      try {
        snapshot = await createImageBitmap(canvas);
      } catch {
        snapshot = null;
      }
      if (snapshot !== null) {
        canvas.width = 0;
        canvas.height = 0;
        try {
          return await encodeBitmapToJpeg(snapshot, { width, height }, 0.95);
        } catch (error) {
          if (!(error instanceof EncodeWorkerUnavailableError)) throw error;
          return snapshotToJpegBytes(snapshot, width, height, mime);
        } finally {
          snapshot.close();
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
 * Verbatim main-thread fallback for a rotated snapshot (worker
 * unavailable): white-fill + draw + `toBlob`, same pixels the worker
 * would produce. The snapshot stays open for the caller to release.
 */
async function snapshotToJpegBytes(
  snapshot: ImageBitmap,
  width: number,
  height: number,
  mime: string,
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas unavailable for image rotation.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(snapshot, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.95));
  canvas.width = 0;
  canvas.height = 0;
  if (blob === null) throw new Error('Image re-encode failed during rotation.');
  return new Uint8Array(await blob.arrayBuffer());
}
