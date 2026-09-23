/**
 * Unified page collection for the Images → PDF page-assembly workflow.
 *
 * Pure logic only: no DOM, no object URLs, no workers. The ordering
 * guarantee is structural — page N of the output PDF is `pages[N-1]`,
 * because the build loop stages pages in array order into the existing
 * `pdf.images_to_pdf` engine (which preserves input order). Reordering
 * therefore mutates this array only; image binaries are never copied.
 */

export type ImageSource = 'upload' | 'camera';

/** Clockwise quarter-turns applied at build time (0 = direct passthrough). */
export type ImageRotation = 0 | 90 | 180 | 270;

const ROTATIONS: ImageRotation[] = [0, 90, 180, 270];

/**
 * One page in the collection. `file` is a HANDLE (File/Blob reference),
 * never decoded bytes — bytes are read once at build time. `previewUrl`
 * is an object URL owned by the `useImagePages` hook (created on add,
 * revoked on remove/clear/unmount).
 */
export interface ImagePage {
  /** Stable UI key (hook counter). Never an engine job id. */
  id: string;
  /** Where the page came from — badge/diagnostics only, never a pipeline. */
  source: ImageSource;
  /** Image handle. Read via `arrayBuffer()` at build time only. */
  file: File | Blob;
  /** Original filename, or `scan-NNN.jpg` for camera captures. */
  name: string;
  /** Byte size for display. */
  size: number;
  /** Object-URL preview, owned by the hook. Empty until assigned. */
  previewUrl: string;
  /** Build-time rotation. 0 takes the zero-copy direct path. */
  rotationDeg: ImageRotation;
}

export interface NewPageInput {
  id: string;
  source: ImageSource;
  file: File | Blob;
  name: string;
  previewUrl?: string;
}

/** Builds a page entry. Rotation always starts at 0. */
export function createPage(input: NewPageInput): ImagePage {
  return {
    id: input.id,
    source: input.source,
    file: input.file,
    name: input.name,
    size: input.file.size,
    previewUrl: input.previewUrl ?? '',
    rotationDeg: 0,
  };
}

/**
 * Moves one page by `dir` positions (-1 = earlier, +1 = later),
 * clamped to the collection bounds. Returns a new array; the input
 * is never mutated.
 */
export function movePage(pages: ImagePage[], id: string, dir: -1 | 1): ImagePage[] {
  const from = pages.findIndex((p) => p.id === id);
  if (from < 0) return pages;
  const to = from + dir;
  if (to < 0 || to >= pages.length) return pages;
  const next = pages.slice();
  const [page] = next.splice(from, 1);
  next.splice(to, 0, page);
  return next;
}

/** Removes one page. Returns a new array; unknown ids return the input. */
export function removePage(pages: ImagePage[], id: string): ImagePage[] {
  if (!pages.some((p) => p.id === id)) return pages;
  return pages.filter((p) => p.id !== id);
}

/**
 * Moves one page to an absolute index (clamped). Used by drag-and-drop
 * drop positioning; the ←/→ buttons use `movePage`. Returns a new array.
 */
export function movePageTo(pages: ImagePage[], id: string, to: number): ImagePage[] {
  const from = pages.findIndex((p) => p.id === id);
  if (from < 0) return pages;
  const clamped = Math.max(0, Math.min(pages.length - 1, to));
  if (clamped === from) return pages;
  const next = pages.slice();
  const [page] = next.splice(from, 1);
  next.splice(clamped, 0, page);
  return next;
}

/** Cycles one page's rotation 0 → 90 → 180 → 270 → 0. */
export function rotatePage(pages: ImagePage[], id: string): ImagePage[] {
  return pages.map((p) =>
    p.id === id
      ? { ...p, rotationDeg: ROTATIONS[(ROTATIONS.indexOf(p.rotationDeg) + 1) % ROTATIONS.length] }
      : p,
  );
}

/** Accepted image inputs: JPEG/PNG by MIME or extension. */
export function isImageFile(file: { type: string; name: string }): boolean {
  return (
    file.type === 'image/jpeg' || file.type === 'image/png' || /\.(jpe?g|png)$/i.test(file.name)
  );
}
