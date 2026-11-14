/**
 * Scanner framing/latency smoke test with real Chromium's synthetic camera.
 * Not evidence of phone lens access, autofocus accuracy or handwriting quality.
 * Run: node e2e/scanner-camera.e2e.mjs [http://localhost:5199]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const output = path.join(os.tmpdir(), 'folio-scanner-qa');
fs.mkdirSync(output, { recursive: true });
const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 1 });
  await page.goto(`${process.argv[2] || 'http://localhost:5199'}/#/images`, {
    waitUntil: 'networkidle0',
  });
  const open = await page.waitForSelector('button');
  void open;
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      /scan document/i.test(b.textContent),
    );
    if (!button) throw new Error('Scan documents button missing');
    button.click();
  });
  await page.waitForSelector('[data-scan-capture]');
  await page.waitForFunction(() => {
    const video = document.querySelector('[data-scanner-root] video');
    return video && video.videoWidth > 0 && video.readyState >= 2;
  });
  const samples = [];
  for (let i = 1; i <= 7; i++) {
    const start = performance.now();
    await page.click('[data-scan-capture]');
    await page.waitForFunction(
      (count) => document.querySelector('[data-gallery-count]')?.textContent === String(count),
      {},
      i,
    );
    const ms = performance.now() - start;
    if (i > 2) samples.push(ms);
  }
  const pixels = await page.evaluate(async () => {
    const video = document.querySelector('[data-scanner-root] video');
    const image = document.querySelector('[data-scan-gallery] img');
    await image.decode();
    return {
      fit: getComputedStyle(video).objectFit,
      source: [video.videoWidth, video.videoHeight],
      saved: [image.naturalWidth, image.naturalHeight],
    };
  });
  assert.equal(pixels.fit, 'contain');
  assert.deepEqual(pixels.saved, pixels.source);
  // Same live video, alternating old/new encoder work: includes draw + JPEG,
  // excludes sensor startup, gallery decode, ML and PDF work.
  const encodeComparison = await page.evaluate(async () => {
    const video = document.querySelector('[data-scanner-root] video');
    const rect = video.getBoundingClientRect();
    const croppedWidth = Math.min(video.videoWidth, (video.videoHeight * rect.width) / rect.height);
    const croppedHeight = Math.min(
      video.videoHeight,
      (video.videoWidth * rect.height) / rect.width,
    );
    const results = { oldCrop92: [], fullFrame95: [] };
    for (let i = 0; i < 12; i++) {
      for (const old of i % 2 ? [true, false] : [false, true]) {
        const start = performance.now();
        const canvas = document.createElement('canvas');
        canvas.width = old ? Math.round(croppedWidth) : video.videoWidth;
        canvas.height = old ? Math.round(croppedHeight) : video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (old)
          ctx.drawImage(
            video,
            (video.videoWidth - croppedWidth) / 2,
            (video.videoHeight - croppedHeight) / 2,
            croppedWidth,
            croppedHeight,
            0,
            0,
            canvas.width,
            canvas.height,
          );
        else ctx.drawImage(video, 0, 0);
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', old ? 0.92 : 0.95),
        );
        if (!blob) throw new Error('JPEG encoder unavailable');
        const ms = performance.now() - start;
        if (i > 1)
          results[old ? 'oldCrop92' : 'fullFrame95'].push({
            ms,
            bytes: blob.size,
            width: canvas.width,
            height: canvas.height,
          });
        canvas.width = canvas.height = 1;
      }
    }
    return results;
  });
  for (const [width, height] of [
    [320, 640],
    [390, 844],
    [768, 1024],
    [1280, 900],
  ]) {
    await page.setViewport({ width, height, isMobile: true, deviceScaleFactor: 1 });
    const geometry = await page.evaluate(() => {
      const capture = document.querySelector('[data-scan-capture]').getBoundingClientRect();
      const topbar = document.querySelector('[data-scanner-topbar]').getBoundingClientRect();
      return {
        target: capture.width >= 44 && capture.height >= 44,
        clear: capture.top > topbar.bottom,
        fits: capture.left >= 0 && capture.right <= innerWidth && capture.bottom <= innerHeight,
      };
    });
    assert.ok(geometry.target && geometry.clear && geometry.fits, JSON.stringify(geometry));
    await page.screenshot({ path: path.join(output, `scanner-${width}.png`) });
  }
  await page.click('[data-scan-more]');
  await page.screenshot({ path: path.join(output, 'scanner-options.png') });
  assert.deepEqual(errors, []);
  const sorted = samples.toSorted((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        pixels,
        captureToCountMs: samples,
        medianMs: sorted[2],
        encodeComparison,
        errors,
        screenshots: output,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
