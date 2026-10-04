/**
 * DOM-free full-resolution perspective warp for the scanic worker.
 *
 * scanic's own `extractDocument` / `scanDocument(mode: 'extract')` reads its
 * source pixels through `document.createElement('canvas')`, which does not
 * exist in a worker. The worker therefore performs the same warp directly on
 * ImageData with the same visible behavior: output size from the quad's
 * opposite side lengths (longest side wins), inverse projective mapping of
 * every output pixel back into the source quad, bilinear sampling with edge
 * clamping, opaque alpha. No canvas, no DOM, no re-encode — full resolution
 * in, full resolution out.
 *
 * The returned ImageData owns a fresh buffer sized to the quad; the input
 * ImageData is never mutated.
 */

import { validateScanicCorners, type ScanicCorners, type ScanicPoint } from './scanicProtocol';

export interface WarpOutputSize {
  width: number;
  height: number;
}

function distance(a: ScanicPoint, b: ScanicPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Output pixel size for a quad: the longest of each pair of opposite sides,
 * rounded, never below 1px — the same sizing rule scanic's unwarp uses.
 */
export function warpOutputSize(corners: ScanicCorners): WarpOutputSize {
  const width = Math.max(
    1,
    Math.round(
      Math.max(
        distance(corners.bottomRight, corners.bottomLeft),
        distance(corners.topRight, corners.topLeft),
      ),
    ),
  );
  const height = Math.max(
    1,
    Math.round(
      Math.max(
        distance(corners.topRight, corners.bottomRight),
        distance(corners.topLeft, corners.bottomLeft),
      ),
    ),
  );
  return { width, height };
}

/**
 * Solves the projective transform from the unit square
 * (0,0)-(1,0)-(1,1)-(0,1) onto the source quad and returns its 8
 * coefficients `[h0..h7]` with h8 fixed at 1, so that for normalized output
 * coordinates `(nx, ny)`:
 *
 * ```text
 * sx = (h0·nx + h1·ny + h2) / (h6·nx + h7·ny + 1)
 * sy = (h3·nx + h4·ny + h5) / (h6·nx + h7·ny + 1)
 * ```
 *
 * Sampling the unit square and scaling output pixels into it is
 * mathematically identical for every output size ≥ 2 (both maps agree on the
 * four quad corners), and it stays well-defined for 1px-wide/tall outputs
 * where a rectangle-corner solve would be singular. Gaussian elimination
 * with partial pivoting; throws when the quad admits no unique transform.
 */
function solveUnitSquareToQuad(corners: ScanicCorners): Float64Array {
  const from = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const to = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
  const matrix = new Float64Array(64);
  const rhs = new Float64Array(8);
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    const rowU = i * 2;
    const rowV = rowU + 1;
    matrix[rowU * 8 + 0] = x;
    matrix[rowU * 8 + 1] = y;
    matrix[rowU * 8 + 2] = 1;
    matrix[rowU * 8 + 6] = -x * u;
    matrix[rowU * 8 + 7] = -y * u;
    rhs[rowU] = u;
    matrix[rowV * 8 + 3] = x;
    matrix[rowV * 8 + 4] = y;
    matrix[rowV * 8 + 5] = 1;
    matrix[rowV * 8 + 6] = -x * v;
    matrix[rowV * 8 + 7] = -y * v;
    rhs[rowV] = v;
  }
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(matrix[row * 8 + column]) > Math.abs(matrix[pivot * 8 + column])) {
        pivot = row;
      }
    }
    if (Math.abs(matrix[pivot * 8 + column]) < 1e-12) {
      throw new Error('warp rejected: corners form a degenerate quad');
    }
    if (pivot !== column) {
      for (let k = 0; k < 8; k += 1) {
        const swap = matrix[column * 8 + k];
        matrix[column * 8 + k] = matrix[pivot * 8 + k];
        matrix[pivot * 8 + k] = swap;
      }
      const swap = rhs[column];
      rhs[column] = rhs[pivot];
      rhs[pivot] = swap;
    }
    const diagonal = matrix[column * 8 + column];
    for (let row = column + 1; row < 8; row += 1) {
      const factor = matrix[row * 8 + column] / diagonal;
      if (factor === 0) continue;
      for (let k = column; k < 8; k += 1) {
        matrix[row * 8 + k] -= factor * matrix[column * 8 + k];
      }
      rhs[row] -= factor * rhs[column];
    }
  }
  const solution = new Float64Array(8);
  for (let row = 7; row >= 0; row -= 1) {
    let sum = rhs[row];
    for (let k = row + 1; k < 8; k += 1) {
      sum -= matrix[row * 8 + k] * solution[k];
    }
    solution[row] = sum / matrix[row * 8 + row];
  }
  return solution;
}

/**
 * Full-resolution bilinear perspective warp of `image` (RGBA) with
 * `corners` (same full-resolution pixel space). Output dims come from
 * [`warpOutputSize`]; every output pixel samples the source with bilinear
 * interpolation, clamped to the source bounds, alpha forced opaque.
 *
 * Throws when the corners fail [`validateScanicCorners`] or resolve to a
 * degenerate transform.
 */
export function warpImageData(image: ImageData, corners: ScanicCorners): ImageData {
  const cornersError = validateScanicCorners(corners);
  if (cornersError !== null) {
    throw new Error(`warp rejected: ${cornersError}`);
  }
  const { width, height } = warpOutputSize(corners);
  const h = solveUnitSquareToQuad(corners);
  const h0 = h[0];
  const h1 = h[1];
  const h2 = h[2];
  const h3 = h[3];
  const h4 = h[4];
  const h5 = h[5];
  const h6 = h[6];
  const h7 = h[7];

  const source = image.data;
  const sourceWidth = image.width;
  const sourceHeight = image.height;
  const maxSourceX = sourceWidth - 1;
  const maxSourceY = sourceHeight - 1;
  const xStep = width > 1 ? 1 / (width - 1) : 0;
  const yStep = height > 1 ? 1 / (height - 1) : 0;

  const output = new ImageData(width, height);
  const destination = output.data;

  for (let oy = 0; oy < height; oy += 1) {
    // 1px-tall outputs sample the quad's vertical centerline.
    const ny = height > 1 ? oy * yStep : 0.5;
    const rowA = h1 * ny + h2;
    const rowB = h4 * ny + h5;
    const rowW = h7 * ny + 1;
    const outputRow = oy * width;
    for (let ox = 0; ox < width; ox += 1) {
      const nx = width > 1 ? ox * xStep : 0.5;
      const w = h6 * nx + rowW;
      if (w === 0) continue; // Degenerate projection: leave the pixel empty.
      const inverseW = 1 / w;
      const rawX = (h0 * nx + rowA) * inverseW;
      const rawY = (h3 * nx + rowB) * inverseW;
      const sx = rawX < 0 ? 0 : rawX > maxSourceX ? maxSourceX : rawX;
      const sy = rawY < 0 ? 0 : rawY > maxSourceY ? maxSourceY : rawY;

      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 < maxSourceX ? x0 + 1 : x0;
      const y1 = y0 < maxSourceY ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const fx1 = 1 - fx;
      const fy1 = 1 - fy;

      const w00 = fx1 * fy1;
      const w10 = fx * fy1;
      const w01 = fx1 * fy;
      const w11 = fx * fy;

      const index00 = (y0 * sourceWidth + x0) << 2;
      const index10 = (y0 * sourceWidth + x1) << 2;
      const index01 = (y1 * sourceWidth + x0) << 2;
      const index11 = (y1 * sourceWidth + x1) << 2;
      const index = (outputRow + ox) << 2;

      destination[index] =
        (source[index00] * w00 +
          source[index10] * w10 +
          source[index01] * w01 +
          source[index11] * w11 +
          0.5) |
        0;
      destination[index + 1] =
        (source[index00 + 1] * w00 +
          source[index10 + 1] * w10 +
          source[index01 + 1] * w01 +
          source[index11 + 1] * w11 +
          0.5) |
        0;
      destination[index + 2] =
        (source[index00 + 2] * w00 +
          source[index10 + 2] * w10 +
          source[index01 + 2] * w01 +
          source[index11 + 2] * w11 +
          0.5) |
        0;
      // scanic parity: the warp output is fully opaque.
      destination[index + 3] = 255;
    }
  }
  return output;
}
