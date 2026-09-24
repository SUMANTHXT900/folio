/**
 * Scan original-retention store (M2 interfaces for M3 wiring).
 *
 * Lifetime rule (approved correction): entries live with the ACCEPTED
 * page, not the camera session. Scanner close/unmount releases NOTHING
 * here. Release happens on page remove / clear-all / replace-discard.
 *
 * - `retainOriginal(pageId, file)` — keep the pre-scan capture.
 * - `originalOf(pageId)` — the retained capture, if any.
 * - `releaseScan(pageId)` — drop one entry (page removed/replaced).
 * - `clearScans()` — drop all (clear-all).
 *
 * Only `File`/`Blob` handles are stored — never decoded bytes, never in
 * React state. Test-only reset exists for unit tests; the app never
 * calls it.
 */

export interface RetainedScan {
  original: File | Blob;
  name: string;
}

const scans = new Map<string, RetainedScan>();

/** Retains the pre-scan capture for one accepted page. */
export function retainOriginal(pageId: string, original: File | Blob, name: string): void {
  scans.set(pageId, { original, name });
}

/** Returns the retained original for a page, if any. */
export function originalOf(pageId: string): RetainedScan | undefined {
  return scans.get(pageId);
}

/** Releases one page's retained scan (remove / replace / discard). */
export function releaseScan(pageId: string): void {
  scans.delete(pageId);
}

/** Releases all retained scans (clear-all). */
export function clearScans(): void {
  scans.clear();
}

/** Test-only reset. The app never calls this. */
export function __resetScansForTests(): void {
  scans.clear();
}
