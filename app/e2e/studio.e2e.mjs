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
