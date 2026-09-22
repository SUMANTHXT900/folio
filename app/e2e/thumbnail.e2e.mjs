/**
 * Lesson 13 thumbnail E2E (real headless Chrome, real PDF.js worker).
 *
 * Runs against the Vite dev server (DEV branch, `window.__folioRenderE2E`).
 * Asserts the full §33 matrix plus bounded concurrency, page-order,
 * progress, cancellation, errors, and large-doc stress.
 *
 * IDM-proof transports: download managers (e.g. Internet Download Manager)
 * hook browser HTTP/download APIs by extension, MIME type, and filename —
 * even after their tray icon is dismissed. This harness therefore performs
 * ZERO HTTP transfers of test bytes: Node reads the PDFs from disk and
 * pushes them into the page as base64 chunks over the DevTools protocol
 * (`page.evaluate`), which download managers cannot see or intercept. The
 * page assembles the chunks into exact `Uint8Array` copies (verified by
 * byte length) before handing them to the render engine. The only HTTP in
 * play is the dev-server page load itself (JS/HTML, never a download).
 *
 * Usage (from app/):
 *   1. Terminal A: npx vite --port 5199   (or any free port + --dev)
 *   2. Terminal B: node e2e/thumbnail.e2e.mjs [--dev http://localhost:5199]
 *
 * Exits 0 on full pass, 1 otherwise. Prints JSON summary at the end.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { missingFiles, reportOptionalSkip } from './corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF_DIR = path.resolve(__dirname, '../../test pdfs');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const DEV_URL = flag('--dev', 'http://localhost:5199');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const FILE_NAMES = {
  small: 'generated.pdf',
  multi: '1.2.pdf',
  medium: '1. EWTL-Time-varying fields & Maxwells equations.pdf',
  large: 'merged.pdf',
};

// Optional suite: asserts corpus-specific facts (private titles, 39/2585 page
// counts) that cannot be synthesized honestly — SKIP cleanly when absent.
{
  const missing = missingFiles(Object.values(FILE_NAMES));
  if (missing.length > 0) reportOptionalSkip('thumbnail.e2e.mjs', missing);
}

/** Raw bytes per CDP chunk: 6 MB → ~8 MB base64 per evaluate call. */
const CHUNK_BYTES = 6 * 1024 * 1024;

/**
 * Pushes a file from disk into the page's byte store over CDP (no HTTP).
 * Preallocates the exact-size buffer in-page, then fills it chunk by
 * chunk so peak memory is one copy plus one transient chunk.
 */
async function pushBytes(page, id, absPath) {
  const stat = fs.statSync(absPath);
  const total = stat.size;
  await page.evaluate(
    ([key, size]) => {
      window.__thumbBytes = window.__thumbBytes ?? {};
      window.__thumbPending = window.__thumbPending ?? {};
      window.__thumbPending[key] = { buf: new Uint8Array(size), off: 0 };
    },
    [id, total],
  );
  const fd = fs.openSync(absPath, 'r');
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let sent = 0;
    let lastPct = -1;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, CHUNK_BYTES, sent);
      if (n <= 0) break;
      const b64 = chunk.subarray(0, n).toString('base64');
      sent += n;
      const off = await page.evaluate(
        ([key, b64chunk]) => {
          const bin = atob(b64chunk);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) {
            u8[i] = bin.charCodeAt(i);
          }
          const p = window.__thumbPending[key];
          p.buf.set(u8, p.off);
          p.off += u8.length;
          return p.off;
        },
        [id, b64],
      );
      const pct = Math.floor((sent / total) * 100);
      if (pct >= lastPct + 10 || sent === total) {
        lastPct = pct;
        console.log(
          `  push ${id}: ${(sent / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB (${pct}%)`,
        );
      }
      void off;
    }
    if (sent !== total) {
      throw new Error(`short read for ${id}: ${sent}/${total}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  const finalized = await page.evaluate(
    ([key, size]) => {
      const p = window.__thumbPending[key];
      const ok = p.off === size;
      window.__thumbBytes[key] = p.buf;
      delete window.__thumbPending[key];
      return { bytes: window.__thumbBytes[key].length, complete: ok };
    },
    [id, total],
  );
  if (!finalized.complete || finalized.bytes !== total) {
    throw new Error(`in-page assembly mismatch for ${id}`);
  }
  return finalized.bytes;
}

const results = [];
function check(name, ok, details) {
  results.push({ name, ok: Boolean(ok), details: details ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
}

async function main() {
  console.log(`DEV server: ${DEV_URL}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    protocolTimeout: 600000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--mute-audio',
      // Keep download-manager browser extensions out of the test profile.
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
    ],
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  const nonlocalRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Pre-existing app issue (Lesson 11/12): no favicon is shipped, so
      // Chrome logs a bare 404 resource error with no URL in the text.
      // It is identified by exclusion — `requestfailed` independently
      // asserts zero non-favicon failures below.
      if (text.includes('favicon')) {
        return;
      }
      if (/Failed to load resource.*404/.test(text)) {
        return;
      }
      consoleErrors.push(text.slice(0, 300));
    }
  });
  page.on('requestfailed', (req) => {
    if (!req.url().includes('favicon')) {
      failedRequests.push(`${req.url()} :: ${req.failure()?.errorText ?? 'failed'}`);
    }
  });
  page.on('request', (req) => {
    const url = req.url();
    // Local only: dev server, data/blob. Test bytes travel over CDP, never HTTP.
    const local = url.startsWith(DEV_URL) || url.startsWith('data:') || url.startsWith('blob:');
    if (!local && !url.includes('favicon')) {
      nonlocalRequests.push(url.slice(0, 200));
    }
  });

  await page.goto(DEV_URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction('Boolean(window.__folioRenderE2E?.createThumbnailEngines)', {
    timeout: 30000,
  });
  const info = await page.evaluate(async () => window.__folioRenderE2E.info());
  console.log(`PDF.js ${info.pdfjsVersion}, worker ${info.workerSrc}`);
  const workerLocal =
    typeof info.workerSrc === 'string' &&
    info.workerSrc.includes('pdf.worker') &&
    !/^https?:\/\/(?!localhost|127\.0\.0\.1)/.test(info.workerSrc);
  check('worker is same-origin local asset', workerLocal, info.workerSrc);

  // Push the two small files first (fast), so early phases run before the
  // 490 MB transfer.
  console.log('Pushing test bytes over CDP (no HTTP, IDM-proof)…');
  await pushBytes(page, 'small', path.resolve(PDF_DIR, FILE_NAMES.small));
  await pushBytes(page, 'multi', path.resolve(PDF_DIR, FILE_NAMES.multi));

  // All thumbnail work happens in-page through the real engines. Phase 1:
  // everything up to the large file.
  const phase1 = await page.evaluate(async (files) => {
    const out = {};
    const { renders, thumbnails } = await window.__folioRenderE2E.createThumbnailEngines();
    window.__thumbEngines = { renders, thumbnails };
    const store = window.__thumbBytes;

    function nonBlank(canvas) {
      // Sample up to ~2000 pixels; require variance (not a flat fill).
      const w = canvas.width;
      const h = canvas.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { ok: false, reason: 'no-2d-context' };
      const stepX = Math.max(1, Math.floor(w / 45));
      const stepY = Math.max(1, Math.floor(h / 45));
      const seen = new Set();
      for (let y = 0; y < h; y += stepY) {
        const row = ctx.getImageData(0, y, w, 1).data;
        for (let x = 0; x < w; x += stepX) {
          const i = x * 4;
          seen.add(`${row[i]},${row[i + 1]},${row[i + 2]},${row[i + 3]}`);
          if (seen.size > 4) {
            return { ok: true, samples: seen.size };
          }
        }
      }
      return { ok: false, reason: `flat:${seen.size}` };
    }
    window.__thumbNonBlank = nonBlank;

    // Instrument concurrency: wrap renderPage to count simultaneous calls.
    let active = 0;
    let maxActive = 0;
    const rawRenderPage = renders.renderPage.bind(renders);
    renders.renderPage = (docId, pageNum, canvas, opts) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const task = rawRenderPage(docId, pageNum, canvas, opts);
      const wrapped = task.promise.finally(() => {
        active -= 1;
      });
      return { promise: wrapped, cancel: task.cancel };
    };
    window.__thumbMaxActive = () => maxActive;
    window.__thumbResetMaxActive = () => {
      maxActive = 0;
    };

    // --- Small PDF: single portrait thumbnail ---
    const smallBytes = store.small;
    out.smallBytes = smallBytes.length;
    let t0 = performance.now();
    const loadedSmall = await renders.loadDocument({ data: smallBytes, name: files.small }).promise;
    out.smallLoadMs = performance.now() - t0;
    out.smallPageCount = loadedSmall.document.pageCount;
    const smallId = loadedSmall.document.id;
    window.__thumbSmallId = smallId;

    t0 = performance.now();
    const single = await thumbnails.generateThumbnail(smallId, 1, {
      size: { width: 200, height: 200 },
    }).promise;
    out.singleMs = performance.now() - t0;
    out.single = {
      page: single.pageNumber,
      w: single.width,
      h: single.height,
      scale: single.scale,
      rotation: single.rotation,
      srcW: single.sourcePageWidth,
      srcH: single.sourcePageHeight,
    };
    out.singleNonBlank = nonBlank(single.canvas);
    // Determinism: same page twice → same dims.
    const single2 = await thumbnails.generateThumbnail(smallId, 1, {
      size: { width: 200, height: 200 },
    }).promise;
    out.deterministic = single.width === single2.width && single.height === single2.height;

    // --- Landscape via rotation override (proves rotation path + wide geometry) ---
    const rotated = await thumbnails.generateThumbnail(smallId, 1, {
      size: { width: 200, height: 200 },
      rotation: 90,
    }).promise;
    out.rotated = { w: rotated.width, h: rotated.height, rotation: rotated.rotation };

    // --- Custom size ---
    const custom = await thumbnails.generateThumbnail(smallId, 1, {
      size: { width: 100, height: 60 },
    }).promise;
    out.custom = { w: custom.width, h: custom.height, scale: custom.scale };

    // --- Invalid pages (structured, no PDF.js leak) ---
    const invalidCodes = [];
    for (const bad of [0, 999999]) {
      try {
        await thumbnails.generateThumbnail(smallId, bad).promise;
        invalidCodes.push(`p${bad}:NO-THROW`);
      } catch (e) {
        invalidCodes.push(`p${bad}:${e?.code ?? e?.name ?? 'unknown'}`);
      }
    }
    out.invalidCodes = invalidCodes;

    // --- Batch ordering + progress on the 22-page doc ---
    const multiBytes = store.multi;
    const loadedMulti = await renders.loadDocument({ data: multiBytes, name: files.multi }).promise;
    const multiId = loadedMulti.document.id;
    window.__thumbMultiId = multiId;
    window.__thumbMultiBytes = multiBytes;
    out.multiPageCount = loadedMulti.document.pageCount;
    const orderPages = [5, 1, 3, 10].filter((p) => p <= loadedMulti.document.pageCount);
    const progressSeq = [];
    const delivered = [];
    t0 = performance.now();
    const batch = await thumbnails.generateThumbnails(multiId, orderPages, {
      size: { width: 120, height: 120 },
      concurrency: 2,
      onProgress: (p) => progressSeq.push(`${p.completed}/${p.total}`),
      onThumbnail: (r) => delivered.push(r.pageNumber),
    }).promise;
    out.batchMs = performance.now() - t0;
    out.batchOrder = batch.map((r) => r.pageNumber);
    out.batchExpected = orderPages;
    out.batchProgress = progressSeq;
    out.batchDelivered = delivered;
    out.batchDims = batch.map((r) => `${r.pageNumber}:${r.width}x${r.height}`);
    out.maxActiveAfterBatch = maxActive;

    // --- Cancellation on a medium batch (deterministic, fast) ---
    window.__thumbResetMaxActive();
    const cancelJob = thumbnails.generateThumbnails(
      multiId,
      Array.from({ length: loadedMulti.document.pageCount }, (_, i) => i + 1),
      {
        size: { width: 200, height: 200 },
        concurrency: 2,
      },
    );
    // Cancel on the next microtask: no new-page scheduling storm, actives aborted.
    setTimeout(() => cancelJob.cancel(), 5);
    let cancelCode = 'NO-THROW';
    try {
      await cancelJob.promise;
      cancelCode = 'RESOLVED (bad)';
    } catch (e) {
      cancelCode = e?.code ?? e?.name ?? String(e);
    }
    out.cancelCode = cancelCode;
    out.maxActiveCancel = window.__thumbMaxActive();

    // --- Render error: junk bytes must fail structured at load ---
    let junkCode = 'NO-THROW';
    try {
      await renders.loadDocument({ data: new Uint8Array([0, 1, 2, 3, 4, 5]), name: 'junk.pdf' })
        .promise;
    } catch (e) {
      junkCode = e?.code ?? e?.name ?? String(e);
    }
    out.junkCode = junkCode;

    // --- Closed-doc thumbnail + reload ---
    await renders.closeDocument(multiId);
    let closedCode = 'NO-THROW';
    try {
      await thumbnails.generateThumbnail(multiId, 1).promise;
    } catch (e) {
      closedCode = e?.code ?? e?.name ?? String(e);
    }
    out.closedCode = closedCode;
    const reloaded = await renders.loadDocument({ data: multiBytes, name: files.multi }).promise;
    const reThumb = await thumbnails.generateThumbnail(reloaded.document.id, 1).promise;
    out.reloadOk = reThumb.pageNumber === 1 && reThumb.width > 0;
    out.reloadDims = `${reThumb.width}x${reThumb.height}`;
    await renders.closeDocument(reloaded.document.id);
    await renders.closeDocument(smallId);

    return out;
  }, FILE_NAMES);

  console.log('\n--- phase 1 outcome ---');
  console.log(JSON.stringify(phase1, null, 2));

  // Push the remaining files over CDP (medium is ~1 MB, large is 490 MB).
  await pushBytes(page, 'medium', path.resolve(PDF_DIR, FILE_NAMES.medium));
  await pushBytes(page, 'large', path.resolve(PDF_DIR, FILE_NAMES.large));

  // Phase 2: 39-page document-wide + large-doc stress.
  const phase2 = await page.evaluate(async (files) => {
    const out = {};
    const { renders, thumbnails } = window.__thumbEngines;
    const store = window.__thumbBytes;
    const nonBlank = window.__thumbNonBlank;

    // --- Document-wide on the 39-page doc ---
    window.__thumbResetMaxActive();
    const medBytes = store.medium;
    out.mediumBytes = medBytes.length;
    let t0 = performance.now();
    const loadedMed = await renders.loadDocument({ data: medBytes, name: files.medium }).promise;
    out.mediumLoadMs = performance.now() - t0;
    out.mediumPageCount = loadedMed.document.pageCount;
    const medId = loadedMed.document.id;
    const medProgress = [];
    t0 = performance.now();
    const medAll = await thumbnails.generateDocumentThumbnails(medId, {
      size: { width: 200, height: 200 },
      concurrency: 2,
      onProgress: (p) => medProgress.push(p.completed),
    }).promise;
    out.mediumBatchMs = performance.now() - t0;
    out.mediumCount = medAll.length;
    out.mediumOrderOk = medAll.every((r, i) => r.pageNumber === i + 1);
    out.mediumProgressCount = medProgress.length;
    out.mediumFirst = { w: medAll[0].width, h: medAll[0].height, scale: medAll[0].scale };
    out.mediumNonBlank = nonBlank(medAll[0].canvas);
    out.maxActiveMedium = window.__thumbMaxActive();
    // Geometry sanity across all 39: fit + aspect preserved.
    out.mediumOversize = medAll.filter((r) => r.width > 200 || r.height > 200).length;
    await renders.closeDocument(medId);

    // --- Large doc: sparse set + cancel stress (never full retain) ---
    const largeBytes = store.large;
    out.largeBytes = largeBytes.length;
    t0 = performance.now();
    const loadedLarge = await renders.loadDocument({ data: largeBytes, name: files.large }).promise;
    out.largeLoadMs = performance.now() - t0;
    out.largePageCount = loadedLarge.document.pageCount;
    const largeId = loadedLarge.document.id;
    // Input bytes must survive PDF.js detach (Lesson 12 invariant).
    out.largeBytesIntact = largeBytes.length > 0;
    const n = loadedLarge.document.pageCount;
    const sparse = [1, 500, 1000, 1500, 2000, n].filter((p) => p >= 1 && p <= n);
    window.__thumbResetMaxActive();
    const sparseProgress = [];
    t0 = performance.now();
    const sparseRes = await thumbnails.generateThumbnails(largeId, sparse, {
      size: { width: 200, height: 200 },
      concurrency: 2,
      onProgress: (p) => sparseProgress.push(p.completed),
    }).promise;
    out.sparseMs = performance.now() - t0;
    out.sparsePages = sparseRes.map((r) => r.pageNumber);
    out.sparseDims = sparseRes.map((r) => `${r.pageNumber}:${r.width}x${r.height}`);
    out.sparseAvg = out.sparseMs / sparseRes.length;
    out.sparseProgress = sparseProgress;
    out.maxActiveSparse = window.__thumbMaxActive();
    out.sparseNonBlank = nonBlank(sparseRes[0].canvas);
    // Release sparse canvases immediately (no DOM retain).
    for (const r of sparseRes) {
      r.canvas.width = 0;
      r.canvas.height = 0;
    }
    // Cancel a whole-document run early: must reject CANCELLED, never success.
    window.__thumbResetMaxActive();
    const bigJob = thumbnails.generateDocumentThumbnails(largeId, {
      size: { width: 200, height: 200 },
      concurrency: 2,
    });
    setTimeout(() => bigJob.cancel(), 50);
    let bigCancel = 'NO-THROW';
    t0 = performance.now();
    try {
      await bigJob.promise;
      bigCancel = 'RESOLVED (bad)';
    } catch (e) {
      bigCancel = e?.code ?? e?.name ?? String(e);
    }
    out.bigCancelMs = performance.now() - t0;
    out.bigCancelCode = bigCancel;
    out.maxActiveBigCancel = window.__thumbMaxActive();
    // Document must remain usable after cancel.
    const afterCancel = await thumbnails.generateThumbnail(largeId, 3).promise;
    out.afterCancelOk = afterCancel.pageNumber === 3 && afterCancel.width > 0;
    t0 = performance.now();
    await renders.closeDocument(largeId);
    out.largeCloseMs = performance.now() - t0;
    // Heap snapshot (when available) for the Lesson 14 starting point.
    out.jsHeapMB =
      typeof performance !== 'undefined' && performance.memory
        ? Number((performance.memory.usedJSHeapSize / 1048576).toFixed(1))
        : null;

    return out;
  }, FILE_NAMES);

  console.log('\n--- phase 2 outcome ---');
  console.log(JSON.stringify(phase2, null, 2));

  const outcome = { ...phase1, ...phase2 };

  // --- Assertions ---
  check('small doc loads (1 page)', outcome.smallPageCount === 1, `${outcome.smallPageCount} pp`);
  check(
    'single portrait thumbnail fits 200x200 tall',
    outcome.single.h === 200 && outcome.single.w <= 200 && outcome.single.w < outcome.single.h,
    `${outcome.single.w}x${outcome.single.h} @${Number(outcome.single.scale).toFixed(4)}`,
  );
  check(
    'single thumbnail small-scale invariant (no huge render)',
    outcome.single.scale < 1,
    `scale=${outcome.single.scale}`,
  );
  check(
    'single thumbnail non-blank',
    outcome.singleNonBlank?.ok === true,
    JSON.stringify(outcome.singleNonBlank),
  );
  check('deterministic dimensions across rerenders', outcome.deterministic === true);
  check(
    'rotation override 90 → landscape + rotation 90',
    outcome.rotated.rotation === 90 && outcome.rotated.w === 200 && outcome.rotated.h < 200,
    `${outcome.rotated.w}x${outcome.rotated.h} rot=${outcome.rotated.rotation}`,
  );
  check(
    'custom size 100x60 respected',
    outcome.custom.w <= 100 && outcome.custom.h <= 60,
    `${outcome.custom.w}x${outcome.custom.h}`,
  );
  check(
    'invalid pages structured (THUMBNAIL_INVALID_PAGE)',
    Array.isArray(outcome.invalidCodes) &&
      outcome.invalidCodes.every((c) => String(c).includes('THUMBNAIL_INVALID_PAGE')),
    outcome.invalidCodes?.join(' '),
  );
  check('multi doc page count sane', outcome.multiPageCount >= 10, `${outcome.multiPageCount} pp`);
  check(
    'batch preserves input order',
    JSON.stringify(outcome.batchOrder) === JSON.stringify(outcome.batchExpected),
    `${JSON.stringify(outcome.batchOrder)}`,
  );
  check(
    'onThumbnail delivered in page order',
    JSON.stringify(outcome.batchDelivered) === JSON.stringify(outcome.batchExpected),
    `${JSON.stringify(outcome.batchDelivered)}`,
  );
  check(
    'progress fired once per thumbnail',
    outcome.batchProgress?.length === outcome.batchExpected?.length,
    outcome.batchProgress?.join(' '),
  );
  check(
    'batch bounded concurrency (max<=2)',
    outcome.maxActiveAfterBatch <= 2 && outcome.maxActiveAfterBatch >= 1,
    `max=${outcome.maxActiveAfterBatch}`,
  );
  check(
    '39-page doc loads as 39',
    outcome.mediumPageCount === 39,
    `${outcome.mediumPageCount} pp, load ${Number(outcome.mediumLoadMs).toFixed(0)} ms`,
  );
  check(
    '39-page doc → 39 thumbnails in order',
    outcome.mediumCount === 39 && outcome.mediumOrderOk === true,
    `count=${outcome.mediumCount} orderOk=${outcome.mediumOrderOk} in ${Number(outcome.mediumBatchMs).toFixed(0)} ms`,
  );
  check(
    '39-page progress events = 39',
    outcome.mediumProgressCount === 39,
    `${outcome.mediumProgressCount}`,
  );
  check(
    '39-page thumbnails fit target box',
    outcome.mediumOversize === 0,
    `oversize=${outcome.mediumOversize}`,
  );
  check('39-page first thumbnail non-blank', outcome.mediumNonBlank?.ok === true);
  check(
    '39-page bounded concurrency',
    outcome.maxActiveMedium <= 2,
    `max=${outcome.maxActiveMedium}`,
  );
  check(
    'mid-batch cancellation structured',
    outcome.cancelCode === 'THUMBNAIL_CANCELLED',
    outcome.cancelCode,
  );
  check(
    'junk bytes fail structured (RENDER_DOCUMENT_FAILED)',
    String(outcome.junkCode).includes('RENDER_DOCUMENT_FAILED'),
    outcome.junkCode,
  );
  check(
    'closed-doc thumbnail structured (THUMBNAIL_CLOSED)',
    outcome.closedCode === 'THUMBNAIL_CLOSED',
    outcome.closedCode,
  );
  check('cleanup→reload works', outcome.reloadOk === true, outcome.reloadDims);
  check(
    'large doc page count ~2585',
    outcome.largePageCount === 2585,
    `${outcome.largePageCount} pp, load ${Number(outcome.largeLoadMs).toFixed(0)} ms`,
  );
  check(
    'large sparse set renders in order',
    JSON.stringify(outcome.sparsePages) ===
      JSON.stringify([1, 500, 1000, 1500, 2000, 2585].filter((p) => p <= outcome.largePageCount)),
    `${JSON.stringify(outcome.sparsePages)} in ${Number(outcome.sparseMs).toFixed(0)} ms`,
  );
  check(
    'large sparse bounded concurrency',
    outcome.maxActiveSparse <= 2,
    `max=${outcome.maxActiveSparse}`,
  );
  check('large sparse first non-blank', outcome.sparseNonBlank?.ok === true);
  check(
    'large whole-doc cancel structured',
    outcome.bigCancelCode === 'THUMBNAIL_CANCELLED',
    `${outcome.bigCancelCode} in ${Number(outcome.bigCancelMs).toFixed(0)} ms (maxActive=${outcome.maxActiveBigCancel})`,
  );
  check('large doc usable after cancel', outcome.afterCancelOk === true);
  check(
    'zero failed requests',
    failedRequests.length === 0,
    failedRequests.slice(0, 3).join(' | '),
  );
  check(
    'zero non-local requests',
    nonlocalRequests.length === 0,
    nonlocalRequests.slice(0, 3).join(' | '),
  );
  check('zero console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  console.log('\n--- measurements ---');
  console.log(
    JSON.stringify(
      {
        small: {
          bytes: outcome.smallBytes,
          loadMs: outcome.smallLoadMs,
          singleMs: outcome.singleMs,
        },
        medium39: {
          bytes: outcome.mediumBytes,
          loadMs: outcome.mediumLoadMs,
          batchMs: outcome.mediumBatchMs,
          avgPerThumbMs: outcome.mediumCount ? outcome.mediumBatchMs / outcome.mediumCount : null,
        },
        large: {
          bytes: outcome.largeBytes,
          loadMs: outcome.largeLoadMs,
          sparseMs: outcome.sparseMs,
          sparseAvgMs: outcome.sparseAvg,
          bigCancelMs: outcome.bigCancelMs,
          jsHeapMB: outcome.jsHeapMB,
        },
      },
      null,
      2,
    ),
  );

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\nE2E: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('Failed:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('E2E fatal:', error);
  process.exit(1);
});
