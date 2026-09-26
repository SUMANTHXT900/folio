/**
 * Smart output naming for Studio downloads (feature-wide).
 *
 * Every tool used to invent its own filename inline (`images.pdf`,
 * `merged-….pdf`, …) and most auto-downloaded before the user ever saw
 * a name. This module centralizes the policy:
 *
 * - `smartOutputName` derives a sensible default from the INPUT names
 *   (never generic `feature.pdf`), per operation kind;
 * - `sanitizeFileName` makes any user-typed custom name filesystem-safe
 *   and guarantees a `.pdf` suffix;
 * - `DownloadCard` (sibling component) pairs the two as Smart / Custom.
 *
 * Pure functions only — no DOM, no React — so the policy is unit-tested
 * here and reused identically by every tool.
 */

/** Smart-name operation kinds (split parts carry their range separately). */
export type SmartNameKind = 'merge' | 'rearrange' | 'rotate' | 'metadata' | 'images';

/** Fallback filename when nothing usable remains after sanitizing. */
export const FALLBACK_PDF_NAME = 'document.pdf';

/** Max total filename length (base + `.pdf`), kept conservative for mobile filesystems. */
export const MAX_PDF_NAME_LENGTH = 120;

/** Max characters taken from any single input basename (keeps merges readable). */
export const MAX_INPUT_SEGMENT_LENGTH = 40;

/** Strips a trailing `.pdf` (any case); leaves other extensions untouched. */
export function stripPdfExt(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

/** Strips any trailing extension (`scan-001.jpg` → `scan-001`). */
export function stripAnyExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

/** One input's contribution to a smart name: trimmed, truncated, never empty. */
function segment(raw: string, stripExt: (name: string) => string): string {
  const base = stripExt(raw.trim()).trim();
  if (base === '') return 'file';
  return base.length > MAX_INPUT_SEGMENT_LENGTH
    ? base.slice(0, MAX_INPUT_SEGMENT_LENGTH).trimEnd()
    : base;
}

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/** Control characters become `-` (char-code loop: control escapes trip `no-control-regex`). */
function stripControls(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 32;
    out += code < 32 || code === 127 ? '-' : ch;
  }
  return out;
}

/**
 * Makes a raw name filesystem-safe and guarantees a `.pdf` suffix.
 * Illegal characters become `-`, surrounding dots/spaces are trimmed,
 * the total is capped (preserving the suffix), and an empty result
 * falls back to `fallback` (default `document.pdf`).
 */
export function sanitizeFileName(raw: string, fallback: string = FALLBACK_PDF_NAME): string {
  let base = stripControls(raw.replace(ILLEGAL_FILENAME_CHARS, '-')).replace(/\s+/g, ' ').trim();
  base = base.replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  if (/\.pdf$/i.test(base)) {
    base = base.slice(0, -4).trim();
  }
  if (base === '') {
    return fallback.endsWith('.pdf') ? fallback : `${fallback}.pdf`;
  }
  let name = `${base}.pdf`;
  if (name.length > MAX_PDF_NAME_LENGTH) {
    const keep = MAX_PDF_NAME_LENGTH - 4;
    name = `${base.slice(0, keep).trimEnd()}.pdf`;
  }
  return name;
}

/**
 * Smart default output name from the INPUT names (kind-specific):
 * - merge (2): `a-b-merged.pdf`; (3+): `first-plus<N-1>-merged.pdf`.
 * - rearrange / rotate / metadata: `<base>-rearranged|rotated|metadata.pdf`.
 * - images (1 page): `<page>.pdf`; (N): `<first>-plus<N-1>-pages.pdf`
 *   (page names keep any extension stripped: `scan-001.jpg` → `scan-001`).
 *
 * Always sanitized; empty input lists fall back to `<kind>.pdf`-style
 * generic names via `document.pdf` (callers always pass real inputs).
 */
export function smartOutputName(kind: SmartNameKind, inputNames: string[]): string {
  const names = inputNames.map((n) => n.trim()).filter((n) => n !== '');
  switch (kind) {
    case 'merge': {
      if (names.length === 0) return 'merged.pdf';
      if (names.length === 1)
        return sanitizeFileName(`${segment(names[0], stripPdfExt)}-merged.pdf`);
      if (names.length === 2) {
        return sanitizeFileName(
          `${segment(names[0], stripPdfExt)}-${segment(names[1], stripPdfExt)}-merged.pdf`,
        );
      }
      return sanitizeFileName(
        `${segment(names[0], stripPdfExt)}-plus${names.length - 1}-merged.pdf`,
      );
    }
    case 'rearrange':
    case 'rotate':
    case 'metadata': {
      const suffix =
        kind === 'rearrange' ? 'rearranged' : kind === 'rotate' ? 'rotated' : 'metadata';
      if (names.length === 0) return `${suffix}.pdf`;
      return sanitizeFileName(`${segment(names[0], stripPdfExt)}-${suffix}.pdf`);
    }
    case 'images': {
      if (names.length === 0) return 'images.pdf';
      if (names.length === 1) return sanitizeFileName(`${segment(names[0], stripAnyExt)}.pdf`);
      return sanitizeFileName(
        `${segment(names[0], stripAnyExt)}-plus${names.length - 1}-pages.pdf`,
      );
    }
  }
}

/**
 * Split-part smart name, preserving the existing `-p<a>-<b>` convention:
 * `report.pdf` + pages 3–7 → `report-p3-7.pdf`.
 */
export function smartSplitPartName(inputName: string, a: number, b: number): string {
  const base = inputName.trim() === '' ? 'file' : stripPdfExt(inputName.trim());
  return sanitizeFileName(`${segment(base, (s) => s)}-p${a}-${b}.pdf`);
}
