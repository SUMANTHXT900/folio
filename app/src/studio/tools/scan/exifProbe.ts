/**
 * EXIF orientation probe (no-regret ML pipeline, 2026-10-11): read-only
 * measurement for the A1 decode investigation.
 *
 * Reports the JPEG EXIF orientation tag (1–8) WITHOUT decoding and WITHOUT
 * changing any decode options: it slices at most the first 64 KiB of the
 * file (EXIF/IFD0 live near the SOI marker) and parses the APP1/TIFF
 * structure by hand. No `createImageBitmap`, no canvas, no ImageDecoder —
 * decode behavior is provably untouched. The A1 fix itself waits on real
 * device proof; this probe only collects the evidence (decoded-bitmap dims
 * ride `instrumentation.inputWidth/inputHeight`; the orientation half rides
 * this probe).
 *
 * Pure + dependency-free: `readExifOrientationBytes` is a sync function
 * over bytes (unit-testable with crafted headers);
 * `probeExifOrientation` accepts a `Blob`/`File` (slice + arrayBuffer),
 * an `ArrayBuffer`, or a `Uint8Array` view. Never throws for malformed
 * input — unparseable bytes resolve to `{ orientation: null, ... }`.
 */

export interface ExifProbeResult {
  /**
   * EXIF orientation tag (1–8) when a readable tag was found; null when the
   * bytes carry no EXIF, no orientation tag, or an out-of-range value.
   * Null is NOT "orientation 1" — it means "unknown", and callers must not
   * treat it as a rotation instruction (read-only probe, no behavior).
   */
  orientation: number | null;
  /** True when an APP1 `Exif\0\0` segment was found (even without the tag). */
  hasExif: boolean;
}

const NO_EXIF: ExifProbeResult = { orientation: null, hasExif: false };

/** Bytes read per probe: EXIF/IFD0 live near SOI; orientation needs no more. */
export const EXIF_PROBE_SLICE_BYTES = 64 * 1024;

/** EXIF orientation tag id (IFD0, SHORT). */
const ORIENTATION_TAG = 0x0112;

function readU16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  const lo = bytes[offset] ?? 0;
  const hi = bytes[offset + 1] ?? 0;
  return littleEndian ? lo | (hi << 8) : (lo << 8) | hi;
}

function readU32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  if (littleEndian) return b0 | (b1 << 8) | (b2 << 16) | (b3 * 0x1000000);
  return (b0 * 0x1000000) | (b1 << 16) | (b2 << 8) | b3;
}

/** Parses one APP1 `Exif\0\0` payload; null unless it holds a valid tag. */
function parseExifPayload(payload: Uint8Array): ExifProbeResult {
  // Minimum: 6-byte "Exif\0\0" + 8-byte TIFF header + 2-byte entry count.
  if (payload.length < 16) return { orientation: null, hasExif: true };
  const littleEndian =
    payload[6] === 0x49 && payload[7] === 0x49
      ? true
      : payload[6] === 0x4d && payload[7] === 0x4d
        ? false
        : null;
  if (littleEndian === null) return { orientation: null, hasExif: true };
  if (readU16(payload, 8, littleEndian) !== 42) return { orientation: null, hasExif: true };
  const ifd0 = readU32(payload, 10, littleEndian);
  // IFD0 lives inside this payload: base 6 (past "Exif\0\0") + offset.
  const ifdStart = 6 + ifd0;
  if (ifdStart < 0 || ifdStart + 2 > payload.length) return { orientation: null, hasExif: true };
  const entryCount = readU16(payload, ifdStart, littleEndian);
  // Bound the walk: a corrupt count must not run past the slice.
  const maxEntries = Math.min(
    entryCount,
    Math.floor(Math.max(0, payload.length - ifdStart - 2) / 12),
  );
  for (let i = 0; i < maxEntries; i += 1) {
    const entry = ifdStart + 2 + i * 12;
    if (readU16(payload, entry, littleEndian) !== ORIENTATION_TAG) continue;
    // Type SHORT (3), count 1 → the value sits inline in the first 2 bytes
    // of the value-offset field.
    if (readU16(payload, entry + 2, littleEndian) !== 3) continue;
    if (readU32(payload, entry + 4, littleEndian) !== 1) continue;
    const value = readU16(payload, entry + 8, littleEndian);
    if (value >= 1 && value <= 8) return { orientation: value, hasExif: true };
    return { orientation: null, hasExif: true };
  }
  return { orientation: null, hasExif: true };
}

/**
 * Pure EXIF-orientation parse over bytes (the whole file or its head —
 * callers probing a `Blob` should pass only the first
 * `EXIF_PROBE_SLICE_BYTES`). Read-only: no decoding, no I/O, no options.
 */
export function readExifOrientationBytes(bytes: Uint8Array): ExifProbeResult {
  if (bytes.length < 4) return NO_EXIF;
  // JPEG SOI only — PNG/WebP/HEIC never reach the APP1 walk.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return NO_EXIF;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return NO_EXIF; // Not a marker: stop, no throw.
    const marker = bytes[offset + 1] ?? 0;
    offset += 2;
    // Standalone markers carry no length: SOI/EOI/RSTn/TEM.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      if (marker === 0xd9) break; // EOI: nothing after matters.
      continue;
    }
    // SOS (start of scan) begins entropy-coded data: EXIF never follows it.
    if (marker === 0xda) break;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) break; // Truncated: stop, no throw.
    if (marker === 0xe1 && length >= 8) {
      const payload = bytes.subarray(offset + 2, offset + length);
      if (
        payload.length >= 6 &&
        payload[0] === 0x45 && // "Exif\0\0"
        payload[1] === 0x78 &&
        payload[2] === 0x69 &&
        payload[3] === 0x66 &&
        payload[4] === 0x00 &&
        payload[5] === 0x00
      ) {
        return parseExifPayload(payload);
      }
      // APP1 without the Exif header (e.g. XMP): keep walking.
    }
    offset += length;
  }
  return NO_EXIF;
}

/**
 * Read-only EXIF probe over a `Blob`/`File` (head slice only), an
 * `ArrayBuffer`, or a byte view. Never decodes; never touches decode
 * options; never throws on malformed input.
 */
export async function probeExifOrientation(
  source: Blob | ArrayBuffer | Uint8Array,
): Promise<ExifProbeResult> {
  if (source instanceof Uint8Array) {
    return readExifOrientationBytes(source.subarray(0, EXIF_PROBE_SLICE_BYTES));
  }
  if (source instanceof ArrayBuffer) {
    return readExifOrientationBytes(
      new Uint8Array(source, 0, Math.min(source.byteLength, EXIF_PROBE_SLICE_BYTES)),
    );
  }
  const head = source.slice(0, EXIF_PROBE_SLICE_BYTES);
  const buffer = await head.arrayBuffer();
  return readExifOrientationBytes(new Uint8Array(buffer));
}
