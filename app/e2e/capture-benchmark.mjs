// Research benchmark: run against a local dev server with Chromium's fake camera.
// CHROME_PATH=/usr/bin/chromium node e2e/capture-benchmark.mjs
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1080 }, height: { ideal: 1920 } },
    });
    try {
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      const track = stream.getVideoTracks()[0];
      const camera = new ImageCapture(track);
      const capabilities = await camera.getPhotoCapabilities();
      const maxWidth = capabilities.imageWidth?.max;
      const maxHeight = capabilities.imageHeight?.max;
      const scale = maxWidth && maxHeight ? Math.min(1, 2000 / Math.max(maxWidth, maxHeight)) : 1;
      const settings = maxWidth && maxHeight ? {
        imageWidth: Math.round(maxWidth * scale), imageHeight: Math.round(maxHeight * scale),
      } : undefined;
      const frame = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        return new Promise((resolve, reject) => canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('Frame encode failed')), 'image/jpeg', 0.92,
        ));
      };
      const photo = () => settings ? camera.takePhoto(settings) : camera.takePhoto();
      const measure = async (fn) => {
        await fn(); // warm-up
        const samples = [];
        for (let i = 0; i < 10; i++) {
          const start = performance.now();
          const blob = await fn();
          const ms = performance.now() - start;
          const bitmap = await createImageBitmap(blob);
          samples.push({ ms, bytes: blob.size, width: bitmap.width, height: bitmap.height });
          bitmap.close();
        }
        return samples;
      };
      return { track: track.getSettings(), requestedPhoto: settings ?? null,
        frame: await measure(frame), photo: await measure(photo) };
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
