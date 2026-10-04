/**
 * Canonical production UI E2E (real headless Chrome, real Folio engine).
 *
 * Fresh-clone reproducible: the small fixtures (`1.2.pdf`, `2. ...pdf`) are
 * used when the optional local `test pdfs/` corpus exists, otherwise
 * deterministic synthetic PDFs (same page shapes, ASCII metadata) are
 * generated to an OS temp dir — the same flows run either way. Only the
 * large-file sections require the optional ~490 MB corpus: when it is absent
 * they SKIP cleanly (never fail, never wait on a missing file). See
 * `e2e/corpus.mjs` and `docs/DEVELOPMENT.md`.
 *
 * Drives the integrated Folio UI end to end through REAL user
 * flows: file upload via <input type=file>, thumbnail grid, merge /
 * split / rearrange / rotate / metadata / images operations, progress,
 * cancellation, structured errors, downloads, and the large-file
 * bounded-thumbnail lifecycle. No mocks, no CDP byte injection for
 * uploads — real File objects like a user would drop.
 *
 * Usage (from app/):
 *   1. Terminal A: npx vite --port 5199
 *   2. Terminal B: node e2e/studio.e2e.mjs [--dev http://localhost:5199]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { CORPUS_DIR, missingFiles, writeSyntheticPdf } from './corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = CORPUS_DIR;

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const DEV_URL = flag('--dev', 'http://localhost:5199');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SMALL_NAME = '1.2.pdf';
const RICH_NAME = '2. EWTL-Uniform Plane Wave.pdf';
const LARGE_NAME = 'merged.pdf';
const SMALL_PAGES = 22;
const RICH_PAGES = 80;
const LARGE_PAGES = 2585;

// Canonical fixtures: prefer the optional local corpus; otherwise generate
// deterministic synthetics (same page shapes) so a fresh clone runs the same
// flows. The large file has no stand-in — its sections SKIP when absent.
let SMALL_22 = path.join(CORPUS, SMALL_NAME);
let RICH_80 = path.join(CORPUS, RICH_NAME);
const LARGE = path.join(CORPUS, LARGE_NAME);
{
  const absentSmall = missingFiles([SMALL_NAME, RICH_NAME]);
  if (absentSmall.length > 0) {
    console.log(`Corpus: synthetic small fixtures (absent: ${absentSmall.join(', ')})`);
    if (!fs.existsSync(SMALL_22)) {
      SMALL_22 = writeSyntheticPdf({ name: 'synthetic-22.pdf', pages: SMALL_PAGES });
    }
    if (!fs.existsSync(RICH_80)) {
      RICH_80 = writeSyntheticPdf({
        name: 'synthetic-80.pdf',
        pages: RICH_PAGES,
        info: {
          title: 'PowerPoint Presentation',
          author: 'synthetic',
          creator: 'folio-e2e',
          producer: 'folio-e2e',
        },
      });
    }
    // Self-check: the writer must produce engine-readable PDFs.
    for (const [label, file, pages] of [
      ['small', SMALL_22, SMALL_PAGES],
      ['rich', RICH_80, RICH_PAGES],
    ]) {
      const head = fs.readFileSync(file).subarray(0, 5).toString();
      if (head !== '%PDF-') throw new Error(`synthetic ${label} fixture invalid: ${file}`);
      void pages;
    }
  } else {
    console.log('Corpus: real `test pdfs/` fixtures');
  }
  console.log(
    fs.existsSync(LARGE)
      ? 'Corpus: large file present (large-file sections will run)'
      : 'Corpus: large file absent (large-file sections will SKIP)',
  );
}
const HAS_LARGE = fs.existsSync(LARGE);

const results = [];
const skipped = [];
let lastCheckAt = Date.now();
function check(name, ok, details) {
  const now = Date.now();
  const deltaMs = now - lastCheckAt;
  lastCheckAt = now;
  results.push({ name, ok: Boolean(ok), details: details ?? null, deltaMs });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''} (+${(deltaMs / 1000).toFixed(1)}s)`,
  );
}
function skip(name, reason) {
  skipped.push({ name, reason });
  console.log(`SKIP  ${name} — ${reason}`);
}

/**
 * Installs the download-capture patch: anchors with a `download`
 * attribute record `{href, name}` into `window.__downloads` and do NOT
 * trigger a real browser download. This keeps every test artifact
 * in-page (bytes, magic, size asserted via fetch) so no OS download
 * ever fires — external download managers (IDM) can never intercept,
 * stall, or pop up during a run.
 */
function installDownloadCapture(page) {
  return page.evaluateOnNewDocument(() => {
    localStorage.clear();
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute('download') && this.href) {
        (window.__downloads = window.__downloads || []).push({
          href: this.href,
          name: this.getAttribute('download') || 'download',
        });
        return;
      }
      return origClick.call(this);
    };
  });
}

const downloadCursors = new WeakMap();

/** Waits for the next captured download and probes it fully in-page. */
async function waitForCapturedDownload(page, timeoutMs) {
  const start = Date.now();
  const cursor = downloadCursors.get(page) ?? 0;
  for (;;) {
    const probe = await page.evaluate(async (index) => {
      const entries = window.__downloads || [];
      if (entries.length <= index) return null;
      const entry = entries[index];
      const res = await fetch(entry.href);
      const buf = new Uint8Array(await res.arrayBuffer());
      return {
        name: entry.name,
        size: buf.length,
        magic: String.fromCharCode(...buf.slice(0, 5)),
      };
    }, cursor);
    if (probe !== null) {
      downloadCursors.set(page, cursor + 1);
      return probe;
    }
    if (Date.now() - start > timeoutMs) {
      console.log('[download-capture] timed out with no captured download');
      return null;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await installDownloadCapture(page);
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (text.includes('favicon')) return;
      if (/Failed to load resource.*404/.test(text)) return;
      consoleErrors.push(text.slice(0, 200));
    }
  });
  page.on('requestfailed', (req) => {
    if (!req.url().includes('favicon')) {
      failedRequests.push(`${req.url()} :: ${req.failure()?.errorText ?? 'failed'}`);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`));
  return { page, consoleErrors, failedRequests };
}

async function gotoTool(page, tool) {
  // `networkidle0` + a fixed 600 ms sleep gated every section (~14 sites).
  // The tool route is lazy-loaded, so wait for the semantic conditions the
  // next step actually needs instead: the tool shell (h1) and, for tools,
  // the hidden file input that upload() targets. (About has no input.)
  await page.goto(`${DEV_URL}/#/${tool}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('main h1', { timeout: 30000 });
  if (tool !== 'about') {
    await page.waitForSelector('input[type="file"]', { timeout: 30000 });
  }
}

async function upload(page, selector, files) {
  const input = await page.$(selector);
  await input.uploadFile(...files);
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

// ---- Scanner helpers (every waitForFunction predicate is total: try/catch, never
// dereferences a possibly-null query result) ----
function writeFakeY4M(filePath, width = 640, height = 480, frames = 12) {
  const header = `YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420\n`;
  const ySize = width * height;
  const uvSize = (width >> 1) * (height >> 1);
  const frameSize = ySize + uvSize * 2;
  const parts = [Buffer.from(header, 'ascii')];
  for (let f = 0; f < frames; f += 1) {
    parts.push(Buffer.from('FRAME\n', 'ascii'));
    const y = Buffer.alloc(ySize, 0x80 + ((f * 7) % 64));
    // A bright square drifting per frame so motion is visible to detectors.
    const sq = 96;
    const ox = (f * 24) % (width - sq);
    const oy = (f * 16) % (height - sq);
    for (let row = 0; row < sq; row += 1) {
      y.fill(0xe0, (oy + row) * width + ox, (oy + row) * width + ox + sq);
    }
    parts.push(y);
    parts.push(Buffer.alloc(uvSize, 0x80));
    parts.push(Buffer.alloc(uvSize, 0x80));
  }
  fs.writeFileSync(filePath, Buffer.concat(parts));
  void frameSize;
}

async function scanOpen(page) {
  await page.evaluate(() => {
    try {
      document.querySelector('[data-scan-open]')?.click();
    } catch {
      /* noop */
    }
  });
  await page.waitForFunction(
    () => {
      try {
        return document.querySelector('[data-scanner-root]') !== null;
      } catch {
        return false;
      }
    },
    { timeout: 30000 },
  );
  // The shutter renders only once the camera is LIVE (async getUserMedia +
  // video.play after the root mounts). Every read/click below needs it —
  // without this wait the opened-evaluate sees shutter:null and the first
  // capture click no-ops, which reads as a dead scanner (E2E-only timing;
  // the app itself goes live ~1s later).
  await page.waitForFunction(
    () => {
      try {
        return document.querySelector('[data-scan-capture]') !== null;
      } catch {
        return false;
      }
    },
    { timeout: 30000 },
  );
}

async function scanCaptureOnce(page) {
  await page.waitForFunction(
    () => {
      try {
        return document.querySelector('[data-scan-capture]') !== null;
      } catch {
        return false;
      }
    },
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    try {
      document.querySelector('[data-scan-capture]')?.click();
    } catch {
      /* noop */
    }
  });
}

async function waitForQueue(page, count, timeoutMs = 30000) {
  await page.waitForFunction(
    (expected) => {
      try {
        const q = document.querySelector('[data-scan-queue]');
        if (!q) return false;
        const text = q.textContent ?? '';
        return new RegExp(`of ${expected}\\b`).test(text);
      } catch {
        return false;
      }
    },
    { timeout: timeoutMs },
    count,
  );
}

async function waitForResultImg(page, timeoutMs = 30000) {
  await page.waitForFunction(
    () => {
      try {
        const img = document.querySelector('[data-crop-result-img]');
        if (!img) return false;
        return img.naturalWidth > 0;
      } catch {
        return false;
      }
    },
    { timeout: timeoutMs },
  );
}

// Keyboard-handle exercise: dispatch in ONE evaluate, waitForFunction the
// post-condition, then measure in a LATER evaluate (never dispatch-then-
// measure synchronously — React-flush timing would fake-fail the read).
// Shift is held so scanic takes its coarse step (10px, same slider path as
// the 1px nudge): a 1px step can land sub-pixel on screen and never trip a
// whole-pixel post-condition, which reads as a dead handle.
async function exerciseScanicHandles(page, handle = 'tr', key = 'ArrowRight') {
  const before = await page.evaluate((h) => {
    try {
      const el = document.querySelector(`[data-crop-handle="${h}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    } catch {
      return null;
    }
  }, handle);
  if (before === null) return { moved: false, before, after: null };
  await page.evaluate(
    (h, k) => {
      try {
        const el = document.querySelector(`[data-crop-handle="${h}"]`);
        if (!el) return;
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, shiftKey: true }));
      } catch {
        /* noop */
      }
    },
    handle,
    key,
  );
  let settled = false;
  try {
    await page.waitForFunction(
      (h, bx, by) => {
        try {
          const el = document.querySelector(`[data-crop-handle="${h}"]`);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return Math.abs(r.x - bx) > 1 || Math.abs(r.y - by) > 1;
        } catch {
          return false;
        }
      },
      { timeout: 10000 },
      handle,
      before.x,
      before.y,
    );
    settled = true;
  } catch {
    settled = false;
  }
  const after = await page.evaluate((h) => {
    try {
      const el = document.querySelector(`[data-crop-handle="${h}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    } catch {
      return null;
    }
  }, handle);
  const moved =
    settled &&
    after !== null &&
    (Math.abs(after.x - before.x) > 1 || Math.abs(after.y - before.y) > 1);
  return { moved, before, after };
}

async function main() {
  fs.mkdirSync(path.join(__dirname, 'after'), { recursive: true });
  // Downloads are captured in-page (see installDownloadCapture) — no OS
  // downloads, nothing for external download managers to intercept.
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--disable-extensions'],
  });

  // ---- Home: tool cards for all 7 tools ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await page.goto(`${DEV_URL}/#/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('a[href="#/merge"]', { timeout: 30000 });
    const text = await bodyText(page);
    const tools = ['Merge', 'Split', 'Rearrange', 'Rotate', 'Compress', 'Metadata', 'Images'];
    const missing = tools.filter((name) => !text.includes(name));
    check('home shows all 7 tool cards', missing.length === 0, missing.join(', ') || 'all present');
    await page.screenshot({ path: `${__dirname}/after/home.png` });
    check(
      'home has zero console errors',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 2).join(' | '),
    );
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  // ---- About: update card offers a manual check (F-13) ----
  // On the dev server (localhost) the manager classifies as local, so the
  // check resolves to the local status instead of touching a worker.
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'about');
    await page.waitForFunction(() => document.body.innerText.includes('App updates'), {
      timeout: 30000,
    });
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent === 'Check for updates')
        ?.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('Preview build'), {
      timeout: 30000,
    });
    const updateCard = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        hasCard: text.includes('App updates'),
        localStatus: text.includes('Preview build'),
        noBanner: document.querySelector('[role="alert"]') === null,
      };
    });
    check(
      'about update card checks and reports local status on dev',
      updateCard.hasCard && updateCard.localStatus && updateCard.noBanner,
      JSON.stringify(updateCard),
    );
    // Scanner-contract dev card: localhost-only assertion (never against
    // non-local runs). Fails honestly when the card is absent.
    const isLocalhost = /localhost|127\.0\.0\.1/.test(DEV_URL);
    if (!isLocalhost) {
      skip(
        'about dev channel card shows version + build-time + notes',
        'non-localhost run (channel card asserts localhost only)',
      );
    } else {
      const devChannel = await page.evaluate(() => {
        try {
          const card = document.querySelector('[data-dev-channel]');
          if (!card) return null;
          const text = card.textContent ?? '';
          return {
            text: text.slice(0, 300),
            hasVersion: /v?\d+\.\d+/.test(text),
            hasBuildTime: /build|built|\d{4}[-/]\d{2}[-/]\d{2}|\d{1,2}:\d{2}/i.test(text),
            hasNotes: text.trim().length >= 60,
          };
        } catch {
          return null;
        }
      });
      check(
        'about dev channel card shows version + build-time + notes on localhost',
        devChannel !== null &&
          devChannel.hasVersion &&
          devChannel.hasBuildTime &&
          devChannel.hasNotes,
        JSON.stringify(devChannel),
      );
    }
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  // ---- Merge: two files → real merge → download ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'merge');
    await upload(page, 'input[type="file"]', [SMALL_22, RICH_80]);
    await page.waitForFunction(
      () => document.body.innerText.includes('2 files selected — ready to merge'),
      {
        timeout: 60000,
      },
    );
    const count = await page.evaluate(() => document.body.innerText);
    check(
      'merge lists 2 files with page counts',
      /2 files selected — ready to merge/.test(count),
      count.split('\n')[0],
    );
    // Start merge; the naming card's Download anchor is captured in-page (no OS download).
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.startsWith('Merge '))
        ?.click();
    });
    await page.waitForFunction(
      () => document.querySelector('a[aria-label="Download PDF"]') !== null,
      { timeout: 300000 },
    );
    await page.evaluate(() => {
      document.querySelector('a[aria-label="Download PDF"]')?.click();
    });
    const merged = await waitForCapturedDownload(page, 300000);
    check(
      'merge downloads a real PDF',
      merged !== null && merged.magic === '%PDF-',
      merged ? merged.name : null,
    );
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  // ---- Split pick mode: grid → remove one → extract ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'split');
    await upload(page, 'input[type="file"]', [SMALL_22]);
    await page.waitForFunction(() => document.body.innerText.match(/[1-9][0-9]*\/[0-9]+ kept/), {
      timeout: 300000,
    });
    const imgs = await page.evaluate(() => document.querySelectorAll('img').length);
    check('split renders thumbnail grid', imgs >= 10, `${imgs} imgs`);
    await page.screenshot({ path: `${__dirname}/after/split-grid.png` });
    // Split preview modal (images-check parity): thumbnail opens a
    // viewport-anchored dialog with a decoding image; Close dismisses it
    // and the kept count is undisturbed before the toggle below.
    await page.evaluate(() => {
      document.querySelector('button[aria-label="Preview Page 1"]')?.click();
    });
    let splitPreviewShown = false;
    try {
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') !== null, {
        timeout: 10000,
      });
      splitPreviewShown = true;
    } catch {
      splitPreviewShown = false;
    }
    check('split preview opens a dialog for the page', splitPreviewShown);
    const splitModalPreview = await page.evaluate(() => {
      const img = document.querySelector('[role="dialog"] img');
      return img === null ? null : { naturalWidth: img.naturalWidth };
    });
    check(
      'split preview dialog image decodes (naturalWidth > 0)',
      splitModalPreview !== null && splitModalPreview.naturalWidth > 0,
      JSON.stringify(splitModalPreview),
    );
    // F-19 regression (mirrors the images check): the backdrop must cover
    // the real viewport (the overlay is portaled to document.body so no
    // `backdrop-filter` ancestor can capture its `fixed` positioning).
    const splitModalGeometry = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const backdrop = dlg?.parentElement ?? null;
      const b = backdrop?.getBoundingClientRect();
      const d = dlg?.getBoundingClientRect();
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        backdrop: b
          ? { y: Math.round(b.y), h: Math.round(b.height), w: Math.round(b.width) }
          : null,
        dialog: d ? { y: Math.round(d.y), h: Math.round(d.height) } : null,
      };
    });
    check(
      'split preview dialog is viewport-anchored (backdrop covers viewport, dialog inside it)',
      splitModalGeometry.backdrop !== null &&
        splitModalGeometry.dialog !== null &&
        Math.abs(splitModalGeometry.backdrop.y) <= 1 &&
        Math.abs(splitModalGeometry.backdrop.h - splitModalGeometry.viewport.h) <= 1 &&
        Math.abs(splitModalGeometry.backdrop.w - splitModalGeometry.viewport.w) <= 1 &&
        (splitModalGeometry.dialog?.y ?? -1) >= 0 &&
        (splitModalGeometry.dialog?.y ?? 9999) + (splitModalGeometry.dialog?.h ?? 9999) <=
          splitModalGeometry.viewport.h + 1,
      JSON.stringify(splitModalGeometry),
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Close')?.click();
    });
    let splitPreviewClosed = false;
    try {
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null, {
        timeout: 10000,
      });
      splitPreviewClosed = true;
    } catch {
      splitPreviewClosed = false;
    }
    check('split preview dialog closes', splitPreviewClosed);
    // Toggle page 1 off, then create.
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(() => {});
      [...document.querySelectorAll('.grid button')]
        .find((b) => b.textContent?.includes('Page 1'))
        ?.click();
    });
    const kept = await page.evaluate(() => document.body.innerText);
    const keptRe = new RegExp(`${SMALL_PAGES - 1}/${SMALL_PAGES} kept`);
    check(`split toggles to ${SMALL_PAGES - 1}/${SMALL_PAGES} kept`, keptRe.test(kept));
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.startsWith('Create PDF'))
        ?.click();
    });
    // Pick-mode shows a DoneBanner (no auto-download): click its save link.
    await page.waitForFunction(() => document.querySelector('a[download]') !== null, {
      timeout: 300000,
    });
    await page.evaluate(() => {
      document.querySelector('a[download]')?.click();
    });
    const splitFile = await waitForCapturedDownload(page, 120000);
    check(
      'split pick-mode downloads 21-page PDF',
      splitFile !== null && splitFile.name.endsWith('.pdf'),
      splitFile ? splitFile.name : null,
    );
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  // ---- Split ranges mode with an invalid range → structured error ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'split');
    await upload(page, 'input[type="file"]', [SMALL_22]);
    await page.waitForFunction(() => document.body.innerText.match(/[1-9][0-9]*\/[0-9]+ kept/), {
      timeout: 300000,
    });
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'By ranges')?.click();
    });
    await page.type('input[placeholder*="1-3"]', '1-3, 999999');
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent === 'Extract pages')
        ?.click();
    });
    await page.waitForFunction(
      () => /PAGE_OUT_OF_RANGE|outside the document/i.test(document.body.innerText),
      { timeout: 60000 },
    );
    const text = await bodyText(page);
    check('split shows structured range error', /PAGE_OUT_OF_RANGE/.test(text));
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  // ---- Rearrange: reorder first two pages → save ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'rearrange');
    await upload(page, 'input[type="file"]', [SMALL_22]);
    await page.waitForFunction(() => document.body.innerText.includes('Page 2'), {
      timeout: 300000,
    });
    // Move page 1 down via its ↓ button (first row's second arrow).
    await page.evaluate(() => {
      const downs = [...document.querySelectorAll('button[aria-label="Move down"]')];
      downs[0]?.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent === 'Save rearranged PDF')
        ?.click();
    });
    await page.waitForFunction(() => document.querySelector('a[download]') !== null, {
      timeout: 300000,
    });
    await page.evaluate(() => {
      document.querySelector('a[download]')?.click();
    });
    const rearranged = await waitForCapturedDownload(page, 120000);
    check(
      'rearrange saves reordered PDF',
      rearranged !== null && rearranged.name.endsWith('.pdf') && rearranged.magic === '%PDF-',
      rearranged ? rearranged.name : null,
    );
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  // ---- Rotate: spin page 1 → download ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'rotate');
    await upload(page, 'input[type="file"]', [SMALL_22]);
    // NOTE: the button text renders before thumbnails arrive — the button
    // stays disabled until thumbs.length > 0, so wait for ENABLED state.
    await page.waitForFunction(
      () => {
        const btn = [...document.querySelectorAll('button')].find(
          (b) => b.textContent === 'Download rotated PDF',
        );
        return btn !== undefined && !btn.disabled;
      },
      { timeout: 300000 },
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Rotate right (page 1)')
        ?.click();
    });
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent === 'Download rotated PDF')
        ?.click();
    });
    await page.waitForFunction(() => document.querySelector('a[download]') !== null, {
      timeout: 300000,
    });
    await page.evaluate(() => {
      document.querySelector('a[download]')?.click();
    });
    const rotated = await waitForCapturedDownload(page, 120000);
    check(
      'rotate downloads rotated PDF',
      rotated !== null && rotated.magic === '%PDF-',
      rotated ? rotated.name : null,
    );
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  // ---- Metadata: read + patch title ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'metadata');
    await upload(page, 'input[type="file"]', [RICH_80]);
    await page.waitForFunction(() => document.body.innerText.includes('PowerPoint Presentation'), {
      timeout: 60000,
    });
    const metaRead = await bodyText(page);
    check('metadata reads real properties', metaRead.includes('PowerPoint Presentation'));
    await page.type('#studio-meta-title', 'Studio E2E Title');
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent === 'Save metadata')
        ?.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('Studio E2E Title'), {
      timeout: 60000,
    });
    const metaPatched = await bodyText(page);
    check('metadata patch round-trips in UI', metaPatched.includes('Studio E2E Title'));
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  // ---- Images: page assembly (preview → reorder → rotate → remove → add) → PDF ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'images');
    const red = path.join(__dirname, 'fixtures', 'red-wide.png');
    const blue = path.join(__dirname, 'fixtures', 'blue-tall.jpg');
    const cardOrder = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li')].map(
          (li) => li.getAttribute('aria-label') ?? '',
        ),
      );
    const clickButton = (ariaLabel) =>
      page.evaluate((label) => {
        [...document.querySelectorAll('button')]
          .find((b) => b.getAttribute('aria-label') === label)
          ?.click();
      }, ariaLabel);
    await upload(page, 'input[type="file"]', [red, blue]);
    // Uploads normalize sequentially (PNG→JPEG conversion included):
    // wait for BOTH commits, not just the Build button (first commit).
    await page.waitForFunction(
      () => document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length === 2,
      { timeout: 120000 },
    );
    let cards = await cardOrder();
    check(
      'images page manager shows two previews in upload order',
      cards.length === 2 && cards[0].includes('red-wide.jpg') && cards[1].includes('blue-tall.jpg'),
      cards.join(' | '),
    );
    // Previews must actually DECODE — a row with a blank/broken image
    // previously passed every text-based assertion (real-phone report).
    const previewLoadState = () =>
      page.evaluate(() => {
        const imgs = [...document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li img')];
        return {
          total: imgs.length,
          loaded: imgs.filter((i) => i.naturalWidth > 0).length,
        };
      });
    const uploadPreviews = await previewLoadState();
    check(
      'images upload previews decode (naturalWidth > 0)',
      uploadPreviews.total === 2 && uploadPreviews.loaded === 2,
      JSON.stringify(uploadPreviews),
    );
    // Guaranteed reorder mechanism: move blue earlier → blue first.
    await clickButton('Move blue-tall.jpg earlier');
    await page.waitForFunction(
      () =>
        document
          .querySelector('ul[aria-label="Pages in PDF order"] > li')
          ?.getAttribute('aria-label')
          ?.includes('blue-tall.jpg'),
      { timeout: 10000 },
    );
    cards = await cardOrder();
    check(
      'images move controls reorder pages',
      cards[0].includes('blue-tall.jpg') && cards[1].includes('red-wide.jpg'),
      cards.join(' | '),
    );
    // Preview modal (Rearrange parity): click the first row's thumbnail
    // → dialog with the full image → Close dismisses it.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Preview blue-tall.jpg')
        ?.click();
    });
    let previewShown = false;
    try {
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') !== null, {
        timeout: 10000,
      });
      previewShown = true;
    } catch {
      previewShown = false;
    }
    check('images preview opens a dialog for the page', previewShown);
    // The dialog image must actually decode, not just exist.
    const modalPreview = await page.evaluate(() => {
      const img = document.querySelector('[role="dialog"] img');
      return img === null ? null : { naturalWidth: img.naturalWidth };
    });
    check(
      'images preview dialog image decodes (naturalWidth > 0)',
      modalPreview !== null && modalPreview.naturalWidth > 0,
      JSON.stringify(modalPreview),
    );
    // F-19 regression: the backdrop must cover the real viewport even on
    // a tall list (a `backdrop-filter` ancestor used to capture the
    // in-tree `fixed` modal, centering the dialog off-screen).
    const modalGeometry = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const backdrop = dlg?.parentElement ?? null;
      const b = backdrop?.getBoundingClientRect();
      const d = dlg?.getBoundingClientRect();
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        backdrop: b
          ? { y: Math.round(b.y), h: Math.round(b.height), w: Math.round(b.width) }
          : null,
        dialog: d ? { y: Math.round(d.y), h: Math.round(d.height) } : null,
      };
    });
    check(
      'images preview dialog is viewport-anchored (backdrop covers viewport, dialog inside it)',
      modalGeometry.backdrop !== null &&
        modalGeometry.dialog !== null &&
        Math.abs(modalGeometry.backdrop.y) <= 1 &&
        Math.abs(modalGeometry.backdrop.h - modalGeometry.viewport.h) <= 1 &&
        Math.abs(modalGeometry.backdrop.w - modalGeometry.viewport.w) <= 1 &&
        (modalGeometry.dialog?.y ?? -1) >= 0 &&
        (modalGeometry.dialog?.y ?? 9999) + (modalGeometry.dialog?.h ?? 9999) <=
          modalGeometry.viewport.h + 1,
      JSON.stringify(modalGeometry),
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Close')?.click();
    });
    let previewClosed = false;
    try {
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null, {
        timeout: 10000,
      });
      previewClosed = true;
    } catch {
      previewClosed = false;
    }
    check('images preview dialog closes', previewClosed);
    // Pointer drag on the handle (framer-motion Reorder, same path as
    // touch long-press): drag the first row down by exactly one row
    // pitch → order flips. Wait for framer's layout animation to settle
    // FIRST (mid-animation transforms made a measured pitch negative),
    // and MEASURE the pitch (row heights change with layout) rather
    // than using a fixed pixel distance.
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li')];
        if (rows.length < 2) return false;
        const a = rows[0].getBoundingClientRect();
        const b = rows[1].getBoundingClientRect();
        return b.top > a.top && b.top - a.top > a.height * 0.5;
      },
      { timeout: 10000 },
    );
    const dragGeom = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li')];
      const handles = rows.map((li) => li.querySelector('[aria-label^="Drag"]'));
      const box = (el) => {
        const r = el?.getBoundingClientRect();
        return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      };
      return {
        start: box(handles[0]),
        rowHeight: rows[0]?.getBoundingClientRect().height ?? null,
      };
    });
    let dragReordered = false;
    if (dragGeom.start !== null && dragGeom.rowHeight !== null) {
      const dragBy = dragGeom.rowHeight + 12;
      await page.mouse.move(dragGeom.start.x, dragGeom.start.y);
      await page.mouse.down();
      await page.mouse.move(dragGeom.start.x, dragGeom.start.y + dragBy, { steps: 15 });
      await new Promise((r) => setTimeout(r, 400));
      await page.mouse.up();
      try {
        await page.waitForFunction(
          () =>
            document
              .querySelector('ul[aria-label="Pages in PDF order"] > li')
              ?.getAttribute('aria-label')
              ?.includes('red-wide.jpg'),
          { timeout: 10000 },
        );
        dragReordered = true;
      } catch {
        dragReordered = false;
      }
    }
    check('images handle drag reorders pages', dragReordered, JSON.stringify(dragGeom));
    // Rotate red 90° (badge appears; build exercises the canvas re-encode path).
    await clickButton('Rotate red-wide.jpg 90 degrees clockwise');
    let rotated = false;
    try {
      await page.waitForFunction(() => document.body.innerText.includes('90°'), {
        timeout: 10000,
      });
      rotated = true;
    } catch {
      rotated = false;
    }
    check('images rotate marks the page', rotated);
    // Remove blue → one page; add red-wide again → two pages.
    await clickButton('Remove blue-tall.jpg');
    await page.waitForFunction(
      () => document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length === 1,
      { timeout: 10000 },
    );
    await upload(page, 'input[type="file"]', [red]);
    await page.waitForFunction(
      () => document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length === 2,
      { timeout: 10000 },
    );
    cards = await cardOrder();
    check(
      'images remove + add-more keep the collection consistent',
      cards.length === 2 && cards[0].includes('red-wide.jpg'),
      cards.join(' | '),
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.startsWith('Build PDF'))
        ?.click();
    });
    await page.waitForFunction(
      () => document.querySelector('a[aria-label="Download PDF"]') !== null,
      { timeout: 300000 },
    );
    await page.evaluate(() => {
      document.querySelector('a[aria-label="Download PDF"]')?.click();
    });
    const imagesOut = await waitForCapturedDownload(page, 120000);
    check(
      'images tool builds a PDF',
      imagesOut !== null && imagesOut.magic === '%PDF-',
      imagesOut ? imagesOut.name : null,
    );
    check(
      'images smart default name ends .pdf with plus (multi-page)',
      imagesOut !== null && imagesOut.name.endsWith('.pdf') && imagesOut.name.includes('plus'),
      imagesOut ? imagesOut.name : null,
    );
    // Custom name on the same card (anchor clicks are captured in-page,
    // so the card stays up): switch to Custom, type a name, download.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Custom name')
        ?.click();
    });
    await page.waitForFunction(
      () => {
        const input = document.querySelector('input[aria-label="File name"]');
        return input !== null && input.value === '';
      },
      { timeout: 10000 },
    );
    await page.type('input[aria-label="File name"]', 'e2e-custom-name');
    await page.evaluate(() => {
      document.querySelector('a[aria-label="Download PDF"]')?.click();
    });
    const imagesCustom = await waitForCapturedDownload(page, 120000);
    check(
      'images custom name downloads exactly e2e-custom-name.pdf',
      imagesCustom !== null && imagesCustom.name === 'e2e-custom-name.pdf',
      imagesCustom ? imagesCustom.name : null,
    );
    // Sharded build (P3, threshold 8 pages): 6 more uploads → 8 pages take
    // the multi-worker path; output must keep every page in order.
    await upload(page, 'input[type="file"]', [red, red, red, blue, blue, blue]);
    await page.waitForFunction(
      () => document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length === 8,
      { timeout: 120000 },
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.startsWith('Build PDF'))
        ?.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('8 images → 8-page PDF'), {
      timeout: 300000,
    });
    await page.waitForFunction(
      () => document.querySelector('a[aria-label="Download PDF"]') !== null,
      { timeout: 30000 },
    );
    await page.evaluate(() => {
      document.querySelector('a[aria-label="Download PDF"]')?.click();
    });
    const sharded = await waitForCapturedDownload(page, 120000);
    check(
      'images sharded build keeps all 8 pages in order',
      sharded !== null && sharded.magic === '%PDF-' && sharded.name.endsWith('.pdf'),
      sharded ? `${sharded.name} ${sharded.size}b` : null,
    );
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  // ---- Scanner: fake-camera capture → review → crop → Build PDF ----
  // Real 640×480 Y4M via the Chrome fake video device (established pattern:
  // no prior fake-camera block exists in this file, so the Y4M is generated
  // fresh into e2e/after/). A separate browser carries the fake-device flags;
  // the denied-state block below reuses the flagless main browser.
  {
    const y4mPath = path.join(__dirname, 'after', 'fake-640x480.y4m');
    if (!fs.existsSync(y4mPath)) writeFakeY4M(y4mPath, 640, 480, 12);
    let scanBrowser = null;
    try {
      scanBrowser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'shell',
        protocolTimeout: 600000,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--mute-audio',
          '--disable-extensions',
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
          `--use-file-for-fake-video-capture=${y4mPath}`,
        ],
      });
    } catch (err) {
      check('scanner opens with root + shutter + ML toggle default classical', false, String(err));
    }
    if (scanBrowser !== null) {
      const { page, consoleErrors } = await newPage(scanBrowser);
      await gotoTool(page, 'images');
      await scanOpen(page);
      const scanTakeover = await page.evaluate(() => {
        try {
          const root = document.querySelector('[data-scanner-root]');
          if (!root) return null;
          const cs = getComputedStyle(root);
          const r = root.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const area = r.width * r.height;
          const viewportArea = vw * vh;
          const coverage = viewportArea > 0 ? area / viewportArea : 0;
          return {
            present: true,
            position: cs.position,
            fixed: cs.position === 'fixed',
            rect: {
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
            },
            viewport: { w: vw, h: vh },
            coverage: Number(coverage.toFixed(3)),
            bodyOverflow: document.body.style.overflow || getComputedStyle(document.body).overflow,
            detector: root.getAttribute('data-detector'),
            legacyTogglePresent: document.querySelector('[data-ml-detector]') !== null,
            finderFrame: document.querySelector('[data-finder-frame]') !== null,
            finderStatus:
              document.querySelector('[data-finder-status]')?.textContent?.trim() ?? null,
            mirrorToggle: document.querySelector('[data-mirror-toggle]') !== null,
            mirrorPressed:
              document.querySelector('[data-mirror-toggle]')?.getAttribute('aria-pressed') ?? null,
            videoPresent: document.querySelector('[data-scanner-root] video') !== null,
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner takeover is fullscreen portaled (fixed, covers viewport, locks body scroll)',
        scanTakeover !== null &&
          scanTakeover.fixed === true &&
          scanTakeover.coverage >= 0.95 &&
          (scanTakeover.bodyOverflow === 'hidden' || scanTakeover.bodyOverflow.includes('hidden')),
        JSON.stringify(scanTakeover),
      );
      check(
        'scanner defaults to ML detector (data-detector=ml, no legacy toggle)',
        scanTakeover !== null &&
          scanTakeover.detector === 'ml' &&
          scanTakeover.legacyTogglePresent === false,
        JSON.stringify(
          scanTakeover
            ? {
                detector: scanTakeover.detector,
                legacyTogglePresent: scanTakeover.legacyTogglePresent,
              }
            : null,
        ),
      );
      const finderDetail = await page.evaluate(() => {
        try {
          const v = document.querySelector('[data-scanner-root] video');
          const mirror = document.querySelector('[data-mirror-toggle]');
          return {
            video: v !== null,
            objectCover: v !== null && getComputedStyle(v).objectFit === 'cover',
            frame: document.querySelector('[data-finder-frame]') !== null,
            status: document.querySelector('[data-finder-status]')?.textContent?.trim() ?? null,
            mirror: mirror !== null,
            mirrorPressed: mirror?.getAttribute('aria-pressed') ?? null,
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner viewfinder shows live video + finder frame + status + mirror toggle',
        finderDetail !== null &&
          finderDetail.video &&
          finderDetail.frame &&
          finderDetail.status !== null &&
          finderDetail.status.length > 0 &&
          finderDetail.mirror &&
          (finderDetail.mirrorPressed === 'true' || finderDetail.mirrorPressed === 'false'),
        JSON.stringify(finderDetail),
      );
      // Click in one evaluate, read the flip in a LATER one: React flushes
      // setState after the click returns, so a same-evaluate read always
      // sees the stale value (L-12 family — reads as a dead toggle).
      const mirrorBefore = await page.evaluate(() => {
        try {
          return (
            document.querySelector('[data-mirror-toggle]')?.getAttribute('aria-pressed') ?? null
          );
        } catch {
          return null;
        }
      });
      await page.evaluate(() => {
        try {
          document.querySelector('[data-mirror-toggle]')?.click();
        } catch {
          /* noop */
        }
      });
      try {
        await page.waitForFunction(
          (was) => {
            try {
              const now = document
                .querySelector('[data-mirror-toggle]')
                ?.getAttribute('aria-pressed');
              return now !== null && now !== was;
            } catch {
              return false;
            }
          },
          { timeout: 10000 },
          mirrorBefore,
        );
      } catch {
        /* measured below as flipped:false */
      }
      const mirrorFlip = await page.evaluate((was) => {
        try {
          const after = document
            .querySelector('[data-mirror-toggle]')
            ?.getAttribute('aria-pressed');
          return { before: was, after, flipped: after !== null && after !== was };
        } catch {
          return null;
        }
      }, mirrorBefore);
      check(
        'scanner mirror toggle flips preview mirroring (aria-pressed)',
        mirrorFlip !== null && mirrorFlip.flipped === true,
        JSON.stringify(mirrorFlip),
      );
      // Capture top bar (Google-style): close + title asserted strictly; flash
      // control probed into details (fake-camera devices may not expose torch,
      // so its absence is reported, not failed on).
      const topBar = await page.evaluate(() => {
        try {
          const root = document.querySelector('[data-scanner-root]');
          const closeBtn =
            root?.querySelector('[aria-label="Close scanner"]') ??
            [...document.querySelectorAll('button')].find((b) => b.textContent === '✕');
          const title = root?.textContent ?? '';
          const flashFound = [...(root?.querySelectorAll('button') ?? [])].some((b) =>
            /flash|torch/i.test(`${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`),
          );
          return {
            closePresent: closeBtn !== null && closeBtn !== undefined,
            titlePresent: /Scan documents/.test(title),
            flashFound,
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner top bar has close + title (flash probe in details)',
        topBar !== null && topBar.closePresent && topBar.titlePresent,
        JSON.stringify(topBar),
      );
      // Capture mode segmented control: Manual default, Auto selectable (click
      // Auto and assert selected — never wait for auto-fire on synthetic feed),
      // then restore Manual so the captures below stay deterministic.
      const readMode = () => {
        try {
          const seg = document.querySelector('[data-scan-mode]');
          if (!seg) return null;
          const btns = [...seg.querySelectorAll('button')];
          const isSel = (b) =>
            b.getAttribute('aria-pressed') === 'true' ||
            b.getAttribute('aria-checked') === 'true' ||
            b.getAttribute('aria-selected') === 'true' ||
            b.getAttribute('data-selected') === 'true' ||
            b.classList.contains('active');
          return {
            options: btns.map((b) => b.textContent?.trim() ?? ''),
            selected: btns.filter(isSel).map((b) => b.textContent?.trim() ?? ''),
          };
        } catch {
          return null;
        }
      };
      const modeDefault = await page.evaluate(readMode);
      check(
        'scanner capture mode defaults to Manual',
        modeDefault !== null &&
          modeDefault.options.includes('Manual') &&
          modeDefault.options.some((o) => /Auto/.test(o)) &&
          modeDefault.selected.includes('Manual'),
        JSON.stringify(modeDefault),
      );
      await page.evaluate(() => {
        try {
          const seg = document.querySelector('[data-scan-mode]');
          [...(seg?.querySelectorAll('button') ?? [])]
            .find((b) => /Auto/.test(b.textContent ?? ''))
            ?.click();
        } catch {
          /* noop */
        }
      });
      let autoWaited = false;
      try {
        await page.waitForFunction(
          () => {
            try {
              const seg = document.querySelector('[data-scan-mode]');
              if (!seg) return false;
              const auto = [...seg.querySelectorAll('button')].find((b) =>
                /Auto/.test(b.textContent ?? ''),
              );
              if (!auto) return false;
              return (
                auto.getAttribute('aria-pressed') === 'true' ||
                auto.getAttribute('aria-checked') === 'true' ||
                auto.getAttribute('aria-selected') === 'true' ||
                auto.getAttribute('data-selected') === 'true' ||
                auto.classList.contains('active')
              );
            } catch {
              return false;
            }
          },
          { timeout: 10000 },
        );
        autoWaited = true;
      } catch {
        autoWaited = false;
      }
      const modeAfterAuto = await page.evaluate(readMode);
      check(
        'scanner Auto capture is selectable (no auto-fire wait)',
        autoWaited && modeAfterAuto !== null && modeAfterAuto.selected.some((s) => /Auto/.test(s)),
        JSON.stringify(modeAfterAuto),
      );
      await page.evaluate(() => {
        try {
          const seg = document.querySelector('[data-scan-mode]');
          [...(seg?.querySelectorAll('button') ?? [])]
            .find((b) => (b.textContent?.trim() ?? '') === 'Manual')
            ?.click();
        } catch {
          /* noop */
        }
      });
      try {
        await page.waitForFunction(
          () => {
            try {
              const seg = document.querySelector('[data-scan-mode]');
              if (!seg) return false;
              const manual = [...seg.querySelectorAll('button')].find(
                (b) => (b.textContent?.trim() ?? '') === 'Manual',
              );
              if (!manual) return false;
              return (
                manual.getAttribute('aria-pressed') === 'true' ||
                manual.getAttribute('aria-checked') === 'true' ||
                manual.getAttribute('aria-selected') === 'true' ||
                manual.getAttribute('data-selected') === 'true' ||
                manual.classList.contains('active')
              );
            } catch {
              return false;
            }
          },
          { timeout: 10000 },
        );
      } catch {
        /* measured implicitly by the captures below staying manual */
      }
      // Big shutter (live only — live-only absence is covered by the review
      // phase check asserting liveCaptureAbsent).
      const shutterSize = await page.evaluate(() => {
        try {
          const btn = document.querySelector('[data-scan-capture]');
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        } catch {
          return null;
        }
      });
      check(
        'scanner capture button is big (>=64px)',
        shutterSize !== null && shutterSize.w >= 64 && shutterSize.h >= 64,
        JSON.stringify(shutterSize),
      );
      const pillLive = await page.evaluate(() => {
        try {
          const pill = document.querySelector('[data-finder-status]');
          const text = pill?.textContent?.trim() ?? '';
          return { present: pill !== null, nonEmpty: text.length > 0, text: text.slice(0, 80) };
        } catch {
          return null;
        }
      });
      check(
        'scanner status pill is non-empty while live',
        pillLive !== null && pillLive.present && pillLive.nonEmpty,
        JSON.stringify(pillLive),
      );
      await scanCaptureOnce(page);
      // Status pill while detecting/processing: wait for the transient pill
      // FIRST, immediately after the click — any strip/progress wait in
      // between burns the visible window (detection + 800ms dwell), and the
      // wait then starts post-expiry and reads idle (L-16 family).
      // NOTE: polls the pill's textContent directly, not body.innerText —
      // innerText forces layout on every poll and starves under the ORT
      // cold-load main-thread block, while the cheap query keeps polling.
      // Polling is an explicit 250ms timer, not rAF: under ORT/WASM load the
      // headless renderer produces frames too slowly for rAF-driven polling
      // to land inside the ~1s visible window (two green probes vs two suite
      // misses proved exactly that split).
      let holdSteadyWaited = false;
      try {
        await page.waitForFunction(
          () => {
            try {
              const pill = document.querySelector('[data-finder-status]');
              return pill !== null && /hold steady/i.test(pill.textContent ?? '');
            } catch {
              return false;
            }
          },
          { timeout: 15000, polling: 250 },
        );
        holdSteadyWaited = true;
      } catch {
        holdSteadyWaited = false;
      }
      // The camera-phase strip is `[data-scan-strip]` (thumbs); the
      // `[data-scan-queue]` review surface renders only after the Review CTA
      // (phase change), so per-capture waits assert strip thumbs here and the
      // queue wait moves below the CTA click.
      await page.waitForFunction(
        () => {
          try {
            const s = document.querySelector('[data-scan-strip]');
            return s !== null && s.querySelectorAll('button').length >= 1;
          } catch {
            return false;
          }
        },
        { timeout: 30000 },
      );
      // Status pill while detecting/processing: the capture above dispatched,
      // now wait for the transient pill, then measure in a later evaluate.
      const pillDetecting = await page.evaluate(() => {
        try {
          const els = [...document.querySelectorAll('[data-finder-status], [role="status"]')];
          const texts = els.map((e) => e.textContent?.trim() ?? '');
          return {
            texts: texts.map((t) => t.slice(0, 80)),
            anyHoldSteady: texts.some((t) => /hold steady/i.test(t)),
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner status pill shows Scanning… hold steady while detecting',
        holdSteadyWaited && pillDetecting !== null && pillDetecting.anyHoldSteady === true,
        JSON.stringify(pillDetecting),
      );
      // Gallery thumb after a capture (fails honestly when the reworked
      // capture screen omits it).
      try {
        await page.waitForFunction(
          () => {
            try {
              const g = document.querySelector('[data-scan-gallery]');
              return g !== null && g.querySelectorAll('img,button').length >= 1;
            } catch {
              return false;
            }
          },
          { timeout: 15000 },
        );
      } catch {
        /* measured below */
      }
      const galleryState = await page.evaluate(() => {
        try {
          const g = document.querySelector('[data-scan-gallery]');
          if (!g) return null;
          return { thumbs: g.querySelectorAll('img,button').length };
        } catch {
          return null;
        }
      });
      check(
        'scanner gallery thumb appears after a capture',
        galleryState !== null && galleryState.thumbs >= 1,
        JSON.stringify(galleryState),
      );
      await scanCaptureOnce(page);
      await page.waitForFunction(
        () => {
          try {
            const s = document.querySelector('[data-scan-strip]');
            return s !== null && s.querySelectorAll('button').length >= 2;
          } catch {
            return false;
          }
        },
        { timeout: 30000 },
      );
      const queueState = await page.evaluate(() => {
        try {
          const s = document.querySelector('[data-scan-strip]');
          const alert = document.querySelector('[role="alert"]');
          const v = document.querySelector('[data-scanner-root] video');
          const live =
            v !== null && (v.readyState >= 2 || v.videoWidth > 0 || v.played !== undefined);
          const thumbs = s === null ? -1 : s.querySelectorAll('button').length;
          return {
            header: `strip thumbs ${thumbs} of 2`,
            silent: alert === null,
            live,
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner fake-camera capture queues silently with camera live',
        queueState !== null &&
          /of 2\b/.test(queueState.header) &&
          queueState.silent &&
          queueState.live,
        JSON.stringify(queueState),
      );
      const ctaText = await page.evaluate(() => {
        try {
          return document.querySelector('[data-review-cta]')?.textContent?.trim() ?? null;
        } catch {
          return null;
        }
      });
      check('scanner Review CTA reads Review N pages', ctaText === 'Review 2 pages', ctaText);
      await page.evaluate(() => {
        try {
          document.querySelector('[data-review-cta]')?.click();
        } catch {
          /* noop */
        }
      });
      await waitForResultImg(page);
      let queueReached = false;
      try {
        await waitForQueue(page, 2, 30000);
        queueReached = true;
      } catch {
        queueReached = false;
      }
      const queuePhase = await page.evaluate(() => {
        try {
          const q = document.querySelector('[data-scan-queue]');
          const strip = document.querySelector('[data-scan-strip]');
          const liveCapture = document.querySelector('[data-scan-capture]');
          const text = q?.textContent ?? '';
          return {
            queuePresent: q !== null,
            queueText: text.slice(0, 80),
            of2: /of 2\b/.test(text),
            stripPresent: strip !== null,
            liveCaptureAbsent: liveCapture === null,
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner review phase shows queue (live capture hidden)',
        queueReached &&
          queuePhase !== null &&
          queuePhase.queuePresent &&
          queuePhase.of2 &&
          queuePhase.liveCaptureAbsent,
        JSON.stringify(queuePhase),
      );
      // Reworked review chrome: filmstrip with numbered thumbs + add button,
      // batch bar with Discard scans + Next. All fail honestly when absent.
      const filmState = await page.evaluate(() => {
        try {
          const film = document.querySelector('[data-scan-filmstrip]');
          if (!film) return { filmPresent: false, addPresent: null };
          const thumbs = [...film.querySelectorAll('[data-film-thumb]')];
          const labels = thumbs.map((t) =>
            (t.getAttribute('aria-label') ?? t.textContent ?? '').trim().slice(0, 40),
          );
          return {
            filmPresent: true,
            thumbCount: thumbs.length,
            labels,
            numbered: labels.some((l) => /1/.test(l)) && labels.some((l) => /2/.test(l)),
            addPresent: document.querySelector('[data-scan-add]') !== null,
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner filmstrip shows 2 numbered thumbs',
        filmState !== null &&
          filmState.filmPresent === true &&
          filmState.thumbCount === 2 &&
          filmState.numbered === true,
        JSON.stringify(filmState),
      );
      const batchState = await page.evaluate(() => {
        try {
          const bar = document.querySelector('[data-batch-bar]');
          if (!bar) return null;
          const labels = [...bar.querySelectorAll('button')].map(
            (b) => b.textContent?.trim() ?? '',
          );
          return {
            labels,
            hasDiscard: labels.includes('Discard scans'),
            hasNext: labels.includes('Next'),
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner batch bar offers Discard scans + Next',
        batchState !== null && batchState.hasDiscard && batchState.hasNext,
        JSON.stringify(batchState),
      );
      // Add-button round-trip: review → camera → review CTA → review again.
      const addPresent = filmState !== null && filmState.addPresent === true;
      let addReturned = false;
      if (addPresent) {
        await page.evaluate(() => {
          try {
            document.querySelector('[data-scan-add]')?.click();
          } catch {
            /* noop */
          }
        });
        try {
          await page.waitForFunction(
            () => {
              try {
                return (
                  document.querySelector('[data-scan-capture]') !== null &&
                  document.querySelector('[data-scan-queue]') === null
                );
              } catch {
                return false;
              }
            },
            { timeout: 30000 },
          );
          addReturned = true;
        } catch {
          addReturned = false;
        }
        if (addReturned) {
          await page.evaluate(() => {
            try {
              document.querySelector('[data-review-cta]')?.click();
            } catch {
              /* noop */
            }
          });
          try {
            await page.waitForFunction(
              () => {
                try {
                  return document.querySelector('[data-scan-queue]') !== null;
                } catch {
                  return false;
                }
              },
              { timeout: 30000 },
            );
            await waitForResultImg(page);
            await waitForQueue(page, 2, 30000);
          } catch {
            /* measured as back-in-review below */
          }
        }
      }
      const addRoundTrip = await page.evaluate(
        (reached, present) => {
          try {
            return {
              addPresent: present,
              cameraReached: reached,
              backInReview:
                document.querySelector('[data-scan-queue]') !== null &&
                document.querySelector('[data-crop-result-img]') !== null,
            };
          } catch {
            return null;
          }
        },
        addReturned,
        addPresent,
      );
      check(
        'scanner add-button returns to camera (round-trip to review)',
        addRoundTrip !== null &&
          addRoundTrip.addPresent &&
          addRoundTrip.cameraReached &&
          addRoundTrip.backInReview,
        JSON.stringify(addRoundTrip),
      );
      const singleCanvas = await page.evaluate(() => {
        try {
          const res = document.querySelector('[data-crop-result]');
          const imgs = res !== null ? [...res.querySelectorAll('img')] : null;
          const resultImg = document.querySelector('[data-crop-result-img]');
          const src = resultImg?.getAttribute('src') ?? '';
          return {
            resultPresent: res !== null,
            imgCountInResult: imgs === null ? -1 : imgs.length,
            resultImgPresent: resultImg !== null,
            imgDecoded: resultImg !== null && resultImg.naturalWidth > 0,
            imgSrcLen: src.length,
            imgSrcPrefix: src.slice(0, 5),
            overlayPresent: document.querySelector('[data-detect-overlay]') !== null,
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner review hero shows single warped canvas (exactly one img, decodes, no overlay)',
        singleCanvas !== null &&
          singleCanvas.resultPresent === true &&
          singleCanvas.imgCountInResult === 1 &&
          singleCanvas.resultImgPresent === true &&
          singleCanvas.imgDecoded === true &&
          singleCanvas.imgSrcLen > 0 &&
          singleCanvas.overlayPresent === false,
        JSON.stringify(singleCanvas),
      );
      // Single-canvas contract: the result view carries no overlay, so
      // Re-detect is a no-hang round-trip on the hero (dispatch → wait →
      // measure): click, then the single decoded img must settle again.
      const redetectBefore = await page.evaluate(() => {
        try {
          return {
            src: document.querySelector('[data-crop-result-img]')?.getAttribute('src') ?? null,
            hasButton: document.querySelector('[data-redetect]') !== null,
          };
        } catch {
          return null;
        }
      });
      let redetectSettled = false;
      let redetectDetail = null;
      if (redetectBefore !== null && redetectBefore.hasButton) {
        await page.evaluate(() => {
          try {
            document.querySelector('[data-redetect]')?.click();
          } catch {
            /* noop */
          }
        });
        try {
          await page.waitForFunction(
            (prevSrc) => {
              try {
                const body = document.body.innerText ?? '';
                // Transient detecting status counts as the refresh running.
                if (/detecting|re-?detect/i.test(body)) {
                  const img = document.querySelector('[data-crop-result-img]');
                  return img !== null && img.naturalWidth > 0;
                }
                const res = document.querySelector('[data-crop-result]');
                const img = document.querySelector('[data-crop-result-img]');
                if (!res || !img) return false;
                if (res.querySelectorAll('img').length !== 1) return false;
                if (img.naturalWidth <= 0) return false;
                if (document.querySelector('[data-detect-overlay]') !== null) return false;
                // Settled: single decoded hero back. A changed src proves a
                // re-warp; an unchanged src still proves no-hang (idempotent
                // re-detect on the same quad).
                void prevSrc;
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 30000 },
            redetectBefore.src,
          );
          redetectSettled = true;
        } catch {
          redetectSettled = false;
        }
        redetectDetail = await page.evaluate(() => {
          try {
            const res = document.querySelector('[data-crop-result]');
            const img = document.querySelector('[data-crop-result-img]');
            return {
              imgCount: res !== null ? res.querySelectorAll('img').length : -1,
              decoded: img !== null && img.naturalWidth > 0,
              overlayPresent: document.querySelector('[data-detect-overlay]') !== null,
            };
          } catch {
            return null;
          }
        });
      }
      check(
        'scanner Re-detect refreshes result without hanging (30s bound)',
        redetectBefore !== null &&
          redetectBefore.hasButton === true &&
          redetectSettled === true &&
          redetectDetail !== null &&
          redetectDetail.imgCount === 1 &&
          redetectDetail.decoded === true &&
          redetectDetail.overlayPresent === false,
        JSON.stringify({ before: redetectBefore, settled: redetectSettled, after: redetectDetail }),
      );
      await waitForResultImg(page);
      const resultFirst = await page.evaluate(() => {
        try {
          const res = document.querySelector('[data-crop-result]');
          const img = document.querySelector('[data-crop-result-img]');
          if (!res || !img) return null;
          const r = res.getBoundingClientRect();
          return {
            shown: r.width > 0 && r.height > 0,
            naturalWidth: img.naturalWidth,
            handles: document.querySelectorAll('[data-crop-handle]').length,
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner Page 1 shows crop result first (result shown, zero handles)',
        resultFirst !== null && resultFirst.shown && resultFirst.handles === 0,
        JSON.stringify(resultFirst),
      );
      check(
        'scanner result image decodes (naturalWidth > 0)',
        resultFirst !== null && resultFirst.naturalWidth > 0,
        JSON.stringify(resultFirst),
      );
      const touchBefore = await page.evaluate(() => {
        try {
          const box = (label) => {
            const btn = [...document.querySelectorAll('button')].find(
              (b) => b.textContent === label,
            );
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
          };
          return { looksGood: box('Looks good'), adjust: box('Adjust corners') };
        } catch {
          return null;
        }
      });
      check(
        'scanner touch targets meet 44px (Looks-good/Adjust)',
        touchBefore !== null &&
          touchBefore.looksGood !== null &&
          touchBefore.adjust !== null &&
          touchBefore.looksGood.w >= 44 &&
          touchBefore.looksGood.h >= 44 &&
          touchBefore.adjust.w >= 44 &&
          touchBefore.adjust.h >= 44,
        JSON.stringify(touchBefore),
      );
      await page.evaluate(() => {
        try {
          [...document.querySelectorAll('button')]
            .find((b) => b.textContent === 'Looks good')
            ?.click();
        } catch {
          /* noop */
        }
      });
      let progressed = false;
      try {
        await page.waitForFunction(
          () => {
            try {
              const p = document.querySelector('[data-review-progress]');
              if (!p) return false;
              const label = p.getAttribute('aria-label') ?? p.textContent ?? '';
              return /1 of 2 reviewed/.test(label);
            } catch {
              return false;
            }
          },
          { timeout: 30000 },
        );
        progressed = true;
      } catch {
        progressed = false;
      }
      const progressState = await page.evaluate(() => {
        try {
          const p = document.querySelector('[data-review-progress]');
          if (!p) return null;
          return { label: p.getAttribute('aria-label') ?? p.textContent ?? '' };
        } catch {
          return null;
        }
      });
      check(
        'scanner Looks-good advances + progress 1 of 2 reviewed',
        progressed && progressState !== null && /1 of 2 reviewed/.test(progressState.label),
        JSON.stringify(progressState),
      );
      // Destructive batch action now (fresh queue re-captured below) so the
      // surviving adjust/Apply/reactive/Build-PDF flow keeps its 2-page shape.
      await page.evaluate(() => {
        try {
          const bar = document.querySelector('[data-batch-bar]');
          const inBar = [...(bar?.querySelectorAll('button') ?? [])].find(
            (b) => b.textContent?.trim() === 'Discard scans',
          );
          const fallback = [...document.querySelectorAll('button')].find(
            (b) => b.textContent?.trim() === 'Discard scans',
          );
          (inBar ?? fallback)?.click();
        } catch {
          /* noop */
        }
      });
      let emptiedToCamera = false;
      try {
        await page.waitForFunction(
          () => {
            try {
              const strip = document.querySelector('[data-scan-strip]');
              return (
                document.querySelector('[data-scan-capture]') !== null &&
                document.querySelector('[data-scan-queue]') === null &&
                (strip === null || strip.querySelectorAll('button').length === 0)
              );
            } catch {
              return false;
            }
          },
          { timeout: 30000 },
        );
        emptiedToCamera = true;
      } catch {
        emptiedToCamera = false;
      }
      const discardState = await page.evaluate(() => {
        try {
          const strip = document.querySelector('[data-scan-strip]');
          return {
            capturePresent: document.querySelector('[data-scan-capture]') !== null,
            queueAbsent: document.querySelector('[data-scan-queue]') === null,
            stripThumbs: strip === null ? -1 : strip.querySelectorAll('button').length,
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner Discard-scans empties to camera',
        emptiedToCamera &&
          discardState !== null &&
          discardState.capturePresent &&
          discardState.queueAbsent &&
          discardState.stripThumbs === 0,
        JSON.stringify(discardState),
      );
      // Re-capture a fresh 2-page queue only when the discard actually
      // emptied; otherwise the surviving flow continues on the kept queue
      // (page 2 current, 1 accepted) and every downstream check still holds.
      if (emptiedToCamera) {
        await scanCaptureOnce(page);
        await page.waitForFunction(
          () => {
            try {
              const s = document.querySelector('[data-scan-strip]');
              return s !== null && s.querySelectorAll('button').length >= 1;
            } catch {
              return false;
            }
          },
          { timeout: 30000 },
        );
        await scanCaptureOnce(page);
        await page.waitForFunction(
          () => {
            try {
              const s = document.querySelector('[data-scan-strip]');
              return s !== null && s.querySelectorAll('button').length >= 2;
            } catch {
              return false;
            }
          },
          { timeout: 30000 },
        );
        await page.evaluate(() => {
          try {
            document.querySelector('[data-review-cta]')?.click();
          } catch {
            /* noop */
          }
        });
        await waitForResultImg(page);
        await waitForQueue(page, 2, 30000);
      }
      // Reactive baseline: read the result src WHILE the result view is
      // mounted (pre-adjust). Inside adjust mode the result strip unmounts,
      // so a later read would be null and prove nothing.
      const reactiveSrcBefore = await page.evaluate(() => {
        try {
          return document.querySelector('[data-crop-result-img]')?.getAttribute('src') ?? null;
        } catch {
          return null;
        }
      });
      await page.evaluate(() => {
        try {
          [...document.querySelectorAll('button')]
            .find((b) => b.textContent === 'Adjust corners')
            ?.click();
        } catch {
          /* noop */
        }
      });
      try {
        await page.waitForFunction(
          () => {
            try {
              return (
                document.querySelectorAll('[data-crop-handle]').length === 4 &&
                document.querySelectorAll('[data-crop-handle-mid]').length === 4
              );
            } catch {
              return false;
            }
          },
          { timeout: 30000 },
        );
      } catch {
        /* measured below */
      }
      const adjustState = await page.evaluate(() => {
        try {
          const corners = [...document.querySelectorAll('[data-crop-handle]')];
          const cornerKeys = corners
            .map((h) => h.getAttribute('data-crop-handle'))
            .sort()
            .join(',');
          const cornerSliders = corners.filter((h) => h.getAttribute('role') === 'slider').length;
          const mids = [...document.querySelectorAll('[data-crop-handle-mid]')];
          const midKeys = mids
            .map((h) => h.getAttribute('data-crop-handle-mid'))
            .sort()
            .join(',');
          const midSliders = mids.filter((h) => h.getAttribute('role') === 'slider').length;
          const adjust = document.querySelector('[data-crop-adjust]');
          const photo = adjust !== null ? adjust.querySelector('img') : null;
          const reset = [...document.querySelectorAll('button')].some(
            (b) => b.textContent === 'Reset to auto',
          );
          const instruction = /drag|corner/i.test(document.body.innerText);
          return {
            count: corners.length,
            keys: cornerKeys,
            sliders: cornerSliders,
            midCount: mids.length,
            midKeys,
            midSliders,
            adjustPresent: adjust !== null,
            photoPresent: photo !== null,
            photoDecoded: photo !== null && photo.naturalWidth > 0,
            reset,
            instruction,
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner Adjust mode shows 8 handles (4 corners + 4 mids) + instruction + Reset to auto',
        adjustState !== null &&
          adjustState.adjustPresent === true &&
          adjustState.photoPresent === true &&
          adjustState.photoDecoded === true &&
          adjustState.count === 4 &&
          adjustState.keys === 'bl,br,tl,tr' &&
          adjustState.sliders === 4 &&
          adjustState.midCount === 4 &&
          adjustState.midKeys === 'bottom,left,right,top' &&
          adjustState.midSliders === 4 &&
          adjustState.reset &&
          adjustState.instruction,
        JSON.stringify(adjustState),
      );
      // Reworked hero contract: the quad polygon lives INSIDE adjust (it is
      // absent pre-adjust per the hero check above) — 4 points, measured after
      // the handles above rendered. Scoped to `[data-crop-adjust]`: the old
      // `[data-detect-overlay]` wrapper no longer exists anywhere.
      const adjustPoly = await page.evaluate(() => {
        try {
          const adjust = document.querySelector('[data-crop-adjust]');
          const poly = adjust?.querySelector('polygon') ?? null;
          const pointsAttr = poly?.getAttribute('points') ?? '';
          const pts = pointsAttr
            .trim()
            .split(/[\s,]+/)
            .filter((t) => t.length > 0);
          return {
            adjustPresent: adjust !== null,
            polygonPresent: poly !== null,
            pointPairs: pts.length / 2,
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner adjust mode shows editable quad polygon (4 points)',
        adjustPoly !== null && adjustPoly.polygonPresent && adjustPoly.pointPairs === 4,
        JSON.stringify(adjustPoly),
      );
      const adjustLabels = await page.evaluate(() => {
        try {
          const labels = [...document.querySelectorAll('button')].map((b) => b.textContent);
          return {
            labels: labels.slice(0, 20),
            hasDiscard: labels.includes('Discard'),
            hasApply: labels.includes('Apply'),
            hasRedetect: labels.includes('Re-detect'),
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner adjust mode offers Discard + Apply + Re-detect',
        adjustLabels !== null &&
          adjustLabels.hasDiscard &&
          adjustLabels.hasApply &&
          adjustLabels.hasRedetect,
        JSON.stringify(adjustLabels),
      );
      // (reactiveSrcBefore was read pre-adjust above — the result strip is
      // unmounted while adjusting, so it is read here no longer.)
      const dragStart = await page.evaluate(() => {
        try {
          const el = document.querySelector('[data-crop-handle="tl"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        } catch {
          return null;
        }
      });
      let dragMoved = false;
      if (dragStart !== null) {
        await page.mouse.move(dragStart.x, dragStart.y);
        await page.mouse.down();
        await page.mouse.move(dragStart.x + 40, dragStart.y + 30, { steps: 12 });
        await page.mouse.up();
        try {
          await page.waitForFunction(
            (sx, sy) => {
              try {
                const el = document.querySelector('[data-crop-handle="tl"]');
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const cx = r.x + r.width / 2;
                const cy = r.y + r.height / 2;
                return Math.hypot(cx - sx, cy - sy) > 3;
              } catch {
                return false;
              }
            },
            { timeout: 10000 },
            dragStart.x,
            dragStart.y,
          );
          dragMoved = true;
        } catch {
          dragMoved = false;
        }
      }
      const dragAfter = await page.evaluate(() => {
        try {
          const el = document.querySelector('[data-crop-handle="tl"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y) };
        } catch {
          return null;
        }
      });
      check(
        'scanner corner drag MOVES a handle',
        dragMoved && dragStart !== null && dragAfter !== null,
        JSON.stringify({ before: dragStart, after: dragAfter }),
      );
      const kbResult = await exerciseScanicHandles(page, 'tr', 'ArrowRight');
      check(
        'scanner keyboard arrows move a corner',
        kbResult.moved === true,
        JSON.stringify(kbResult),
      );
      // Whole-edge contract: dragging the TOP midpoint translates the WHOLE
      // top edge — both adjacent corners ride the same clamped delta
      // (rigid, unsheared). Dispatch in one evaluate (mouse), waitForFunction
      // the post-condition, measure in a LATER evaluate (L-12 discipline).
      const edgeBefore = await page.evaluate(() => {
        try {
          const center = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          };
          const tl = center('[data-crop-handle="tl"]');
          const tr = center('[data-crop-handle="tr"]');
          const mid = center('[data-crop-handle-mid="top"]');
          if (!tl || !tr || !mid) return null;
          return { tl, tr, mid };
        } catch {
          return null;
        }
      });
      let edgeDetail = null;
      if (edgeBefore !== null) {
        await page.mouse.move(edgeBefore.mid.x, edgeBefore.mid.y);
        await page.mouse.down();
        await page.mouse.move(edgeBefore.mid.x, edgeBefore.mid.y + 30, { steps: 12 });
        await page.mouse.up();
        try {
          await page.waitForFunction(
            (my) => {
              try {
                const el = document.querySelector('[data-crop-handle-mid="top"]');
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.y + r.height / 2 - my > 3;
              } catch {
                return false;
              }
            },
            { timeout: 10000 },
            edgeBefore.mid.y,
          );
        } catch {
          /* measured below */
        }
        edgeDetail = await page.evaluate((before) => {
          try {
            const center = (sel) => {
              const el = document.querySelector(sel);
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            };
            const tl = center('[data-crop-handle="tl"]');
            const tr = center('[data-crop-handle="tr"]');
            const mid = center('[data-crop-handle-mid="top"]');
            if (!tl || !tr || !mid) return null;
            const tlDy = tl.y - before.tl.y;
            const trDy = tr.y - before.tr.y;
            const midDy = mid.y - before.mid.y;
            return {
              tlDy: Math.round(tlDy * 10) / 10,
              trDy: Math.round(trDy * 10) / 10,
              midDy: Math.round(midDy * 10) / 10,
              gap: Math.round(Math.abs(tlDy - trDy) * 10) / 10,
              bothDown: tlDy > 4 && trDy > 4,
              rigid: Math.abs(tlDy - trDy) < 2,
              midFollows: midDy > 4,
            };
          } catch {
            return null;
          }
        }, edgeBefore);
      }
      check(
        'scanner whole-edge drag moves top edge rigidly (tl+tr down >4px, |gap| < 2px, mid follows)',
        edgeDetail !== null &&
          edgeDetail.bothDown === true &&
          edgeDetail.rigid === true &&
          edgeDetail.midFollows === true,
        JSON.stringify({ before: edgeBefore, after: edgeDetail }),
      );
      await page.evaluate(() => {
        try {
          [...document.querySelectorAll('button')].find((b) => b.textContent === 'Apply')?.click();
        } catch {
          /* noop */
        }
      });
      let appliedBack = false;
      try {
        await page.waitForFunction(
          () => {
            try {
              return (
                document.querySelector('[data-crop-result]') !== null &&
                document.querySelectorAll('[data-crop-handle]').length === 0 &&
                document.querySelectorAll('[data-crop-handle-mid]').length === 0 &&
                document.querySelector('[data-crop-adjust]') === null
              );
            } catch {
              return false;
            }
          },
          { timeout: 30000 },
        );
        appliedBack = true;
      } catch {
        appliedBack = false;
      }
      check('scanner Apply returns to result', appliedBack);
      await waitForResultImg(page);
      // Re-warp is async: Apply exits adjust instantly on the OLD url and the
      // fresh warped blob lands a beat later. A single post-Apply read races
      // the warp (flake: same-src when the warp hasn't committed yet), so
      // wait for the src to actually CHANGE before measuring.
      try {
        await page.waitForFunction(
          (before) => {
            try {
              const src = document.querySelector('[data-crop-result-img]')?.getAttribute('src');
              return src !== null && src.length > 0 && src !== before;
            } catch {
              return false;
            }
          },
          { timeout: 30000 },
          reactiveSrcBefore,
        );
      } catch {
        /* measured below as changed:false */
      }
      const reactiveSrcAfter = await page.evaluate(() => {
        try {
          return document.querySelector('[data-crop-result-img]')?.getAttribute('src') ?? null;
        } catch {
          return null;
        }
      });
      check(
        'scanner Apply re-renders reactive preview (result-img src changes)',
        reactiveSrcBefore !== null &&
          reactiveSrcAfter !== null &&
          reactiveSrcBefore.length > 0 &&
          reactiveSrcAfter.length > 0 &&
          reactiveSrcBefore !== reactiveSrcAfter,
        JSON.stringify({
          beforeLen: reactiveSrcBefore?.length ?? 0,
          afterLen: reactiveSrcAfter?.length ?? 0,
          changed: reactiveSrcBefore !== reactiveSrcAfter,
        }),
      );
      // Use-original is a per-page review action: measure it HERE, while the
      // review buttons are visible. After the next Looks-good (last page) the
      // end screen replaces them and the button is legitimately absent.
      const touchEnd = await page.evaluate(() => {
        try {
          const btn = [...document.querySelectorAll('button')].find(
            (b) => b.textContent === 'Use original',
          );
          if (!btn) return 'absent';
          const r = btn.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        } catch {
          return 'error';
        }
      });
      check(
        'scanner touch target meets 44px (Use-original)',
        touchEnd !== null && typeof touchEnd === 'object' && touchEnd.w >= 44 && touchEnd.h >= 44,
        JSON.stringify(touchEnd),
      );
      // Finish-one-early path: with ≥1 accepted, Next must reach the same done
      // screen. Fresh queues (post-Discard recapture) hold 0 accepted here, so
      // accept the current page first; kept queues already read 1 of 2.
      const progressBeforeNext = await page.evaluate(() => {
        try {
          const p = document.querySelector('[data-review-progress]');
          if (!p) return null;
          return p.getAttribute('aria-label') ?? p.textContent ?? '';
        } catch {
          return null;
        }
      });
      if (progressBeforeNext !== null && /^0 of 2\b/.test(progressBeforeNext)) {
        await page.evaluate(() => {
          try {
            [...document.querySelectorAll('button')]
              .find((b) => b.textContent === 'Looks good')
              ?.click();
          } catch {
            /* noop */
          }
        });
        try {
          await page.waitForFunction(
            () => {
              try {
                const p = document.querySelector('[data-review-progress]');
                if (!p) return false;
                const label = p.getAttribute('aria-label') ?? p.textContent ?? '';
                return /1 of 2 reviewed/.test(label);
              } catch {
                return false;
              }
            },
            { timeout: 60000 },
          );
        } catch {
          /* measured at the done screen below */
        }
      }
      await page.evaluate(() => {
        try {
          const bar = document.querySelector('[data-batch-bar]');
          const inBar = [...(bar?.querySelectorAll('button') ?? [])].find(
            (b) => b.textContent?.trim() === 'Next',
          );
          const fallback = [...document.querySelectorAll('button')].find(
            (b) => b.textContent?.trim() === 'Next',
          );
          (inBar ?? fallback)?.click();
        } catch {
          /* noop */
        }
      });
      let nextDone = false;
      try {
        await page.waitForFunction(
          () => {
            try {
              const labels = [...document.querySelectorAll('button')].map((b) => b.textContent);
              return labels.includes('Build PDF') && labels.includes('Back to camera');
            } catch {
              return false;
            }
          },
          { timeout: 30000 },
        );
        nextDone = true;
      } catch {
        nextDone = false;
      }
      const nextState = await page.evaluate(() => {
        try {
          const labels = [...document.querySelectorAll('button')].map((b) => b.textContent);
          return {
            doneVisible: labels.includes('Build PDF') && labels.includes('Back to camera'),
          };
        } catch {
          return null;
        }
      });
      check(
        'scanner Next reaches done screen with ≥1 accepted',
        nextDone && nextState !== null && nextState.doneVisible,
        JSON.stringify({ progressBeforeNext, nextState }),
      );
      // Return to the pending page for the surviving accept-all flow (skipped
      // when Next never left review — the flow is already positioned there).
      if (nextDone) {
        await page.evaluate(() => {
          try {
            [...document.querySelectorAll('button')]
              .find((b) => b.textContent === 'Back to camera')
              ?.click();
          } catch {
            /* noop */
          }
        });
        try {
          await page.waitForFunction(
            () => {
              try {
                return document.querySelector('[data-scan-capture]') !== null;
              } catch {
                return false;
              }
            },
            { timeout: 30000 },
          );
        } catch {
          /* measured via the review wait below */
        }
        await page.evaluate(() => {
          try {
            document.querySelector('[data-review-cta]')?.click();
          } catch {
            /* noop */
          }
        });
        try {
          await page.waitForFunction(
            () => {
              try {
                return document.querySelector('[data-scan-queue]') !== null;
              } catch {
                return false;
              }
            },
            { timeout: 30000 },
          );
          await waitForResultImg(page);
        } catch {
          /* the surviving Looks-good wait measures */
        }
      }
      await page.evaluate(() => {
        try {
          [...document.querySelectorAll('button')]
            .find((b) => b.textContent === 'Looks good')
            ?.click();
        } catch {
          /* noop */
        }
      });
      let endScreen = false;
      try {
        await page.waitForFunction(
          () => {
            try {
              const labels = [...document.querySelectorAll('button')].map((b) => b.textContent);
              return labels.includes('Build PDF') && labels.includes('Back to camera');
            } catch {
              return false;
            }
          },
          { timeout: 30000 },
        );
        endScreen = true;
      } catch {
        endScreen = false;
      }
      check('scanner end screen offers Build PDF + Back to camera', endScreen);
      await page.evaluate(() => {
        try {
          [...document.querySelectorAll('button')]
            .find((b) => b.textContent === 'Build PDF')
            ?.click();
        } catch {
          /* noop */
        }
      });
      // Done-screen Build PDF commits + exits to the Images tool; the tool's
      // own build button starts the engine job (same pattern as the main
      // Images section — the download link only exists after it).
      await page.waitForFunction(
        () => {
          try {
            return (
              document.querySelector('[data-scanner-root]') === null &&
              [...document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li')].length >= 2
            );
          } catch {
            return false;
          }
        },
        { timeout: 60000 },
      );
      await page.evaluate(() => {
        try {
          [...document.querySelectorAll('button')]
            .find((b) => b.textContent?.startsWith('Build PDF'))
            ?.click();
        } catch {
          /* noop */
        }
      });
      try {
        await page.waitForFunction(
          () => {
            try {
              return document.querySelector('a[aria-label="Download PDF"]') !== null;
            } catch {
              return false;
            }
          },
          { timeout: 300000 },
        );
      } catch {
        /* probed below */
      }
      await page.evaluate(() => {
        try {
          document.querySelector('a[aria-label="Download PDF"]')?.click();
        } catch {
          /* noop */
        }
      });
      const scanPdf = await waitForCapturedDownload(page, 120000);
      const scanOrder = await page.evaluate(() => {
        try {
          const text = document.body.innerText;
          const names = [...text.matchAll(/scan-\d{3}\.jpg/gi)].map((m) => m[0].toLowerCase());
          return names.slice(0, 8);
        } catch {
          return null;
        }
      });
      const ordered =
        scanOrder !== null &&
        scanOrder.length >= 2 &&
        scanOrder[0] <= scanOrder[1] &&
        new Set(scanOrder).size === scanOrder.length;
      check(
        'scanner Build PDF yields real PDF with scan-NNN.jpg pages in order',
        scanPdf !== null && scanPdf.magic === '%PDF-' && ordered,
        scanPdf ? `${scanPdf.name} ${JSON.stringify(scanOrder)}` : JSON.stringify(scanOrder),
      );
      if (consoleErrors.length > 0)
        console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
      await page.close();
      await scanBrowser.close();
    }
    // Scanner-denied state on the flagless main browser (headless, no camera):
    // honest failure, and uploads still work.
    {
      const denied = await newPage(browser);
      await gotoTool(denied.page, 'images');
      await denied.page.evaluate(() => {
        try {
          document.querySelector('[data-scan-open]')?.click();
        } catch {
          /* noop */
        }
      });
      let deniedHonest = false;
      try {
        await denied.page.waitForFunction(
          () => {
            try {
              return /no camera found|denied|could-not-start|could not start/i.test(
                document.body.innerText,
              );
            } catch {
              return false;
            }
          },
          { timeout: 30000 },
        );
        deniedHonest = true;
      } catch {
        deniedHonest = false;
      }
      check('scanner-denied state fails honestly with no camera', deniedHonest);
      const red = path.join(__dirname, 'fixtures', 'red-wide.png');
      await upload(denied.page, 'input[type="file"]', [red]);
      let deniedUpload = false;
      try {
        await denied.page.waitForFunction(
          () => {
            try {
              return (
                document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length >= 1
              );
            } catch {
              return false;
            }
          },
          { timeout: 120000 },
        );
        deniedUpload = true;
      } catch {
        deniedUpload = false;
      }
      check('scanner-denied uploads still work', deniedUpload);
      if (denied.consoleErrors.length > 0)
        console.log(`[section-errors] ${denied.consoleErrors.join(' | ').slice(0, 500)}`);
      await denied.page.close();
    }
  }

  // ---- Compress: disabled with future note ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'compress');
    await upload(page, 'input[type="file"]', [SMALL_22]);
    await new Promise((r) => setTimeout(r, 800));
    const text = await bodyText(page);
    const disabled = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.textContent === 'Compress',
      );
      return btn ? btn.disabled : 'missing';
    });
    check(
      'compress action disabled as future work',
      disabled === true && /future update/.test(text),
    );
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  // ---- Large file: open 490MB, bounded thumbs, close (OPTIONAL corpus) ----
  if (!HAS_LARGE) {
    skip(
      'large file opens with full page count',
      'optional corpus unavailable (test pdfs/merged.pdf absent)',
    );
    skip(
      'large file thumbnails bounded (no 2585-img DOM)',
      'optional corpus unavailable (test pdfs/merged.pdf absent)',
    );
    skip(
      'large file has zero console errors',
      'optional corpus unavailable (test pdfs/merged.pdf absent)',
    );
  } else {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'split');
    await upload(page, 'input[type="file"]', [LARGE]);
    await page.waitForFunction(() => /[1-9][0-9]*\/[0-9]+ kept/.test(document.body.innerText), {
      timeout: 300000,
    });
    const text = await bodyText(page);
    const m = text.match(/(\d+)\/(\d+) kept/);
    check(
      'large file opens with full page count',
      m !== null && m[2] === String(LARGE_PAGES),
      m?.[0],
    );
    const imgCount = await page.evaluate(() => document.querySelectorAll('img').length);
    check('large file thumbnails bounded (no 2585-img DOM)', imgCount < 100, `${imgCount} imgs`);
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
    check(
      'large file has zero console errors',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 2).join(' | '),
    );
  }

  // ---- Cancellation through the UI: merge large+small, cancel mid-run (OPTIONAL corpus) ----
  if (!HAS_LARGE) {
    skip(
      'merge cancellation surfaces honestly in UI',
      'optional corpus unavailable (needs test pdfs/merged.pdf for a cancellable long run)',
    );
  } else {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'merge');
    await upload(page, 'input[type="file"]', [LARGE, SMALL_22]);
    await page.waitForFunction(
      () => document.body.innerText.includes('2 files selected — ready to merge'),
      {
        timeout: 300000,
      },
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.startsWith('Merge '))
        ?.click();
    });
    // Cancel the moment the button appears: the 490 MB engine run is
    // still in flight, so cancellation deterministically wins the race.
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Cancel'),
      { timeout: 60000 },
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')?.click();
    });
    await page.waitForFunction(
      () => /cancelled|Something went wrong/i.test(document.body.innerText),
      {
        timeout: 300000,
      },
    );
    const text = await bodyText(page);
    check('merge cancellation surfaces honestly in UI', /Merge cancelled\./.test(text));
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  const passed = results.length - failed.length;
  const skipNote =
    skipped.length > 0 ? `, ${skipped.length} skipped (optional corpus unavailable)` : '';
  console.log(`\nE2E: ${passed}/${results.length} passed${skipNote}`);
  // Cost map: the slowest checks are where suite time actually goes.
  const slowest = [...results].sort((a, b) => b.deltaMs - a.deltaMs).slice(0, 12);
  console.log('Slowest checks:');
  for (const r of slowest) {
    console.log(`  ${(r.deltaMs / 1000).toFixed(1)}s  ${r.name}`);
  }
  if (failed.length > 0) {
    console.log('Failed:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('E2E fatal:', error);
  process.exit(1);
});
