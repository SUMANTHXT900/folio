/**
 * Binary store: owns engine-bound byte buffers OUTSIDE React/Zustand state.
 *
 * Why this exists (§19, large-file safety): a 490MB PDF must live in
 * exactly one place. Flow per file:
 *
 *   File → File.arrayBuffer() → ONE Uint8Array registered here
 *     → adapter reads it in place (no copy)
 *     → worker adapter transfers a per-execution copy (zero-copy post)
 *
 * UI state, the Zustand store, history entries, and JSON views only ever
 * hold `{outputId, name, byteLength, pageCount}` metadata. Anything that
 * needs bytes (download, re-inspect) pulls them here by id at action time.
 */

const buffers = new Map<string, { bytes: Uint8Array; name: string }>();
let counter = 0;

export function registerBytes(name: string, bytes: Uint8Array): string {
  counter += 1;
  const id = `bin-${counter}`;
  buffers.set(id, { bytes, name });
  return id;
}

/**
 * Stores bytes under a caller-chosen id (used for input files, whose ids
 * live in UI state). Unlike `registerBytes`, the id is an input, not an
 * output — mixing the two up orphans buffers, so keep them distinct.
 */
export function putBytes(id: string, name: string, bytes: Uint8Array): void {
  buffers.set(id, { bytes, name });
}

export function getBytes(id: string): Uint8Array | undefined {
  return buffers.get(id)?.bytes;
}

export function getName(id: string): string | undefined {
  return buffers.get(id)?.name;
}

export function byteLength(id: string): number {
  return buffers.get(id)?.bytes.length ?? 0;
}

/**
 * Returns an exact-size copy of stored bytes (e.g. for Blob download).
 * The single engine-side copy stays in the store; callers needing a
 * transferable buffer take one explicit copy here.
 */
export function copyBytes(id: string): Uint8Array<ArrayBuffer> | undefined {
  const entry = buffers.get(id);
  if (entry === undefined) {
    return undefined;
  }
  return entry.bytes.slice();
}

export function releaseBytes(id: string): void {
  buffers.delete(id);
}

export function storedCount(): number {
  return buffers.size;
}

/** Test-only reset. Not used by the app itself. */
export function __clearBinaryStore(): void {
  buffers.clear();
  counter = 0;
}
