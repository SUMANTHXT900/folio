/**
 * Test-only `ImageData` stand-in for the jsdom environment.
 *
 * jsdom (29, without the optional `canvas` package) does not expose
 * `ImageData`, yet the scanic boundary constructs it in several places
 * (client response rebuilding, warp output). This installs a minimal,
 * spec-shaped constructor — both overloads, `width`, `height`, `data`,
 * and the length guard — on `globalThis` when the environment lacks one.
 *
 * TEST-ONLY: imported exclusively by `*.test.ts` files; production code
 * always runs against the real `ImageData`.
 */

class TestImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: PredefinedColorSpace = 'srgb';

  constructor(dataOrWidth: number | Uint8ClampedArray, widthOrHeight: number, height?: number) {
    if (typeof dataOrWidth === 'number') {
      const width = dataOrWidth;
      const tall = widthOrHeight;
      if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(tall) || tall <= 0) {
        throw new RangeError(`ImageData dimensions must be positive integers (${width}x${tall})`);
      }
      this.width = width;
      this.height = tall;
      this.data = new Uint8ClampedArray(width * tall * 4);
      return;
    }
    const data = dataOrWidth;
    const width = widthOrHeight;
    const tall = height ?? 0;
    if (data.length !== width * tall * 4) {
      throw new RangeError('ImageData data length must match width * height * 4');
    }
    this.width = width;
    this.height = tall;
    this.data = data;
  }
}

function installTestImageData(): void {
  if (typeof globalThis.ImageData === 'undefined') {
    (globalThis as { ImageData?: unknown }).ImageData = TestImageData;
  }
}

installTestImageData();
