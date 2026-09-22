/** Small presentation helpers. No engine semantics here. */

export function formatMs(ms: number): string {
  if (ms < 1) {
    return `${ms.toFixed(2)} ms`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(1)} ms`;
  }
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function formatClock(timestampMs: number): string {
  const date = new Date(timestampMs);
  const pad = (value: number, digits = 2): string => String(value).padStart(digits, '0');
  return (
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

export function formatIso(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  return new Date(ms).toLocaleString();
}

/** min / mean / median / max over engine durations. */
export function summarize(values: number[]): {
  min: number;
  mean: number;
  median: number;
  max: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const mean = sorted.length === 0 ? 0 : sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
  return { min, mean, median, max };
}

/** Walks a value graph looking for binary payloads (leak detector). */
export function containsBinary(value: unknown, seen = new Set<object>()): boolean {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Blob) {
    return true;
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return Object.values(value).some((child) => containsBinary(child, seen));
  }
  return false;
}
