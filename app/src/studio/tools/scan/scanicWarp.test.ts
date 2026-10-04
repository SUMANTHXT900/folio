/**
 * DOM-free warp tests: output sizing, bilinear sampling, quad orientation,
 * alpha parity, input immutability, and rejection of degenerate quads.
 */
import { describe, expect, it } from 'vitest';
import './scanicTestImageData';
import { warpImageData, warpOutputSize } from './scanicWarp';
import type { ScanicCorners } from './scanicProtocol';

type Rgba = [number, number, number, number];

function makeImage(width: number, height: number, pixels: Rgba[]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((rgba, index) => data.set(rgba, index * 4));
  return new ImageData(data, width, height);
}

function pixel(image: ImageData, x: number, y: number): Rgba {
  const index = (y * image.width + x) * 4;
  return [
    image.data[index],
    image.data[index + 1],
    image.data[index + 2],
    image.data[index + 3],
  ] as Rgba;
}

const FULL_SQUARE: ScanicCorners = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 10, y: 0 },
  bottomRight: { x: 10, y: 10 },
  bottomLeft: { x: 0, y: 10 },
};

describe('warpOutputSize', () => {
  it('sizes the output to the quad (longest opposite sides, rounded)', () => {
    expect(warpOutputSize(FULL_SQUARE)).toEqual({ width: 10, height: 10 });
    expect(
      warpOutputSize({
        topLeft: { x: 0, y: 0 },
        topRight: { x: 100, y: 0 },
        bottomRight: { x: 100, y: 50 },
        bottomLeft: { x: 0, y: 50 },
      }),
    ).toEqual({ width: 100, height: 50 });
    // A trapezoid uses the longer of each opposite pair (the 41 is the
    // rounded length of the slanted left/right sides).
    expect(
      warpOutputSize({
        topLeft: { x: 10, y: 0 },
        topRight: { x: 90, y: 0 },
        bottomRight: { x: 100, y: 40 },
        bottomLeft: { x: 0, y: 40 },
      }),
    ).toEqual({ width: 100, height: 41 });
  });
});

describe('warpImageData', () => {
  it('reproduces exact corner and edge pixels for an axis-aligned quad', () => {
    // 4×3 source; rows are distinct so sampled rows are identifiable.
    const source = makeImage(4, 3, [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
      [10, 10, 10, 255],
      [20, 20, 20, 255],
      [30, 30, 30, 255],
      [40, 40, 40, 255],
      [255, 255, 255, 255],
      [9, 8, 7, 255],
      [6, 5, 4, 255],
      [3, 2, 1, 255],
    ]);
    const warped = warpImageData(source, {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 3, y: 0 },
      bottomRight: { x: 3, y: 2 },
      bottomLeft: { x: 0, y: 2 },
    });
    // 3×2 output (side lengths 3 and 2).
    expect(warped.width).toBe(3);
    expect(warped.height).toBe(2);
    // Corner rows are sampled exactly: leftmost/rightmost columns, rows 0 and 2.
    expect(pixel(warped, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(warped, 2, 0)).toEqual([255, 255, 0, 255]);
    expect(pixel(warped, 0, 1)).toEqual([255, 255, 255, 255]);
    expect(pixel(warped, 2, 1)).toEqual([3, 2, 1, 255]);
    // The middle output column samples x = 1.5: the bilinear blend of the
    // two adjacent source pixels.
    expect(pixel(warped, 1, 0)).toEqual([0, 128, 128, 255]);
  });

  it('samples the quad center through a rotated diamond', () => {
    // 11×11 source with a distinct center pixel.
    const pixels: Rgba[] = [];
    for (let y = 0; y < 11; y += 1) {
      for (let x = 0; x < 11; x += 1) {
        pixels.push(x === 5 && y === 5 ? [7, 77, 177, 255] : [0, 0, 0, 255]);
      }
    }
    const source = makeImage(11, 11, pixels);
    const warped = warpImageData(source, {
      topLeft: { x: 5, y: 0 },
      topRight: { x: 10, y: 5 },
      bottomRight: { x: 5, y: 10 },
      bottomLeft: { x: 0, y: 5 },
    });
    expect(warped.width).toBe(7);
    expect(warped.height).toBe(7);
    expect(pixel(warped, 3, 3)).toEqual([7, 77, 177, 255]);
  });

  it('forces opaque alpha on transparent source pixels (scanic parity)', () => {
    const source = makeImage(3, 3, [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const warped = warpImageData(source, {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 2, y: 0 },
      bottomRight: { x: 2, y: 2 },
      bottomLeft: { x: 0, y: 2 },
    });
    expect(warped.width).toBe(2);
    expect(warped.height).toBe(2);
    expect(pixel(warped, 0, 0)[3]).toBe(255);
    expect(pixel(warped, 1, 1)[3]).toBe(255);
  });

  it('never mutates the source ImageData', () => {
    const source = makeImage(2, 2, [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [13, 14, 15, 16],
    ]);
    const before = Array.from(source.data);
    warpImageData(source, {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 1, y: 0 },
      bottomRight: { x: 1, y: 1 },
      bottomLeft: { x: 0, y: 1 },
    });
    expect(Array.from(source.data)).toEqual(before);
  });

  it('rejects collapsed and non-finite quads', () => {
    const source = makeImage(2, 2, [
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
    ]);
    expect(() =>
      warpImageData(source, {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 0, y: 0 },
        bottomRight: { x: 1, y: 1 },
        bottomLeft: { x: 0, y: 1 },
      }),
    ).toThrow(/warp rejected/);
    expect(() =>
      warpImageData(source, {
        topLeft: { x: Number.NaN, y: 0 },
        topRight: { x: 1, y: 0 },
        bottomRight: { x: 1, y: 1 },
        bottomLeft: { x: 0, y: 1 },
      }),
    ).toThrow(/warp rejected/);
  });
});
