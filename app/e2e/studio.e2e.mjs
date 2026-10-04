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
import os from 'node:os';
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

/**
 * Review-queue flow (capture-first scanner, result-first review): every
 * capture queues silently and is reviewed ONE page at a time in the
 * full-screen queue. The hero of the review is the CROPPED RESULT
 * (preview requested on page entry); "Adjust corners" toggles the photo
 * + quad editor. These helpers read the queue state, exercise the drag +
 * keyboard mechanics deterministically (synthetic pointer / keyboard
 * events, no CDP-mouse flakiness), and click one per-page decision.
 */
async function reviewQueueState(page) {
  return page.evaluate(() => ({
    open: document.querySelector('[data-scan-queue]') !== null,
    header: document.querySelector('[data-scan-queue] p[role="status"]')?.textContent ?? '',
    handles: document.querySelectorAll('[data-crop-handle]').length,
    midHandles: document.querySelectorAll('[data-crop-handle-mid]').length,
    resultShown: document.querySelector('[data-crop-result]') !== null,
    progress: document.querySelector('[data-review-progress]')?.getAttribute('aria-label') ?? '',
  }));
}

/** Waits for the result-first preview image to decode (worker rewrap). */
async function waitForResultPreview(page, timeout = 180000) {
  await page.waitForFunction(
    () => {
      const img = document.querySelector('[data-crop-result-img]');
      return img !== null && img.naturalWidth > 0;
    },
    { timeout },
  );
}

/** Opens the review queue through the self-explanatory review CTA. */
async function clickReviewCta(page) {
  await page.evaluate(() => document.querySelector('[data-review-cta]')?.click());
}

/**
 * Drag the top-left corner (pointer path), arrow-key the top-right
 * (slider path), then drag the TOP EDGE MIDPOINT (pointer path) and
 * measure whether BOTH adjacent corners translated together — the
 * "different direction/angle" adjustment of the 8-handle editor.
 */
async function exerciseCropHandles(page) {
  // Async-aware: React flushes setQuad AFTER the evaluate returns, so each
  // dispatch-then-measure round trip goes through Node with a
  // waitForFunction in between. The previous single-evaluate version read
  // the handle center synchronously (before React re-rendered) and always
  // reported cornerDrag:false.
  const centerOf = (sel) =>
    page.evaluate((s) => {
      try {
        const el = document.querySelector(s);
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      } catch {
        return null;
      }
    }, sel);
  const start = await centerOf('[data-crop-handle="tl"]');
  if (start === null) return null;
  await page.evaluate(() => {
    try {
      const tl = document.querySelector('[data-crop-handle="tl"]');
      if (tl === null) return;
      const r = tl.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      tl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
      window.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: x + 20, clientY: y + 12 }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    } catch {
      /* total predicate: never throw */
    }
  });
  try {
    await page.waitForFunction(
      (sx, sy) => {
        try {
          const el = document.querySelector('[data-crop-handle="tl"]');
          if (el === null) return false;
          const r = el.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          return cx > sx + 5 && cy > sy + 5;
        } catch {
          return false;
        }
      },
      { timeout: 10000 },
      start.x,
      start.y,
    );
  } catch {
    /* measured below as cornerDrag:false */
  }
  const movedTl = await centerOf('[data-crop-handle="tl"]');
  if (movedTl === null) return null;
  // Keyboard: the top-right corner steps left (slider path).
  await page.evaluate(() => {
    try {
      const tr = document.querySelector('[data-crop-handle="tr"]');
      if (tr === null) return;
      tr.focus();
      tr.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }));
    } catch {
      /* total: never throw */
    }
  });
  const keyboard = await page.evaluate(() => {
    try {
      const tr = document.querySelector('[data-crop-handle="tr"]');
      return { focused: document.activeElement === tr };
    } catch {
      return { focused: false };
    }
  });
  // Edge-midpoint drag: the top edge translates as a whole — both tl
  // and tr must move by the same delta while the pointer moves the
  // midpoint handle.
  const before = await page.evaluate(() => {
    try {
      const pos = (s) => {
        const el = document.querySelector(s);
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      };
      const tl = pos('[data-crop-handle="tl"]');
      const tr = pos('[data-crop-handle="tr"]');
      const mid = pos('[data-crop-handle-mid="top"]');
      if (tl === null || tr === null || mid === null) return null;
      return { tl, tr, mid };
    } catch {
      return null;
    }
  });
  if (before === null) return { cornerDrag: false, keyboard, mid: null };
  await page.evaluate((b) => {
    try {
      const mid = document.querySelector('[data-crop-handle-mid="top"]');
      if (mid === null) return;
      mid.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: b.mid.x, clientY: b.mid.y }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: b.mid.x,
          clientY: b.mid.y + 24,
        }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    } catch {
      /* total: never throw */
    }
  }, before);
  try {
    await page.waitForFunction(
      (by) => {
        try {
          const el = document.querySelector('[data-crop-handle-mid="top"]');
          if (el === null) return false;
          const r = el.getBoundingClientRect();
          return r.y + r.height / 2 > by + 5;
        } catch {
          return false;
        }
      },
      { timeout: 10000 },
      before.mid.y,
    );
  } catch {
    /* measured below as moved:false */
  }
  const after = await page.evaluate(() => {
    try {
      const pos = (s) => {
        const el = document.querySelector(s);
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      };
      const tl = pos('[data-crop-handle="tl"]');
      const tr = pos('[data-crop-handle="tr"]');
      const mid = pos('[data-crop-handle-mid="top"]');
      if (tl === null || tr === null || mid === null) return null;
      return { tl, tr, mid };
    } catch {
      return null;
    }
  });
  if (after === null) return { cornerDrag: false, keyboard, mid: null };
  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    cornerDrag: movedTl.x > start.x + 5 && movedTl.y > start.y + 5,
    keyboard,
    mid: {
      moved: after.mid.y > before.mid.y + 5,
      tlDy: round1(after.tl.y - before.tl.y),
      trDy: round1(after.tr.y - before.tr.y),
      midDy: round1(after.mid.y - before.mid.y),
    },
  };
}

/** Reads the auto-capture toggle state (button toggle or checkbox). */
async function autoCaptureState(page) {
  await page.waitForSelector('[data-auto-capture]', { timeout: 30000 });
  return page.evaluate(() => {
    const t = document.querySelector('[data-auto-capture]');
    if (t === null) return { present: false, on: null };
    const pressed = t.getAttribute('aria-pressed');
    const checked = t.getAttribute('aria-checked');
    if (pressed !== null) return { present: true, on: pressed === 'true' };
    if (checked !== null) return { present: true, on: checked === 'true' };
    if (t instanceof HTMLInputElement) return { present: true, on: t.checked };
    return { present: true, on: null };
  });
}

/**
 * Turns auto-capture OFF when it is ON (one click). Clicks unless the
 * toggle POSITIVELY reads OFF — fresh scanner sessions default the
 * toggle ON, so an unreadable state still gets the OFF click, while a
 * persisted OFF state is left alone (idempotent across remounts).
 */
async function autoCaptureOff(page) {
  const before = await autoCaptureState(page);
  if (before.on !== false) {
    await page.evaluate(() => {
      document.querySelector('[data-auto-capture]')?.click();
    });
  }
  const after = await autoCaptureState(page);
  return { before: before.on, after: after.on };
}

/** Clicks one per-page queue decision by its exact label ("Looks good" / "Apply" / "Use original" / "Back to camera" / "Build PDF"). */
async function clickQueueAction(page, label) {
  await page.evaluate((text) => {
    [...document.querySelectorAll('[data-scan-queue] button')]
      .find((b) => (b.textContent ?? '').trim() === text)
      ?.click();
  }, label);
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
    // Unified entry card: one surface, upload + camera tiles together.
    const entryCard = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        hasCard: text.includes('Add pages'),
        hasUpload: text.includes('Upload images'),
        hasCamera: text.includes('Scan with camera'),
      };
    });
    check(
      'images entry is one card with upload + camera options',
      entryCard.hasCard && entryCard.hasUpload && entryCard.hasCamera,
      JSON.stringify(entryCard),
    );
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

  // ---- Images: scanner unavailable (headless has no camera) fails gracefully ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'images');
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Scan with camera'))
        ?.click();
    });
    await page.waitForFunction(
      () =>
        /No camera was found|Camera access was denied|could not be started/.test(
          document.body.innerText,
        ),
      { timeout: 30000 },
    );
    const scannerFailText = await bodyText(page);
    check(
      'images scanner failure explains itself',
      /No camera was found|Camera access was denied|could not be started/.test(scannerFailText),
    );
    // Back to pages; uploads still work after the failure (collection intact).
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent === 'Back to pages')
        ?.click();
    });
    const red = path.join(__dirname, 'fixtures', 'red-wide.png');
    await upload(page, 'input[type="file"]', [red]);
    await page.waitForFunction(() => document.body.innerText.includes('Build PDF'), {
      timeout: 30000,
    });
    const rowsAfterFailure = await page.evaluate(
      () => document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length,
    );
    check(
      'images uploads work after scanner failure',
      rowsAfterFailure === 1,
      `${rowsAfterFailure} page(s)`,
    );
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
  }

  // ---- Images: document scan with a fake camera ----
  // Headless Chrome has no camera and canvas.captureStream yields 2×2
  // frames, so this block launches a second browser with a synthetic
  // Y4M camera (bright trapezoid on dark, generated below). Frames are
  // real 640×480 pixels: the scan worker + WASM path is fully genuine.
  {
    const y4m = path.join(os.tmpdir(), 'folio-scan-doc.y4m');
    {
      const w = 640;
      const h = 480;
      const fd = fs.openSync(y4m, 'w');
      fs.writeSync(fd, `YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420\n`);
      const uvSize = (w / 2) * (h / 2);
      for (let f = 0; f < 90; f += 1) {
        fs.writeSync(fd, 'FRAME\n');
        const y = Buffer.alloc(w * h, 16);
        for (let row = 0; row < h; row += 1) {
          const t = row / h;
          const lx = Math.round(w * (0.19 + (0.13 - 0.19) * t));
          const rx = Math.round(w * (0.81 + (0.73 - 0.81) * t));
          if (row >= Math.round(h * 0.11) && row <= Math.round(h * 0.88)) {
            y.fill(235, row * w + lx, row * w + rx);
          }
        }
        fs.writeSync(fd, y);
        fs.writeSync(fd, Buffer.alloc(uvSize, 128));
        fs.writeSync(fd, Buffer.alloc(uvSize, 128));
      }
      fs.closeSync(fd);
    }
    const camBrowser = await puppeteer.launch({
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
        `--use-file-for-fake-video-capture=${y4m}`,
      ],
    });
    const { page, consoleErrors } = await newPage(camBrowser);
    await gotoTool(page, 'images');
    const scanWithCamera = async () => {
      await page.evaluate(() => {
        [...document.querySelectorAll('button')]
          .find((b) => b.textContent?.includes('Scan with camera'))
          ?.click();
      });
      await page.waitForFunction(
        () => {
          const v = document.querySelector('video');
          return v !== null && v.videoWidth > 100;
        },
        { timeout: 30000 },
      );
    };
    await scanWithCamera();
    // Capture mode is interruption-free (2026-10-02 UX restructure):
    // shutter → brief processing → capture QUEUED silently (thumb in the
    // session strip), camera stays live. No modal, no review panel, no
    // crop editor per capture.
    const capturePage = () =>
      page.evaluate(() => {
        [...document.querySelectorAll('button')]
          .find((b) => b.getAttribute('aria-label') === 'Capture page')
          ?.click();
      });
    const stripThumbs = (n) =>
      page.waitForFunction(
        (expected) =>
          document.querySelectorAll('[aria-label="Pages captured this session"] img').length >=
          expected,
        { timeout: 120000 },
        n,
      );
    /** Current strip count — the base for relative capture waits (the
     *  strip shows committed session pages too, so absolute counts race). */
    const stripCount = () =>
      page.evaluate(
        () => document.querySelectorAll('[aria-label="Pages captured this session"] img').length,
      );
    // Frozen B1 contract: the auto-capture toggle exists and defaults ON.
    const autoDefault = await autoCaptureState(page);
    check(
      'images scanner auto-capture toggle is present and defaults ON',
      autoDefault.present && autoDefault.on,
      JSON.stringify(autoDefault),
    );
    // Dedicated auto-capture check (fresh session, toggle ON, static
    // document Y4M): the scan worker must auto-fire a capture into the
    // session strip WITHOUT any manual shutter click.
    let autoFired = null;
    try {
      await stripThumbs(1);
      autoFired = true;
    } catch {
      autoFired = false;
    }
    check('images auto-capture fires into the queue without a manual click', autoFired === true);
    // One click turns it OFF — every later manual-capture step in this
    // section runs with auto-capture OFF.
    const autoOff = await autoCaptureOff(page);
    check(
      'images auto-capture toggle turns OFF on click',
      autoOff.before === true && autoOff.after === false,
      JSON.stringify(autoOff),
    );
    const autoPages = await page.evaluate(
      () => document.querySelectorAll('[aria-label="Pages captured this session"] img').length,
    );
    check('images auto-capture queued at least one page', autoPages >= 1, `${autoPages} page(s)`);
    // Review the auto-captured page(s) through the existing result-first
    // flow (Looks good on each), then return to the live camera for the
    // manual-capture flow below.
    await clickReviewCta(page);
    await page.waitForFunction(() => document.querySelector('[data-scan-queue]') !== null, {
      timeout: 30000,
    });
    await page.waitForFunction(() => document.body.innerText.includes('Page 1 of'), {
      timeout: 30000,
    });
    for (let i = 0; i < autoPages; i += 1) {
      await waitForResultPreview(page);
      await page.waitForFunction(
        () => {
          const b = [...document.querySelectorAll('[data-scan-queue] button')].find(
            (x) => (x.textContent ?? '').trim() === 'Looks good',
          );
          return b !== undefined && !b.disabled;
        },
        { timeout: 120000 },
      );
      await clickQueueAction(page, 'Looks good');
      if (i < autoPages - 1) {
        await page.waitForFunction(
          () => document.body.innerText.includes(`Page ${i + 2} of ${autoPages}`),
          { timeout: 120000 },
        );
      }
    }
    await page.waitForFunction(() => document.body.innerText.includes('All pages ready'), {
      timeout: 120000,
    });
    check('images auto-captured pages review via Looks good', true, `${autoPages} page(s)`);
    await clickQueueAction(page, 'Back to camera');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-scan-queue]') === null &&
        document.querySelector('video') !== null,
      { timeout: 30000 },
    );
    // Clean up completely: the committed auto page would shift every
    // downstream page-count assertion. Leave camera mode through the
    // empty-queue CTA, clear the collection, and re-enter fresh so the
    // manual-capture flow below starts from the same empty session it
    // always has (strip counts, CTA labels, and card order stay exact).
    await page.evaluate(() => document.querySelector('[data-review-cta]')?.click());
    await page.waitForFunction(() => document.querySelector('[data-scanner-root]') === null, {
      timeout: 30000,
    });
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Clear all')?.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('Add pages'), {
      timeout: 30000,
    });
    await scanWithCamera();
    // Manual captures (fresh camera mounts with auto-capture ON — turn
    // it OFF right after start, as every manual section does).
    await autoCaptureOff(page);
    await capturePage();
    await stripThumbs(1);
    const liveAfterCapture = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        playing: v !== null && v.readyState >= 2 && !v.paused,
        queueOpen: document.querySelector('[data-scan-queue]') !== null,
        reviewUi: [...document.querySelectorAll('button')].some((b) =>
          ['Looks good', 'Adjust corners', 'Use original', 'Discard'].includes(
            (b.textContent ?? '').trim(),
          ),
        ),
        shutterReady: [...document.querySelectorAll('button')].some(
          (b) => b.getAttribute('aria-label') === 'Capture page' && !b.disabled,
        ),
      };
    });
    check(
      'images capture queues silently and keeps the camera live',
      liveAfterCapture.playing &&
        !liveAfterCapture.queueOpen &&
        !liveAfterCapture.reviewUi &&
        liveAfterCapture.shutterReady,
      JSON.stringify(liveAfterCapture),
    );
    // Second capture immediately after — shots are never interrupted.
    await capturePage();
    await stripThumbs(2);
    // Self-explanatory CTA with unreviewed captures: "Review N pages".
    const reviewCta = await page.evaluate(() => {
      const b = document.querySelector('[data-review-cta]');
      return b === null ? null : (b.textContent ?? '').replace(/\s+/g, ' ').trim();
    });
    check(
      'images review CTA reads Review N pages',
      reviewCta !== null && /^Review 2 pages/.test(reviewCta),
      JSON.stringify(reviewCta),
    );
    await clickReviewCta(page);
    await page.waitForFunction(() => document.querySelector('[data-scan-queue]') !== null, {
      timeout: 30000,
    });
    await page.waitForFunction(() => document.body.innerText.includes('Page 1 of 2'), {
      timeout: 30000,
    });
    // Result-first review: the hero is the CROPPED RESULT (not the raw
    // photo with a quad). The preview is requested the moment the page is
    // shown; wait for it to decode, then assert the simplified action set
    // (44px) and that no corner handles render in result mode.
    await waitForResultPreview(page);
    const resultFirst = await reviewQueueState(page);
    const reviewActions = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('[data-scan-queue] button')];
      const byText = (text) => buttons.find((b) => (b.textContent ?? '').trim() === text) ?? null;
      const looksGood = byText('Looks good');
      const adjust = byText('Adjust corners');
      const useOriginal = byText('Use original');
      const discard = buttons.find((b) => b.getAttribute('aria-label') === 'Discard page') ?? null;
      return {
        looksGood: looksGood !== null,
        looksGoodH: looksGood?.getBoundingClientRect().height ?? 0,
        adjust: adjust !== null,
        adjustH: adjust?.getBoundingClientRect().height ?? 0,
        useOriginal: useOriginal !== null,
        useOriginalH: useOriginal?.getBoundingClientRect().height ?? 0,
        discard: discard !== null,
      };
    });
    check(
      'images review shows the cropped result with simplified actions',
      resultFirst.open &&
        resultFirst.resultShown &&
        reviewActions.looksGood &&
        reviewActions.adjust &&
        reviewActions.useOriginal &&
        reviewActions.discard &&
        resultFirst.handles === 0 &&
        resultFirst.midHandles === 0,
      JSON.stringify({ resultFirst, reviewActions }),
    );
    check(
      'images review actions meet the 44px touch target',
      reviewActions.looksGoodH >= 44 &&
        reviewActions.adjustH >= 44 &&
        reviewActions.useOriginalH >= 44,
      JSON.stringify(reviewActions),
    );
    // Page 1: "Looks good" commits the current quad (full-res rewrap) and
    // advances.
    await clickQueueAction(page, 'Looks good');
    await page.waitForFunction(() => document.body.innerText.includes('Page 2 of 2'), {
      timeout: 120000,
    });
    // Slim per-page progress: one of two reviewed.
    const progressAfterOne = await page.evaluate(
      () => document.querySelector('[data-review-progress]')?.getAttribute('aria-label') ?? '',
    );
    check(
      'images review shows per-page progress',
      progressAfterOne.includes('1 of 2 reviewed'),
      progressAfterOne,
    );
    // Page 2: "Adjust corners" → photo + quad editor with 8 handles
    // (4 corners + 4 edge midpoints), drag + keyboard work, "Apply"
    // returns to the result view. The page may still be preparing; wait
    // for its result view first.
    await page.waitForFunction(() => document.querySelector('[data-crop-result]') !== null, {
      timeout: 120000,
    });
    await clickQueueAction(page, 'Adjust corners');
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-crop-handle]').length === 4 &&
        document.querySelectorAll('[data-crop-handle-mid]').length === 4,
      { timeout: 30000 },
    );
    const adjustUi = await page.evaluate(() => ({
      instruction: document.body.innerText.includes('Drag the handles to fit the page'),
      resetToAuto: [...document.querySelectorAll('[data-scan-queue] button')].some(
        (b) => (b.textContent ?? '').trim() === 'Reset to auto',
      ),
    }));
    check(
      'images adjust mode shows the instruction line and Reset to auto',
      adjustUi.instruction && adjustUi.resetToAuto,
      JSON.stringify(adjustUi),
    );
    const eightHandles = await reviewQueueState(page);
    check(
      'images adjust mode shows 8 handles (4 corners + 4 edge midpoints)',
      eightHandles.handles === 4 && eightHandles.midHandles === 4,
      JSON.stringify(eightHandles),
    );
    const cropDrag = await exerciseCropHandles(page);
    check(
      'images crop handles respond to drag + keyboard',
      cropDrag !== null && cropDrag.cornerDrag && cropDrag.keyboard.focused,
      JSON.stringify(cropDrag),
    );
    check(
      'images edge-midpoint drag translates the whole edge (both corners together)',
      cropDrag !== null &&
        cropDrag.mid !== null &&
        cropDrag.mid.moved &&
        cropDrag.mid.tlDy > 4 &&
        cropDrag.mid.trDy > 4 &&
        Math.abs(cropDrag.mid.tlDy - cropDrag.mid.trDy) < 2,
      JSON.stringify(cropDrag?.mid ?? null),
    );
    await clickQueueAction(page, 'Apply');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-crop-result]') !== null &&
        document.querySelectorAll('[data-crop-handle]').length === 0 &&
        document.querySelectorAll('[data-crop-handle-mid]').length === 0,
      { timeout: 120000 },
    );
    await clickQueueAction(page, 'Looks good');
    // End screen: every page resolved → Build PDF / Back to camera.
    await page.waitForFunction(() => document.body.innerText.includes('All pages ready'), {
      timeout: 120000,
    });
    const endScreen = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('[data-scan-queue] button')];
      return {
        build: buttons.some((b) => (b.textContent ?? '').trim() === 'Build PDF'),
        backToCamera: buttons.some((b) => (b.textContent ?? '').trim() === 'Back to camera'),
      };
    });
    check(
      'images review end screen offers Build PDF and Back to camera',
      endScreen.build && endScreen.backToCamera,
      JSON.stringify(endScreen),
    );
    // Build shortcut: tapping Build PDF leaves camera mode through the
    // parent wiring; the Images tool build/naming UI must be reachable.
    await clickQueueAction(page, 'Build PDF');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-scanner-root]') === null &&
        document.querySelector('[data-scan-queue]') === null,
      { timeout: 60000 },
    );
    // Wait for either the naming card (auto-build finished) or the
    // re-enabled Build PDF button (transient build error path). The
    // predicate must NEVER throw: puppeteer's in-page poller dies silently
    // on a throwing predicate and the wait then idles to its timeout
    // (2026-10-03: `b !== null` passed on an `undefined` find() result
    // while the button read "Building…", killing the poller).
    const buildEntry = await page
      .waitForFunction(
        () => {
          if (document.querySelector('a[download]') !== null) return 'download';
          const b = [...document.querySelectorAll('button')].find((x) =>
            (x.textContent ?? '').startsWith('Build PDF'),
          );
          if (b === undefined || b.disabled) return null;
          return 'button';
        },
        { timeout: 120000 },
      )
      .then((handle) => handle.jsonValue());
    if (buildEntry === 'button') {
      await page.evaluate(() => {
        [...document.querySelectorAll('button')]
          .find((b) => (b.textContent ?? '').startsWith('Build PDF'))
          ?.click();
      });
      await page.waitForFunction(() => document.querySelector('a[download]') !== null, {
        timeout: 300000,
      });
    }
    const buildAtEndProbe = await page.evaluate(async () => {
      const a = document.querySelector('a[download]');
      if (!a) return null;
      const res = await fetch(a.href);
      const buf = new Uint8Array(await res.arrayBuffer());
      return { bytes: buf.length, magic: String.fromCharCode(...buf.slice(0, 5)) };
    });
    check(
      'images Build PDF at review end returns to the Images tool with a real PDF',
      buildAtEndProbe !== null &&
        buildAtEndProbe.magic === '%PDF-' &&
        buildAtEndProbe.bytes > 10000,
      buildAtEndProbe ? `${buildAtEndProbe.magic} ${buildAtEndProbe.bytes} bytes` : 'missing',
    );
    // Both pages committed in capture order (page 1 cropped as-is, page 2
    // adjusted + cropped).
    let cards = await page.evaluate(() =>
      [...document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li')].map(
        (li) => li.getAttribute('aria-label') ?? '',
      ),
    );
    check(
      'images review commits both pages in capture order',
      cards.length === 2 && cards[0].includes('scan-001') && cards[1].includes('scan-002'),
      cards.join(' | '),
    );
    // The committed page's row preview must decode (rewrapped bytes).
    const scanPreview = await page.evaluate(() => {
      const img = document.querySelector('ul[aria-label="Pages in PDF order"] > li img');
      return img === null ? null : { naturalWidth: img.naturalWidth, alt: img.alt };
    });
    check(
      'images accepted scan preview decodes (naturalWidth > 0)',
      scanPreview !== null && scanPreview.naturalWidth > 0,
      JSON.stringify(scanPreview),
    );
    // Scan more (no mode step): collection preserved; the third page goes
    // through the same result-first queue and is committed with "Use
    // original" (photo path), then the end screen's "Back to camera"
    // returns to the live view and the empty-queue CTA leaves to pages.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Scan more')?.click();
    });
    // Manual captures: turn auto-capture OFF right after camera start so
    // the static fake camera cannot surprise the capture count.
    await autoCaptureOff(page);
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v !== null && v.videoWidth > 100;
      },
      { timeout: 30000 },
    );
    const scanMoreBase = await stripCount();
    await capturePage();
    await stripThumbs(scanMoreBase + 1);
    // Scanner surface: mode selector is gone; Import lives in the bar.
    // Desktop keeps a bounded, centered panel (not a full-bleed phone
    // layout); the phone-width geometry check follows below. Runs once
    // the session has a capture — the exit CTA's own contract is "must
    // exist once pages were accepted".
    const scannerSurface = await page.evaluate(() => {
      const root = document.querySelector('[data-scanner-root]');
      if (root === null) return { hasRoot: false };
      const r = root.getBoundingClientRect();
      return {
        hasRoot: true,
        fixed: getComputedStyle(root).position === 'fixed',
        boundedPanel: r.width < window.innerWidth - 40 && r.height <= window.innerHeight,
        hasImport: [...document.querySelectorAll('button')].some(
          (b) => b.getAttribute('aria-label') === 'Import images from files',
        ),
        modeButtons: [...document.querySelectorAll('button')].filter((b) =>
          /scan mode/i.test(b.getAttribute('aria-label') ?? ''),
        ).length,
        // Zoom removed (BUGS F-11): no zoom control may ever render.
        zoomControls: document.querySelectorAll('[aria-label*="Camera zoom"]').length,
        // Primary review CTA must exist once pages were accepted.
        hasReviewCta: document.querySelector('[data-review-cta]') !== null,
      };
    });
    check(
      'images scanner: Import in bar, no mode selector, no zoom, Review CTA, centered desktop panel',
      scannerSurface.hasRoot &&
        scannerSurface.fixed &&
        scannerSurface.boundedPanel &&
        scannerSurface.hasImport &&
        scannerSurface.modeButtons === 0 &&
        scannerSurface.zoomControls === 0 &&
        scannerSurface.hasReviewCta,
      JSON.stringify(scannerSurface),
    );
    await clickReviewCta(page);
    await page.waitForFunction(() => document.body.innerText.includes('Page 1 of 1'), {
      timeout: 30000,
    });
    await waitForResultPreview(page);
    // "Use original" commits the photo path through the same result-first
    // queue → end screen.
    await clickQueueAction(page, 'Use original');
    await page.waitForFunction(() => document.body.innerText.includes('All pages ready'), {
      timeout: 120000,
    });
    await clickQueueAction(page, 'Back to camera');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-scan-queue]') === null &&
        document.querySelector('[data-scanner-root]') !== null &&
        document.querySelector('video') !== null,
      { timeout: 30000 },
    );
    // Queue empty: the CTA falls through to leaving camera mode (`onDone`).
    const emptyCta = await page.evaluate(() => {
      const b = document.querySelector('[data-review-cta]');
      return b === null ? null : (b.textContent ?? '').replace(/\s+/g, ' ').trim();
    });
    check(
      'images review CTA falls through to pages when nothing is queued',
      emptyCta !== null && /^View 1 page/.test(emptyCta),
      JSON.stringify(emptyCta),
    );
    await clickReviewCta(page);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-scanner-root]') === null &&
        document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length === 3,
      { timeout: 120000 },
    );
    cards = await page.evaluate(() =>
      [...document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li')].map(
        (li) => li.getAttribute('aria-label') ?? '',
      ),
    );
    check(
      'images scan-more preserves pages across sessions',
      cards.length === 3,
      cards.join(' | '),
    );
    // Stale-result safety: capture then leave immediately — the capture
    // is still encoding when the scanner closes, so NO page appears and
    // no late worker result can ever add one.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Scan more')?.click();
    });
    // Manual capture session: auto-capture OFF right after camera start.
    await autoCaptureOff(page);
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v !== null && v.videoWidth > 100;
      },
      { timeout: 30000 },
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Capture page')
        ?.click();
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Back to pages')
        ?.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
    const count = await page.evaluate(
      () => document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length,
    );
    check('images stale scan result never becomes a page', count === 3, `pages=${count}`);
    // Responsive HUD geometry: dock below viewport, pill inside it,
    // strip below the dock — at desktop and narrow-phone widths.
    // (Torch stays hidden: the fake track reports no capabilities. The
    // zoom control was removed — BUGS F-11 — so nothing zoom-like renders.)
    const hudGeometry = () =>
      page.evaluate(() => {
        const rect = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            left: Math.round(r.left),
            right: Math.round(r.right),
          };
        };
        const video = document.querySelector('video');
        const viewport = video?.parentElement ?? null;
        return {
          viewport: rect(viewport),
          pill: rect(document.querySelector('[data-detection-pill]')),
          shutter: rect(
            [...document.querySelectorAll('button')].find(
              (b) => b.getAttribute('aria-label') === 'Capture page',
            ) ?? null,
          ),
          strip: rect(document.querySelector('[aria-label="Pages captured this session"]')),
          torch: document.querySelector('[aria-label^="Turn flashlight"]') !== null,
        };
      });
    // Strip lives below the dock: under the framing area and the
    // shutter row, scrolling horizontally at the very bottom.
    const hudSane = (g) =>
      g.viewport !== null &&
      g.shutter !== null &&
      g.shutter.top >= g.viewport.bottom - 1 &&
      (g.pill === null || (g.pill.top >= g.viewport.top && g.pill.bottom <= g.viewport.bottom)) &&
      (g.strip === null || g.strip.top >= g.shutter.bottom - 1) &&
      g.torch === false;
    // Desktop composition (current 1280px viewport): reopen the scanner,
    // then wait until the measured viewport box is non-zero (the hook
    // intentionally never stores the hidden-state zero box).
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Scan more')?.click();
    });
    // Geometry checks only: auto-capture OFF so no surprise capture can
    // race the "Back to pages" exit below.
    await autoCaptureOff(page);
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v !== null && v.videoWidth > 100;
      },
      { timeout: 30000 },
    );
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        const r = v?.parentElement?.getBoundingClientRect();
        return r !== undefined && r.width > 10 && r.height > 10;
      },
      { timeout: 30000 },
    );
    let hud = await hudGeometry();
    check('images scanner HUD layers cleanly on desktop', hudSane(hud), JSON.stringify(hud));
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Back to pages')
        ?.click();
    });
    // Narrow phone: fresh scanner session plus one accept (so the
    // session strip is present), then the same geometry assertions.
    // Viewfinder stability (real-phone report): the framing box must
    // not collapse once the strip + CTA appear — only the compact
    // strip may cost space, never a wrapped top bar or in-flow note.
    await page.setViewport({ width: 375, height: 667 });
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Scan more')?.click();
    });
    // Manual capture session: auto-capture OFF right after camera start.
    await autoCaptureOff(page);
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v !== null && v.videoWidth > 100;
      },
      { timeout: 30000 },
    );
    const viewportH = () =>
      page.evaluate(() => {
        const v = document.querySelector('video');
        // video is always mounted while streaming; only the measurement can
        // lag a remount — retry once so a transient detach never reads 0.
        let r = v?.parentElement?.getBoundingClientRect().height ?? 0;
        if (r <= 0) r = v?.getBoundingClientRect().height ?? 0;
        return r;
      });
    // Wait for the viewport to have a real (nonzero) height after the
    // phone-width resize + camera start before measuring the baseline.
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v !== null && (v.parentElement?.getBoundingClientRect().height ?? 0) > 0;
      },
      { timeout: 30000 },
    );
    const beforeCaptureH = await viewportH();
    const phoneStripBase = await stripCount();
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Capture page')
        ?.click();
    });
    // The queued capture's thumb lands in the session strip by itself —
    // the viewfinder must not collapse when it appears (real-phone
    // report). No review step happens during capture. (Auto-capture is
    // OFF here, so exactly this one capture can affect the geometry.)
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('[aria-label="Pages captured this session"] img').length >=
        expected,
      { timeout: 120000 },
      phoneStripBase + 1,
    );
    const afterCaptureH = await viewportH();
    check(
      'images viewfinder keeps its size after the first capture',
      beforeCaptureH > 0 && afterCaptureH >= beforeCaptureH - 100,
      `before=${Math.round(beforeCaptureH)} after=${Math.round(afterCaptureH)}`,
    );
    hud = await hudGeometry();
    check('images scanner HUD layers cleanly on narrow phone', hudSane(hud), JSON.stringify(hud));
    // Immersive check at phone width: the scanner owns the viewport
    // (portaled, position: fixed) so camera controls never require page
    // scroll — the exact failure this hardened pass fixes.
    const phoneSurface = await page.evaluate(() => {
      const root = document.querySelector('[data-scanner-root]');
      if (root === null) return { fixed: false, covers: false, noScroll: false };
      const r = root.getBoundingClientRect();
      return {
        fixed: getComputedStyle(root).position === 'fixed',
        covers:
          Math.round(r.top) <= 0 &&
          Math.round(r.bottom) >= window.innerHeight - 2 &&
          Math.round(r.left) <= 0 &&
          Math.round(r.right) >= window.innerWidth - 2,
        // Body scroll is locked out of the interaction: the dock and
        // strip live inside the fixed surface, above the fold, and the
        // page behind cannot scroll (no app chrome/nav reveals).
        noScroll:
          r.height >= window.innerHeight - 2 &&
          document.body.style.position === 'fixed' &&
          document.body.style.overflow === 'hidden',
      };
    });
    check(
      'images scanner is a fixed full-viewport surface on phones',
      phoneSurface.fixed && phoneSurface.covers && phoneSurface.noScroll,
      JSON.stringify(phoneSurface),
    );
    await page.setViewport({ width: 1280, height: 900 });
    // (The scanned-pages build is fully covered by the review-end "Build
    // PDF" probe above; importing + building the combined collection is
    // covered by the "6 images → 6-page PDF" check after the bulk import
    // below — this spot used to build the same two pages a third time.)
    // --- Scanner import: memory-safe bulk import (M3.x regression) ---
    // Oversized phone-like JPEGs (3000x2000 > 2500px budget) imported
    // through the scanner's Import button: sequential normalization,
    // pages land in order, no crash, no console errors. Fixtures use fast
    // canvas fills (the per-pixel noise loops were the suite's slowest
    // step by far and added nothing to the assertion).
    const importDir = path.join(os.tmpdir(), 'folio-e2e-import');
    fs.mkdirSync(importDir, { recursive: true });
    const importFiles = [];
    {
      const gen = await camBrowser.newPage();
      await gen.setViewport({ width: 3000, height: 2000 });
      for (let i = 0; i < 3; i += 1) {
        await gen.setContent(
          `<canvas id="c" width="3000" height="2000"></canvas>
           <script>
             const ctx = document.getElementById('c').getContext('2d');
             ctx.fillStyle = ['#274690', '#5b8c5a', '#c0392b'][${i}];
             ctx.fillRect(0, 0, 3000, 2000);
             ctx.fillStyle = '#f0e9d2';
             ctx.fillRect(200, 200, 2600, 1400);
             ctx.fillStyle = '#111111';
             for (let r = 0; r < 30; r += 1) ctx.fillRect(300, 300 + r * 40, 2400, 18);
           </script>`,
        );
        const dataUrl = await gen.evaluate(() =>
          document.getElementById('c').toDataURL('image/jpeg', 0.92),
        );
        const file = path.join(importDir, `phone-${String(i + 1).padStart(2, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
        importFiles.push(file);
      }
      await gen.close();
    }
    const importTotalBytes = importFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
    const pagesBeforeImport = await page.evaluate(
      () => document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length,
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Import images from files')
        ?.click();
    });
    await upload(page, 'input[data-import-input]', importFiles);
    // Sequential import commits each page immediately; wait for the
    // full count (no timing-dependent progress-surface assertion —
    // that was flaky by nature and added nothing to the guarantee).
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length === expected,
      { timeout: 180000 },
      pagesBeforeImport + importFiles.length,
    );
    await page.waitForFunction(() => document.querySelector('[data-import-progress]') === null, {
      timeout: 180000,
    });
    const importedNames = await page.evaluate(
      (count) =>
        [...document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li')]
          .slice(-count)
          .map((li) => li.getAttribute('aria-label') ?? ''),
      importFiles.length,
    );
    check(
      'scanner import commits oversized images in order without crashing',
      importedNames.length === importFiles.length &&
        importedNames.every((label, i) =>
          label.includes(`phone-${String(i + 1).padStart(2, '0')}.jpg`),
        ),
      `${(importTotalBytes / 1048576).toFixed(1)} MB · ${importedNames.join(' | ')}`,
    );
    // Imported pages build a real PDF (mixed camera + imported pages).
    // Adding pages clears the previous completion card, so Build PDF is
    // available again with the full collection.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.startsWith('Build PDF'))
        ?.click();
    });
    await page.waitForFunction(() => document.querySelector('a[download]') !== null, {
      timeout: 600000,
    });
    const expectedPages = pagesBeforeImport + importFiles.length;
    const importBuild = await page.evaluate(async () => {
      const a = document.querySelector('a[download]');
      if (!a) return null;
      const res = await fetch(a.href);
      const buf = new Uint8Array(await res.arrayBuffer());
      return {
        bytes: buf.length,
        magic: String.fromCharCode(...buf.slice(0, 5)),
        meta: document.body.innerText.match(/\d+ images? → \d+-page PDF/)?.[0] ?? null,
      };
    });
    check(
      'imported + scanned pages build one PDF in order',
      importBuild !== null &&
        importBuild.magic === '%PDF-' &&
        importBuild.meta === `${expectedPages} images → ${expectedPages}-page PDF`,
      importBuild ? `${importBuild.meta} · ${importBuild.bytes} bytes` : 'missing',
    );
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
    await camBrowser.close();
    try {
      fs.unlinkSync(y4m);
      fs.rmSync(importDir, { recursive: true, force: true });
    } catch {
      // Best effort temp cleanup.
    }
  }

  // ---- Images: no-document fallback queues croppable, commits as photo ----
  // A fake camera streaming blank frames can never yield a boundary, so
  // the fallback path triggers deterministically. Since the 2026-10-02
  // restructure the capture is NEVER auto-accepted mid-shooting: it
  // queues silently (no blocking review), enters the review queue
  // croppable (90% inset quad — EVERY photo can be cropped), and only an
  // unreviewed queue EXIT commits it as the photo with a transient note.
  {
    const blankY4m = path.join(os.tmpdir(), 'folio-scan-blank.y4m');
    {
      const w = 640;
      const h = 480;
      const fd = fs.openSync(blankY4m, 'w');
      fs.writeSync(fd, `YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420\n`);
      const uvSize = (w / 2) * (h / 2);
      for (let f = 0; f < 30; f += 1) {
        fs.writeSync(fd, 'FRAME\n');
        fs.writeSync(fd, Buffer.alloc(w * h, 22));
        fs.writeSync(fd, Buffer.alloc(uvSize, 128));
        fs.writeSync(fd, Buffer.alloc(uvSize, 128));
      }
      fs.closeSync(fd);
    }
    const blankBrowser = await puppeteer.launch({
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
        `--use-file-for-fake-video-capture=${blankY4m}`,
      ],
    });
    const { page, consoleErrors } = await newPage(blankBrowser);
    await gotoTool(page, 'images');
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Scan with camera'))
        ?.click();
    });
    // Manual capture section: auto-capture OFF right after camera start
    // (blank frames could never auto-fire, but every manual-capture
    // section runs with the toggle OFF by contract).
    await autoCaptureOff(page);
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v !== null && v.videoWidth > 100;
      },
      { timeout: 30000 },
    );
    const fallbackStripBase = await page.evaluate(
      () => document.querySelectorAll('[aria-label="Pages captured this session"] img').length,
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Capture page')
        ?.click();
    });
    // Queued silently: the thumb appears, no blocking decision, camera live.
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('[aria-label="Pages captured this session"] img').length >=
        expected,
      { timeout: 120000 },
      fallbackStripBase + 1,
    );
    const queuedQuietly = await page.evaluate(() => ({
      queueOpen: document.querySelector('[data-scan-queue]') !== null,
      reviewUi: [...document.querySelectorAll('button')].some((b) =>
        ['Looks good', 'Adjust corners', 'Use original', 'Discard'].includes(
          (b.textContent ?? '').trim(),
        ),
      ),
    }));
    check(
      'images fallback capture queues silently without a blocking review',
      !queuedQuietly.queueOpen && !queuedQuietly.reviewUi,
      JSON.stringify(queuedQuietly),
    );
    // The queue is the crop opportunity: result-first, then the fallback
    // capture is croppable via the 90% inset quad (8 handles — 4 corners
    // + 4 edge midpoints) in adjust mode — like any other photo.
    await clickReviewCta(page);
    await page.waitForFunction(() => document.body.innerText.includes('Page 1 of 1'), {
      timeout: 30000,
    });
    // The page renders result-first once its background prepare settles;
    // the result view is the precondition for "Adjust corners" below
    // (result-first itself is asserted in the main scanner session).
    await page.waitForFunction(() => document.querySelector('[data-crop-result]') !== null, {
      timeout: 120000,
    });
    await clickQueueAction(page, 'Adjust corners');
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-crop-handle]').length === 4 &&
        document.querySelectorAll('[data-crop-handle-mid]').length === 4,
      { timeout: 30000 },
    );
    const fallbackQueue = await reviewQueueState(page);
    check(
      'images fallback capture enters the review queue croppable (8 handles)',
      fallbackQueue.open && fallbackQueue.handles === 4 && fallbackQueue.midHandles === 4,
      JSON.stringify(fallbackQueue),
    );
    // Queue exit without a decision: the entry commits as the photo with
    // the transient fallback note (existing note behavior).
    await page.evaluate(() => {
      [...document.querySelectorAll('[data-scan-queue] button')]
        .find((b) => b.getAttribute('aria-label') === 'Back to camera')
        ?.click();
    });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-scan-queue]') === null &&
        document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length === 1,
      { timeout: 30000 },
    );
    const fallback = await page.evaluate(() => ({
      note: document.body.innerText.includes('Added as photo'),
      blockingReview: [...document.querySelectorAll('button')].some(
        (b) => b.textContent === 'Looks good' || b.textContent === 'Adjust corners',
      ),
      cards: [...document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li')].map(
        (li) => li.getAttribute('aria-label') ?? '',
      ),
    }));
    check(
      'images fallback capture commits as photo with a note at queue exit',
      fallback.note && !fallback.blockingReview && fallback.cards[0].includes('scan-'),
      fallback.cards.join(' | '),
    );
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
    await blankBrowser.close();
    try {
      fs.unlinkSync(blankY4m);
    } catch {
      // Best effort temp cleanup.
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
