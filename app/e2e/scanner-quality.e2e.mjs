/**
 * Research-only crop JPEG quality comparison. Uses production warp pixels and
 * Chromium's JPEG encoder; does not open the scanner or alter production code.
 *
 * Run with a local Vite server:
 *   node e2e/scanner-quality.e2e.mjs http://127.0.0.1:5201
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5201';
const noSandbox =
  process.env.FOLIO_CHROME_NO_SANDBOX === '1' || process.env.CI === 'true' ? ['--no-sandbox'] : [];
const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: noSandbox,
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async () => {
    const { warpImageData } = await import('/src/studio/tools/scan/scanicWarp.ts');
    const qualities = [0.95, 0.97, 0.98];
    const dimensions = [
      { width: 1080, height: 1920, label: 'portrait' },
      { width: 1920, height: 1080, label: 'landscape' },
    ];

    function makeFixture(width, height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2D canvas unavailable');

      // Simulated off-white page, with sharp microtext and deliberately low-
      // contrast thin marks. Drawing parameters are fixed for reproducibility.
      ctx.fillStyle = '#f5f2e9';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#171717';
      ctx.textBaseline = 'top';
      ctx.font = '10px Arial';
      for (let row = 0; row < 16; row += 1) {
        ctx.fillText(
          `tiny text ${String(row).padStart(2, '0')} 1lI0O5S8B`,
          Math.round(width * 0.12),
          Math.round(height * (0.12 + row * 0.018)),
        );
      }

      ctx.strokeStyle = 'rgba(82, 77, 69, 0.58)';
      ctx.lineWidth = 0.7;
      for (let i = 0; i < 48; i += 1) {
        const y = Math.round(height * (0.52 + i * 0.004));
        ctx.beginPath();
        ctx.moveTo(Math.round(width * 0.12), y + (i % 3) * 0.2);
        ctx.lineTo(Math.round(width * 0.82), y + ((i + 1) % 4) * 0.25);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(75, 70, 64, 0.50)';
      ctx.font = 'italic 11px Georgia';
      for (let i = 0; i < 24; i += 1) {
        ctx.fillText(
          `pencil-like ${i % 4}`,
          Math.round(width * 0.14),
          Math.round(height * (0.77 + i * 0.006)),
        );
      }
      const source = ctx.getImageData(0, 0, width, height);
      return { canvas, ctx, source };
    }

    function jpeg(canvas, quality) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encode returned null'))),
          'image/jpeg',
          quality,
        );
      });
    }

    async function decode(blob) {
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('2D decode canvas unavailable');
        ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        canvas.width = canvas.height = 1;
        return { width: bitmap.width, height: bitmap.height, pixels };
      } finally {
        bitmap.close();
      }
    }

    function regionError(reference, compared, width, height, box, detailThreshold) {
      const x0 = Math.floor(width * box[0]);
      const y0 = Math.floor(height * box[1]);
      const x1 = Math.floor(width * box[2]);
      const y1 = Math.floor(height * box[3]);
      const errors = [];
      const detailErrors = [];
      let sum = 0;
      let max = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * width + x) * 4;
          const luminance = (offset) =>
            reference[offset] * 0.299 +
            reference[offset + 1] * 0.587 +
            reference[offset + 2] * 0.114;
          const center = luminance(i);
          const highDetail =
            (x > x0 && Math.abs(center - luminance(i - 4)) >= detailThreshold) ||
            (x + 1 < x1 && Math.abs(center - luminance(i + 4)) >= detailThreshold) ||
            (y > y0 && Math.abs(center - luminance(i - width * 4)) >= detailThreshold) ||
            (y + 1 < y1 && Math.abs(center - luminance(i + width * 4)) >= detailThreshold);
          // RGB MAE against the actual production warp ImageData. Alpha is
          // opaque in warpImageData and intentionally excluded.
          for (let channel = 0; channel < 3; channel += 1) {
            const error = Math.abs(reference[i + channel] - compared[i + channel]);
            errors.push(error);
            if (highDetail) detailErrors.push(error);
            sum += error;
            max = Math.max(max, error);
          }
        }
      }
      errors.sort((a, b) => a - b);
      detailErrors.sort((a, b) => a - b);
      return {
        rgbMae: sum / errors.length,
        rgbP95AbsError: errors[Math.floor((errors.length - 1) * 0.95)],
        rgbMaxAbsError: max,
        detailThreshold,
        detailPixels: detailErrors.length / 3,
        detailRgbMae:
          detailErrors.length === 0
            ? 0
            : detailErrors.reduce((sum, error) => sum + error, 0) / detailErrors.length,
        detailRgbP95AbsError:
          detailErrors.length === 0
            ? 0
            : detailErrors[Math.floor((detailErrors.length - 1) * 0.95)],
        pixels: (x1 - x0) * (y1 - y0),
      };
    }

    const reports = [];
    for (const { width, height, label } of dimensions) {
      const fixture = makeFixture(width, height);
      const captureBlob = await jpeg(fixture.canvas, 0.95);
      fixture.canvas.width = fixture.canvas.height = 1;
      const captured = await decode(captureBlob);

      // The quad introduces a modest perspective correction; all q variants
      // receive these exact production-warp output pixels.
      const corners = {
        topLeft: { x: width * 0.08, y: height * 0.06 },
        topRight: { x: width * 0.92, y: height * 0.09 },
        bottomRight: { x: width * 0.9, y: height * 0.94 },
        bottomLeft: { x: width * 0.1, y: height * 0.91 },
      };
      const warped = warpImageData(captured.pixels, corners);
      const warpCanvas = document.createElement('canvas');
      warpCanvas.width = warped.width;
      warpCanvas.height = warped.height;
      const warpCtx = warpCanvas.getContext('2d', { willReadFrequently: true });
      if (!warpCtx) throw new Error('Warp output canvas unavailable');
      warpCtx.putImageData(warped, 0, 0);
      const reference = warped.data;
      const samples = new Map(qualities.map((q) => [q, []]));

      // Warm every encoder, then alternate order across measured rounds to
      // reduce order/thermal bias. Warmup samples are excluded from results.
      for (const q of qualities) await jpeg(warpCanvas, q);
      for (let round = 0; round < 12; round += 1) {
        const order = round % 2 === 0 ? qualities : [...qualities].reverse();
        for (const q of order) {
          const started = performance.now();
          const blob = await jpeg(warpCanvas, q);
          const encodeMs = performance.now() - started;
          const decoded = await decode(blob);
          if (decoded.width !== warped.width || decoded.height !== warped.height) {
            throw new Error(
              `JPEG dimensions changed: ${decoded.width}×${decoded.height}, expected ${warped.width}×${warped.height}`,
            );
          }
          samples.get(q).push({
            encodeMs,
            bytes: blob.size,
            errors: {
              text: regionError(
                reference,
                decoded.pixels.data,
                warped.width,
                warped.height,
                [0.1, 0.08, 0.55, 0.48],
                12,
              ),
              pencil: regionError(
                reference,
                decoded.pixels.data,
                warped.width,
                warped.height,
                [0.1, 0.5, 0.88, 0.93],
                1,
              ),
            },
          });
        }
      }

      const variants = qualities.map((q) => {
        const values = samples.get(q);
        const sortedMs = values.map((v) => v.encodeMs).sort((a, b) => a - b);
        const sortedBytes = values.map((v) => v.bytes).sort((a, b) => a - b);
        const median = (list) => list[Math.floor(list.length / 2)];
        const averageError = (region) =>
          Object.fromEntries(
            [
              'rgbMae',
              'rgbP95AbsError',
              'detailPixels',
              'detailRgbMae',
              'detailRgbP95AbsError',
            ].map((metric) => [
              metric,
              values.reduce((sum, v) => sum + v.errors[region][metric], 0) / values.length,
            ]),
          );
        return {
          quality: q,
          dimensions: [warped.width, warped.height],
          samples: values.length,
          medianEncodeMs: median(sortedMs),
          medianBlobBytes: median(sortedBytes),
          textError: averageError('text'),
          pencilError: averageError('pencil'),
        };
      });
      const baselineBytes = variants[0].medianBlobBytes;
      reports.push({
        fixture: label,
        sourceDimensions: [width, height],
        captureJpeg95Bytes: captureBlob.size,
        warpDimensions: [warped.width, warped.height],
        codecOnlyReference: 'same production warp ImageData for all qualities',
        variants: variants.map((variant) => ({
          ...variant,
          blobRatioVsQ095: variant.medianBlobBytes / baselineBytes,
        })),
      });

      warpCanvas.width = warpCanvas.height = 1;
      captured.pixels = null;
    }
    return { reports };
  });

  assert.deepEqual(pageErrors, [], `Browser errors: ${pageErrors.join('; ')}`);
  console.log(
    JSON.stringify(
      {
        baseUrl,
        browserVersion: await browser.version(),
        comparison: result,
        limitations: [
          'Synthetic deterministic page only; no real phone photo or sensor optics.',
          'Chromium JPEG encoder and desktop timing are not representative of phone encoders.',
          'Codec error is measured against the actual warped ImageData, isolating output JPEG generation from capture JPEG and warp interpolation.',
          'Text/pencil regions are fixed normalized ROIs over the synthetic warp, not OCR/readability scores.',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
