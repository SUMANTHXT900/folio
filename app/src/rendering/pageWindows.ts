/**
 * Windowed page processing (Lesson 14).
 *
 * Pure helper for the large-document usage model: instead of requesting
 * all N pages at once and holding N results, callers split `1..pageCount`
 * into fixed-size windows and process → release one window at a time:
 *
 * ```text
 * Pages 1–20 → process → release → Pages 21–40 → process → release → …
 * ```
 *
 * This module only computes the windows. It never renders, never holds
 * bitmaps, and changes no engine API — `generateThumbnails` already
 * accepts arbitrary page lists, so each window is just one call. The
 * future viewer can reuse the same primitive for page navigation and
 * previews without new architecture.
 */

/** Maximum pages per window: bounds per-window result arrays. */
export const MAX_WINDOW_SIZE = 500;

/**
 * Splits `1..pageCount` into consecutive windows of at most `windowSize`
 * pages. The last window holds the remainder. Returns an empty array for
 * `pageCount` 0 (defensive; real documents have ≥ 1 page).
 *
 * Throws `RangeError` for non-integer `pageCount`/`windowSize`,
 * `pageCount < 0`, or `windowSize` outside `1..MAX_WINDOW_SIZE`.
 */
export function pageWindows(pageCount: number, windowSize: number): number[][] {
  if (!Number.isInteger(pageCount) || pageCount < 0) {
    throw new RangeError(`pageCount must be a non-negative integer, got ${String(pageCount)}`);
  }
  if (!Number.isInteger(windowSize) || windowSize < 1 || windowSize > MAX_WINDOW_SIZE) {
    throw new RangeError(
      `windowSize must be an integer in 1..${MAX_WINDOW_SIZE}, got ${String(windowSize)}`,
    );
  }
  const windows: number[][] = [];
  for (let start = 1; start <= pageCount; start += windowSize) {
    const window: number[] = [];
    const end = Math.min(start + windowSize - 1, pageCount);
    for (let page = start; page <= end; page += 1) {
      window.push(page);
    }
    windows.push(window);
  }
  return windows;
}
