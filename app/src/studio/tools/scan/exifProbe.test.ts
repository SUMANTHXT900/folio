// @vitest-environment node
/**
 * `exifProbe` tests: EXIF orientation parsing from crafted JPEG bytes
 * (little/big-endian, missing tag, missing EXIF, non-JPEG, truncated),
 * plus the async `Blob`/`ArrayBuffer`/view entry points.
 *
 * Read-only by construction: this module imports no decode path
 * (`createImageBitmap`, canvas, ImageDecoder appear nowhere here), takes
 * only bytes/Blobs, and slices at most `EXIF_PROBE_SLICE_BYTES` — decode
 * options are provably untouched (the A1 fix waits on device proof).
 */
import { describe, expect, it } from 'vitest';
import {
  EXIF_PROBE_SLICE_BYTES,
  probeExifOrientation,
  readExifOrientationBytes,
} from './exifProbe';

function exifPayload(littleEndian: boolean, orientation: number | null): number[] {
  const header = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const byteOrder = littleEndian ? [0x49, 0x49] : [0x4d, 0x4d];
  const magic = littleEndian ? [0x2a, 0x00] : [0x00, 0x2a];
  const ifdOffset = littleEndian ? [0x08, 0x00, 0x00, 0x00] : [0x00, 0x00, 0x00, 0x08];
  const tiff = [...byteOrder, ...magic, ...ifdOffset];
  if (orientation === null) {
    return [...header, ...tiff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]; // 0 entries + empty next IFD
  }
  const tag = littleEndian ? [0x12, 0x01] : [0x01, 0x12];
  const type = littleEndian ? [0x03, 0x00] : [0x00, 0x03];
  const count = littleEndian ? [0x01, 0x00, 0x00, 0x00] : [0x00, 0x00, 0x00, 0x01];
  const value = littleEndian
    ? [orientation & 0xff, (orientation >> 8) & 0xff, 0x00, 0x00]
    : [(orientation >> 8) & 0xff, orientation & 0xff, 0x00, 0x00];
  return [
    ...header,
    ...tiff,
    0x01,
    0x00,
    ...tag,
    ...type,
    ...count,
    ...value,
    0x00,
    0x00,
    0x00,
    0x00,
  ];
}

function jpegWithApp1(payload: number[]): Uint8Array {
  const length = payload.length + 2;
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    (length >> 8) & 0xff,
    length & 0xff,
    ...payload,
    0xff,
    0xd9,
  ]);
}

describe('readExifOrientationBytes', () => {
  it('reads a little-endian orientation tag (6)', () => {
    expect(readExifOrientationBytes(jpegWithApp1(exifPayload(true, 6)))).toEqual({
      orientation: 6,
      hasExif: true,
    });
  });

  it('reads a big-endian orientation tag (3)', () => {
    expect(readExifOrientationBytes(jpegWithApp1(exifPayload(false, 3)))).toEqual({
      orientation: 3,
      hasExif: true,
    });
  });

  it('reports Exif-without-tag as unknown orientation (never a rotation instruction)', () => {
    expect(readExifOrientationBytes(jpegWithApp1(exifPayload(true, null)))).toEqual({
      orientation: null,
      hasExif: true,
    });
  });

  it('rejects an out-of-range tag value instead of reporting it', () => {
    expect(readExifOrientationBytes(jpegWithApp1(exifPayload(true, 9)))).toEqual({
      orientation: null,
      hasExif: true,
    });
  });

  it('reports no EXIF for a bare JPEG', () => {
    expect(readExifOrientationBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({
      orientation: null,
      hasExif: false,
    });
  });

  it('skips non-Exif APP1 segments (XMP) and keeps walking', () => {
    const xmp = [0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x78]; // "http://x" (no Exif header)
    const bytes = jpegWithApp1(xmp);
    expect(readExifOrientationBytes(bytes)).toEqual({ orientation: null, hasExif: false });
  });

  it('reports no EXIF for non-JPEG bytes (PNG magic)', () => {
    expect(
      readExifOrientationBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toEqual({ orientation: null, hasExif: false });
  });

  it('never throws on truncated input', () => {
    expect(readExifOrientationBytes(new Uint8Array([0xff]))).toEqual({
      orientation: null,
      hasExif: false,
    });
    expect(readExifOrientationBytes(new Uint8Array([0xff, 0xd8, 0xff]))).toEqual({
      orientation: null,
      hasExif: false,
    });
    // Truncated mid-APP1: SOI + marker + partial length.
    expect(readExifOrientationBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00]))).toEqual({
      orientation: null,
      hasExif: false,
    });
  });
});

describe('probeExifOrientation', () => {
  it('probes Blob, ArrayBuffer, and view inputs identically', async () => {
    const bytes = jpegWithApp1(exifPayload(true, 6));
    const expected = { orientation: 6, hasExif: true };
    await expect(
      probeExifOrientation(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' })),
    ).resolves.toEqual(expected);
    await expect(probeExifOrientation(bytes.buffer as ArrayBuffer)).resolves.toEqual(expected);
    await expect(probeExifOrientation(bytes)).resolves.toEqual(expected);
  });

  it('only slices the head of a large Blob (bounded read)', async () => {
    const head = jpegWithApp1(exifPayload(false, 1));
    const padding = new Uint8Array(EXIF_PROBE_SLICE_BYTES * 2);
    const blob = new Blob([head.buffer as ArrayBuffer, padding.buffer as ArrayBuffer]);
    expect(blob.size).toBeGreaterThan(EXIF_PROBE_SLICE_BYTES);
    await expect(probeExifOrientation(blob)).resolves.toEqual({ orientation: 1, hasExif: true });
  });
});
