/**
 * Scan-image import normalization (M3.x): bounded, pixel-budget based.
 *
 * The file-import path must never materialize many full-resolution
 * decodes at once: a ~2 MB phone JPEG can decode to ~36 MB of raw
 * pixels, so 32 selected photos are >1 GB before any PDF work starts.
 * This layer normalizes ONE image at a time (long edge ≤
 * [`MAX_IMPORT_LONG_EDGE`], pixels not file size), releasing every
 * temporary decode/canvas before the next file, and yields to the event
 * loop between files so the UI can paint progress.
 *
 * JPEGs already inside the pixel budget keep their ORIGINAL bytes —
 * no unnecessary recompression, no quality loss. Oversized images are
 * re-encoded once at the existing capture quality (~q0.92). PNGs are
 * ALWAYS converted to JPEG (white-filled, budget-clamped): the engine
 * embeds PNGs as uncompressed raw RGB, so a retained 2 MB screenshot
 * would become ~15 MB in the PDF (real-phone report: 100 MB+ outputs
 * from gallery imports while JPEG camera captures stayed small).
 * Aspect ratio is always preserved; small images are never upscaled.
 */

/** Working long edge for imported images (engineering constant). */
export const MAX_IMPORT_LONG_EDGE = 2500;

/** JPEG quality for normalized imports (matches capture path). */
export const IMPORT_JPEG_QUALITY = 0.92;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface PrepareImportResult {
  /** File retained for the page: original bytes or normalized re-encode. */
  file: File | Blob;
  name: string;
  /** True when the file is within budget and bytes are untouched. */
  retainedOriginal: boolean;
  width: number;
  height: number;
}

export interface PrepareImportOptions {
  maxLongEdge?: number;
  quality?: number;
}

/**
 * Pure decision: target dimensions for a source size, aspect preserved,
 * never upscaled. Returns null when normalization is unnecessary.
 */
export function planNormalization(
  source: ImageDimensions,
  maxLongEdge: number = MAX_IMPORT_LONG_EDGE,
): ImageDimensions | null {
  const longest = Math.max(source.width, source.height);
  if (!Number.isFinite(longest) || longest <= 0) return null;
  if (longest <= maxLongEdge) return null;
  const scale = maxLongEdge / longest;
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/** PNG inputs (MIME or extension): the engine has no DCT path for PNG,
 * so retained PNG bytes would embed as raw RGB — always convert. */
export function isPngFile(file: File): boolean {
  if (file.type === 'image/png') return true;
  if (file.type === 'image/jpeg') return false;
  return /\.png$/i.test(file.name);
}
/** Minimal renderer seam so planning logic is testable without a DOM. */
export interface ImportRenderer {
  decode(file: File | Blob): Promise<ImageDimensions>;
  resizeToJpeg(file: File | Blob, target: ImageDimensions, quality: number): Promise<Uint8Array>;
}

/** Browser renderer: one decode, one canvas, both released immediately. */
export const browserImportRenderer: ImportRenderer = {
  async decode(file) {
    const bitmap = await createImageBitmap(file);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  },

  async resizeToJpeg(file, target, quality) {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(target.width, target.height)
          : document.createElement('canvas');
      if (canvas instanceof HTMLCanvasElement) {
        canvas.width = target.width;
        canvas.height = target.height;
      }
      const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext('2d') as
        CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (ctx === null) throw new Error('2D canvas unavailable for import normalization.');
      // White-fill first: transparent PNG pixels must composite to white
      // (JPEG has no alpha; an unfilled canvas bakes them to black).
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, target.width, target.height);
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);
      if (canvas instanceof HTMLCanvasElement) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', quality),
        );
        canvas.width = 0;
        canvas.height = 0;
        if (blob === null) throw new Error('Import re-encode failed.');
        return new Uint8Array(await blob.arrayBuffer());
      }
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      bitmap.close();
    }
  },
};

/**
 * Prepares ONE selected file for import. Decodes a single bitmap,
 * decides by pixel dimensions, and either retains the original bytes or
 * re-encodes once — no temporary object URLs, no retained canvas.
 * PNGs always re-encode (white-filled JPEG): retained PNG bytes would
 * embed as uncompressed raw RGB downstream.
 */
export async function prepareImportFile(
  file: File,
  renderer: ImportRenderer = browserImportRenderer,
  options: PrepareImportOptions = {},
): Promise<PrepareImportResult> {
  const maxLongEdge = options.maxLongEdge ?? MAX_IMPORT_LONG_EDGE;
  const quality = options.quality ?? IMPORT_JPEG_QUALITY;
  const dims = await renderer.decode(file);
  if (!(dims.width > 0 && dims.height > 0)) {
    throw new Error(`could not read image dimensions for ${file.name}`);
  }
  const target = planNormalization(dims, maxLongEdge);
  if (target === null && !isPngFile(file)) {
    return {
      file,
      name: file.name,
      retainedOriginal: true,
      width: dims.width,
      height: dims.height,
    };
  }
  const size = target ?? dims;
  const bytes = await renderer.resizeToJpeg(file, size, quality);
  const name = file.name.replace(/\.(jpe?g|png)$/i, '') + '.jpg';
  return {
    file: new File([bytes as unknown as BlobPart], name, { type: 'image/jpeg' }),
    name,
    retainedOriginal: false,
    width: size.width,
    height: size.height,
  };
}

/** One queued file's outcome. */
export interface ImportOutcome {
  file: File;
  result: PrepareImportResult | null;
  error: string | null;
}

/**
 * Runs `prepare` over `files` SEQUENTIALLY (concurrency 1: the memory
 * bound is one decoded bitmap), yielding to the event loop between
 * items so progress can paint. `shouldCancel` is polled before each
 * file; a cancelled run leaves prepared results untouched (callers keep
 * what already committed).
 */
export async function runImportQueue(
  files: File[],
  prepare: (file: File) => Promise<PrepareImportResult>,
  onProgress: (completed: number, total: number, result: PrepareImportResult) => void,
  shouldCancel: () => boolean,
): Promise<{ outcomes: ImportOutcome[]; cancelled: boolean }> {
  const outcomes: ImportOutcome[] = [];
  for (let i = 0; i < files.length; i += 1) {
    if (shouldCancel()) {
      return { outcomes, cancelled: true };
    }
    const file = files[i];
    try {
      const result = await prepare(file);
      outcomes.push({ file, result, error: null });
      onProgress(i + 1, files.length, result);
    } catch (error) {
      outcomes.push({
        file,
        result: null,
        error: error instanceof Error ? error.message : 'image could not be read',
      });
    }
    // Yield: keeps React paint + input responsive between decodes.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { outcomes, cancelled: false };
}
