/**
 * Lesson 14 large-file E2E (real headless Chrome, real PDF.js worker).
 *
 * Reproducible browser test matrix over small / medium / large PDFs:
 *
 * ```text
 * small:  generated.pdf (14 KB, 1 page)
 * multi:  1.2.pdf (~1 MB, 22 pages)
 * medium: 1. EWTL-Time-varying fields & Maxwells equations.pdf (~1 MB, 39 pages)
 * large:  merged.pdf (~490 MB, 2585 pages)
 * ```
 *
 * Large-document scenarios (each ends in `closeDocument`):
 *   A. load only                    E. sparse thumbs → release
 *   B. load → close                 F. cancel thumbnail batch
 *   C. render one → release         G. repeated render/cleanup cycles (same doc)
 *   D. sequential renders (1 canvas) H. repeated load → close cycles
 *   I. repeated load → thumb → release → close cycles
 * plus load/render cancellation, no-stale-document checks, bounded
 * concurrency instrumentation, and Lesson 12/13 regression spot-checks.
 *
 * IDM-proof transports (see e2e/thumbnail.e2e.mjs): test bytes travel
 * Node → page as base64 chunks over the DevTools protocol — zero HTTP
 * byte transfers, so download managers cannot intercept the harness.
 *
 * GC discipline: Chrome launches with `--js-flags=--expose-gc` and the
 * harness calls `gc()` before heap snapshots, so readings reflect
 * retained application references rather than uncollected garbage.
 * `performance.memory` covers the main-thread JS heap only (worker/GPU
 * memory is invisible); the report states trends with that caveat and
 * never claims exact ownership the browser cannot prove.
 *
 * Usage (from app/):
 *   1. Terminal A: npx vite --port 5199   (or any free port + --dev)
 *   2. Terminal B: node e2e/large-files.e2e.mjs [--dev http://localhost:5199]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

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

/** Raw bytes per CDP chunk: 6 MB → ~8 MB base64 per evaluate call. */
const CHUNK_BYTES = 6 * 1024 * 1024;

/** Generous heap-growth smoke bound per repeated-cycle stage (MiB). */
const HEAP_GROWTH_MARGIN_MB = 150;

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
      await page.evaluate(
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
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--js-flags=--expose-gc',
    ],
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  const nonlocalRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
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
    const local = url.startsWith(DEV_URL) || url.startsWith('data:') || url.startsWith('blob:');
    if (!local && !url.includes('favicon')) {
      nonlocalRequests.push(url.slice(0, 200));
    }
  });

  await page.goto(DEV_URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction('Boolean(window.__folioRenderE2E?.createThumbnailEngines)', {
    timeout: 30000,
  });

  console.log('Pushing test bytes over CDP (no HTTP, IDM-proof)…');
  await pushBytes(page, 'small', path.resolve(PDF_DIR, FILE_NAMES.small));
  await pushBytes(page, 'multi', path.resolve(PDF_DIR, FILE_NAMES.multi));
  await pushBytes(page, 'medium', path.resolve(PDF_DIR, FILE_NAMES.medium));

  // Phase 1: regression spot-checks + medium-doc lifecycle.
  const phase1 = await page.evaluate(async (files) => {
    const out = { stages: [] };
    const heapMB = () => {
      window.gc?.();
      const mem = performance.memory;
      return mem ? mem.usedJSHeapSize / 1048576 : null;
    };
    const { renders, thumbnails } = await window.__folioRenderE2E.createThumbnailEngines();
    window.__largeEngines = { renders, thumbnails };
    const store = window.__thumbBytes;

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
    const resetMax = () => {
      maxActive = 0;
    };
    const stage = (name, extra) => {
      out.stages.push({ name, heapMB: heapMB(), activeRenders: active, ...extra });
    };

    // --- Lesson 12 regression: render geometry matches dims floors ---
    const smallBytes = store.small;
    const loadedSmall = await renders.loadDocument({ data: smallBytes, name: files.small }).promise;
    const smallId = loadedSmall.document.id;
    const dims = await renders.getPageDimensions(smallId, 1);
    const c0 = document.createElement('canvas');
    const r0 = await renders.renderPage(smallId, 1, c0, { scale: 1 }).promise;
    out.l12 = {
      dimsW: dims.width,
      dimsH: dims.height,
      renderW: r0.page.width,
      renderH: r0.page.height,
      match: r0.page.width === Math.floor(dims.width) && r0.page.height === Math.floor(dims.height),
      rotation: r0.page.rotation,
    };
    c0.width = 0;
    c0.height = 0;

    // --- Lesson 13 regression: batch order + invalid page ---
    const multiBytes = store.multi;
    const loadedMulti = await renders.loadDocument({ data: multiBytes, name: files.multi }).promise;
    const multiId = loadedMulti.document.id;
    const batch = await thumbnails.generateThumbnails(multiId, [3, 1, 2]).promise;
    out.l13 = {
      order: batch.map((r) => r.pageNumber),
      orderOk: JSON.stringify(batch.map((r) => r.pageNumber)) === '[3,1,2]',
    };
    for (const r of batch) {
      r.canvas.width = 0;
      r.canvas.height = 0;
    }
    let invalidCode = 'NO-THROW';
    try {
      await thumbnails.generateThumbnail(multiId, 0).promise;
    } catch (e) {
      invalidCode = e?.code ?? String(e);
    }
    out.l13.invalidCode = invalidCode;
    await renders.closeDocument(multiId);
    await renders.closeDocument(smallId);

    // --- Medium doc: load only + heap ---
    const medBytes = store.medium;
    out.mediumBytes = medBytes.length;
    let t0 = performance.now();
    const loadedMed = await renders.loadDocument({ data: medBytes, name: files.medium }).promise;
    out.mediumLoadMs = performance.now() - t0;
    out.mediumPageCount = loadedMed.document.pageCount;
    const medId = loadedMed.document.id;
    stage('medium: after load');

    // --- Medium doc: repeated render/cleanup cycles on one canvas ---
    const canvas = document.createElement('canvas');
    out.mediumRenders = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      t0 = performance.now();
      const rr = await renders.renderPage(medId, 1, canvas, { scale: 1 }).promise;
      out.mediumRenders.push({
        cycle,
        ms: performance.now() - t0,
        dims: `${rr.page.width}x${rr.page.height}`,
      });
      canvas.width = 0;
      canvas.height = 0;
      stage(`medium: render cycle ${cycle + 1}`);
    }

    // --- Medium doc: windowed thumbnails (2 windows of 20/19), release between ---
    resetMax();
    const windows = [[], []];
    for (let p = 1; p <= loadedMed.document.pageCount; p += 1) {
      windows[p <= 20 ? 0 : 1].push(p);
    }
    out.mediumWindows = [];
    for (let w = 0; w < windows.length; w += 1) {
      t0 = performance.now();
      const res = await thumbnails.generateThumbnails(medId, windows[w], {
        size: { width: 120, height: 120 },
        concurrency: 2,
      }).promise;
      out.mediumWindows.push({ window: w, count: res.length, ms: performance.now() - t0 });
      for (const r of res) {
        r.canvas.width = 0;
        r.canvas.height = 0;
      }
      stage(`medium: window ${w + 1} released`);
    }
    out.mediumMaxActive = maxActive;
    t0 = performance.now();
    await renders.closeDocument(medId);
    out.mediumCloseMs = performance.now() - t0;
    out.mediumClosedClean = renders.getDocument(medId) === undefined;
    stage('medium: after close');

    return out;
  }, FILE_NAMES);

  console.log('\n--- phase 1 outcome ---');
  console.log(JSON.stringify(phase1, null, 2));

  await pushBytes(page, 'large', path.resolve(PDF_DIR, FILE_NAMES.large));

  // Phase 2: large-doc matrix A–I + cancellation + repeated cycles.
  const phase2 = await page.evaluate(async (files) => {
    const out = { stages: [] };
    const heapMB = () => {
      window.gc?.();
      const mem = performance.memory;
      return mem ? mem.usedJSHeapSize / 1048576 : null;
    };
    const { renders, thumbnails } = window.__largeEngines;
    const store = window.__thumbBytes;
    const largeBytes = store.large;
    out.largeBytes = largeBytes.length;
    const stage = (name, extra) => {
      out.stages.push({ name, heapMB: heapMB(), ...extra });
    };

    // A. load only
    let t0 = performance.now();
    const loaded = await renders.loadDocument({ data: largeBytes, name: files.large }).promise;
    out.loadMs = performance.now() - t0;
    out.pageCount = loaded.document.pageCount;
    const docId = loaded.document.id;
    stage('large A: after load');

    // Load cancellation (fresh load racing cancel → structured CANCELLED)
    const loadTask = renders.loadDocument({ data: largeBytes, name: files.large });
    loadTask.cancel();
    try {
      await loadTask.promise;
      out.loadCancelCode = 'RESOLVED (bad)';
    } catch (e) {
      out.loadCancelCode = e?.code ?? String(e);
    }

    // C. render one page → release
    const canvas = document.createElement('canvas');
    t0 = performance.now();
    const r1 = await renders.renderPage(docId, 3, canvas, { scale: 1 }).promise;
    out.renderMs = performance.now() - t0;
    out.renderDims = `${r1.page.width}x${r1.page.height}`;
    canvas.width = 0;
    canvas.height = 0;
    stage('large C: after render+release');

    // Render cancellation (immediate cancel → structured CANCELLED)
    const rc = renders.renderPage(docId, 4, document.createElement('canvas'), { scale: 1 });
    rc.cancel();
    try {
      await rc.promise;
      out.renderCancelCode = 'RESOLVED (bad)';
    } catch (e) {
      out.renderCancelCode = e?.code ?? String(e);
    }

    // D. sequential renders 1..5 on one canvas
    t0 = performance.now();
    for (let p = 1; p <= 5; p += 1) {
      await renders.renderPage(docId, p, canvas, { scale: 0.5 }).promise;
    }
    out.sequentialMs = performance.now() - t0;
    canvas.width = 0;
    canvas.height = 0;
    stage('large D: after 5 sequential renders');

    // E. sparse thumbnails → release
    const sparse = [1, 500, 1000, 1500, 2000, loaded.document.pageCount];
    t0 = performance.now();
    const thumbs = await thumbnails.generateThumbnails(docId, sparse, {
      size: { width: 200, height: 200 },
      concurrency: 2,
    }).promise;
    out.sparseMs = performance.now() - t0;
    out.sparsePages = thumbs.map((r) => r.pageNumber);
    for (const r of thumbs) {
      r.canvas.width = 0;
      r.canvas.height = 0;
    }
    stage('large E: after sparse release');

    // F. cancel a whole-document batch
    const bigJob = thumbnails.generateDocumentThumbnails(docId, {
      size: { width: 200, height: 200 },
      concurrency: 2,
    });
    setTimeout(() => bigJob.cancel(), 50);
    t0 = performance.now();
    try {
      await bigJob.promise;
      out.bigCancelCode = 'RESOLVED (bad)';
    } catch (e) {
      out.bigCancelCode = e?.code ?? String(e);
    }
    out.bigCancelMs = performance.now() - t0;
    stage('large F: after batch cancel');

    // G. repeated render/cleanup cycles on the same open doc
    out.cycleRenders = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      t0 = performance.now();
      await renders.renderPage(docId, 1, canvas, { scale: 1 }).promise;
      out.cycleRenders.push(performance.now() - t0);
      canvas.width = 0;
      canvas.height = 0;
      stage(`large G: render cycle ${cycle + 1}`);
    }

    // B/H/I share one closer: close, then repeated load→close ×3 …
    t0 = performance.now();
    await renders.closeDocument(docId);
    out.closeMs = performance.now() - t0;
    out.closedClean = renders.getDocument(docId) === undefined;
    stage('large B: after close');

    out.reloadCloses = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      t0 = performance.now();
      const rel = await renders.loadDocument({ data: largeBytes, name: files.large }).promise;
      const loadMs = performance.now() - t0;
      t0 = performance.now();
      await renders.closeDocument(rel.document.id);
      const stillThere = renders.getDocument(rel.document.id) !== undefined;
      out.reloadCloses.push({ cycle, loadMs, closeMs: performance.now() - t0, stale: stillThere });
      stage(`large H: load→close cycle ${cycle + 1}`);
    }

    // … then repeated load → sparse thumb → release → close ×3.
    out.fullCycles = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const rel = await renders.loadDocument({ data: largeBytes, name: files.large }).promise;
      const id = rel.document.id;
      const tr = await thumbnails.generateThumbnails(id, [1, 1000, rel.document.pageCount], {
        size: { width: 200, height: 200 },
        concurrency: 2,
      }).promise;
      const ok = tr.length === 3;
      for (const r of tr) {
        r.canvas.width = 0;
        r.canvas.height = 0;
      }
      await renders.closeDocument(id);
      const stale = renders.getDocument(id) !== undefined;
      out.fullCycles.push({ cycle, thumbsOk: ok, stale });
      stage(`large I: full cycle ${cycle + 1}`);
    }

    return out;
  }, FILE_NAMES);

  console.log('\n--- phase 2 outcome ---');
  console.log(JSON.stringify(phase2, null, 2));

  // --- Assertions ---
  const heapAt = (stages, name) => {
    const s = stages.find((x) => x.name === name);
    return s ? s.heapMB : null;
  };

  check(
    'L12 regression: render matches dims floors',
    phase1.l12?.match === true,
    `${phase1.l12?.renderW}x${phase1.l12?.renderH} vs dims ${phase1.l12?.dimsW}x${phase1.l12?.dimsH}`,
  );
  check(
    'L13 regression: batch order [3,1,2]',
    phase1.l13?.orderOk === true,
    JSON.stringify(phase1.l13?.order),
  );
  check(
    'L13 regression: invalid page structured',
    phase1.l13?.invalidCode === 'THUMBNAIL_INVALID_PAGE',
    phase1.l13?.invalidCode,
  );
  check('medium doc loads as 39', phase1.mediumPageCount === 39, `${phase1.mediumPageCount} pp`);
  check(
    'medium windowed thumbs cover 39 (20+19)',
    (phase1.mediumWindows?.[0]?.count ?? 0) + (phase1.mediumWindows?.[1]?.count ?? 0) === 39,
    JSON.stringify(phase1.mediumWindows),
  );
  check(
    'medium bounded concurrency (max<=2)',
    (phase1.mediumMaxActive ?? 99) <= 2,
    `max=${phase1.mediumMaxActive}`,
  );
  check('medium close leaves no stale document', phase1.mediumClosedClean === true);

  check(
    'large A: loads 2585 pages',
    phase2.pageCount === 2585,
    `${phase2.pageCount} pp in ${Number(phase2.loadMs).toFixed(0)} ms`,
  );
  check(
    'large load cancellation structured',
    phase2.loadCancelCode === 'RENDER_CANCELLED',
    phase2.loadCancelCode,
  );
  check(
    'large C: renders one page',
    typeof phase2.renderDims === 'string' && phase2.renderDims.includes('x'),
    `${phase2.renderDims} in ${Number(phase2.renderMs).toFixed(0)} ms`,
  );
  check(
    'large render cancellation structured',
    phase2.renderCancelCode === 'RENDER_CANCELLED',
    phase2.renderCancelCode,
  );
  check(
    'large D: 5 sequential renders reuse one canvas',
    Number(phase2.sequentialMs) > 0,
    `${Number(phase2.sequentialMs).toFixed(0)} ms`,
  );
  check(
    'large E: sparse thumbs in order',
    JSON.stringify(phase2.sparsePages) === JSON.stringify([1, 500, 1000, 1500, 2000, 2585]),
    `${JSON.stringify(phase2.sparsePages)} in ${Number(phase2.sparseMs).toFixed(0)} ms`,
  );
  check(
    'large F: batch cancel structured',
    phase2.bigCancelCode === 'THUMBNAIL_CANCELLED',
    `${phase2.bigCancelCode} in ${Number(phase2.bigCancelMs).toFixed(0)} ms`,
  );
  check(
    'large G: render cycles stable',
    Array.isArray(phase2.cycleRenders) && phase2.cycleRenders.length === 3,
    (phase2.cycleRenders ?? []).map((ms) => Number(ms).toFixed(0)).join(', ') + ' ms',
  );
  check(
    'large B: close leaves no stale document',
    phase2.closedClean === true,
    `close ${Number(phase2.closeMs).toFixed(1)} ms`,
  );
  check(
    'large H: 3× load→close, no stale docs',
    Array.isArray(phase2.reloadCloses) &&
      phase2.reloadCloses.length === 3 &&
      phase2.reloadCloses.every((c) => !c.stale),
    (phase2.reloadCloses ?? [])
      .map((c) => `${Number(c.loadMs).toFixed(0)}/${Number(c.closeMs).toFixed(1)}`)
      .join(' '),
  );
  check(
    'large I: 3× full cycles, thumbs ok, no stale docs',
    Array.isArray(phase2.fullCycles) &&
      phase2.fullCycles.length === 3 &&
      phase2.fullCycles.every((c) => c.thumbsOk && !c.stale),
  );

  // Heap-trend smoke bound: with gc() before each snapshot, repeated
  // identical cycles must not accumulate application-level references
  // beyond a generous margin (GC/worker timing noise, not a perf claim).
  const heapChecks = [];
  const hStages = phase2.stages.filter((s) => s.heapMB !== null);
  const hH1 = heapAt(phase2.stages, 'large H: load→close cycle 1');
  const hH3 = heapAt(phase2.stages, 'large H: load→close cycle 3');
  if (hH1 !== null && hH3 !== null) {
    heapChecks.push([
      'H cycles heap bounded',
      hH3 - hH1 <= HEAP_GROWTH_MARGIN_MB,
      `cycle1=${hH1.toFixed(0)} cycle3=${hH3.toFixed(0)} MB`,
    ]);
  }
  const hI1 = heapAt(phase2.stages, 'large I: full cycle 1');
  const hI3 = heapAt(phase2.stages, 'large I: full cycle 3');
  if (hI1 !== null && hI3 !== null) {
    heapChecks.push([
      'I cycles heap bounded',
      hI3 - hI1 <= HEAP_GROWTH_MARGIN_MB,
      `cycle1=${hI1.toFixed(0)} cycle3=${hI3.toFixed(0)} MB`,
    ]);
  }
  if (heapChecks.length === 0) {
    heapChecks.push([
      'heap readings available',
      false,
      'performance.memory unsupported in this browser',
    ]);
  }
  for (const [name, ok, details] of heapChecks) {
    check(name, ok, details);
  }
  void hStages;

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
        medium39: {
          bytes: phase1.mediumBytes,
          loadMs: phase1.mediumLoadMs,
          renders: phase1.mediumRenders,
          windows: phase1.mediumWindows,
          closeMs: phase1.mediumCloseMs,
        },
        large: {
          bytes: phase2.largeBytes,
          loadMs: phase2.loadMs,
          renderMs: phase2.renderMs,
          renderDims: phase2.renderDims,
          sequentialMs: phase2.sequentialMs,
          sparseMs: phase2.sparseMs,
          bigCancelMs: phase2.bigCancelMs,
          closeMs: phase2.closeMs,
          reloadCloses: phase2.reloadCloses,
          cycleRenders: phase2.cycleRenders,
        },
        heapStages: [...phase1.stages, ...phase2.stages].map((s) => ({
          stage: s.name,
          heapMB: s.heapMB === null ? null : Number(s.heapMB.toFixed(1)),
        })),
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
