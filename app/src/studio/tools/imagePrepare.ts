/**
 * Build-time image preparation for Images → PDF.
 *
 * Two paths:
 * - Unrotated pages take the zero-copy direct path: raw file bytes are
 *   forwarded untouched (engine EXIF/DPI handling applies as before).
 * - Rotated pages are decoded to a canvas, rotated, and re-encoded.
 *   Canvas output carries no EXIF, so the engine reads orientation 1
 *   and cannot double-rotate.
 *
 * The canvas renderer is injectable so the selection logic is unit
 * tested without a DOM canvas; the browser implementation lives here
 * alongside it.
 */

import type { ImagePage, ImageRotation } from './imagePages';

export interface PreparedImage {
  name: string;
  bytes: Uint8Array;
}

/** Quarters turns the canvas path supports (0 never reaches it). */
export type NonZeroRotation = Exclude<ImageRotation, 0>;

export interface ImageRenderer {
  rotateToBytes(file: File | Blob, degrees: NonZeroRotation, mime: string): Promise<Uint8Array>;
}

/** Output MIME follows the source: JPEG stays JPEG, everything else PNG. */
export function outputMime(file: File | Blob): string {
  const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return type;
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
 * Browser renderer: decode → rotate → re-encode. The canvas is released
 * (width/height reset) as soon as the blob exists; no frames retained.
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
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((degrees * Math.PI) / 180);
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));
      canvas.width = 0;
      canvas.height = 0;
      if (blob === null) throw new Error('Image re-encode failed during rotation.');
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      bitmap.close();
    }
  },
};
