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
function check(name, ok, details) {
  results.push({ name, ok: Boolean(ok), details: details ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
}
function skip(name, reason) {
  skipped.push({ name, reason });
  console.log(`SKIP  ${name} — ${reason}`);
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.evaluateOnNewDocument(() => localStorage.clear());
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
  await page.goto(`${DEV_URL}/#/${tool}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 600));
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
  const dlDir = path.join(__dirname, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  for (const f of fs.readdirSync(dlDir)) {
    try {
      fs.unlinkSync(path.join(dlDir, f));
    } catch {
      // Ignore.
    }
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--disable-extensions'],
  });

  // ---- Home: tool cards for all 7 tools ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await page.goto(`${DEV_URL}/#/`, { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1200));
    // Browser-level download routing (page sessions cannot set this).
    const dlSession = await browser.target().createCDPSession();
    await dlSession.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.join(__dirname, 'downloads'),
    });
    const text = await bodyText(page);
    for (const name of [
      'Merge',
      'Split',
      'Rearrange',
      'Rotate',
      'Compress',
      'Metadata',
      'Images',
    ]) {
      check(`home shows ${name} card`, text.includes(name), name);
    }
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

  // ---- Merge: two files → real merge → download ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'merge');
    await upload(page, 'input[type="file"]', [SMALL_22, RICH_80]);
    await page.waitForFunction(() => document.body.innerText.includes('ready to merge'), {
      timeout: 60000,
    });
    const count = await page.evaluate(() => document.body.innerText);
    check(
      'merge lists 2 files with page counts',
      /2 files · ready to merge/.test(count),
      count.split('\n')[0],
    );
    // Start merge but do NOT await download navigation; intercept via CDP download path.
    const dlDir = path.join(__dirname, 'downloads');
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.startsWith('Merge '))
        ?.click();
    });
    const beforeMerge = new Set(fs.readdirSync(dlDir));
    const mergedFile = await waitForDownload(dlDir, 120000, beforeMerge);
    check('merge downloads a real PDF', mergedFile !== null, mergedFile);
    if (mergedFile !== null) {
      const header = fs.readFileSync(path.join(dlDir, mergedFile)).subarray(0, 5).toString();
      check('merge output is a PDF', header === '%PDF-', header);
    }
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
    const dlDir = path.join(__dirname, 'downloads');
    const before = new Set(fs.readdirSync(dlDir));
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
    const splitFile = await waitForDownload(dlDir, 120000, before);
    check('split pick-mode downloads 21-page PDF', splitFile !== null, splitFile);
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
    const dlDir = path.join(__dirname, 'downloads');
    const before = new Set(fs.readdirSync(dlDir));
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
    const out = await waitForDownload(dlDir, 120000, before);
    check('rearrange saves reordered PDF', out !== null, out);
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
      [...document.querySelectorAll('button[aria-label="Rotate right"]')][0]?.click();
    });
    const dlDir = path.join(__dirname, 'downloads');
    const before = new Set(fs.readdirSync(dlDir));
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
    const out = await waitForDownload(dlDir, 120000, before);
    check('rotate downloads rotated PDF', out !== null, out);
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
    check('metadata reads real properties', true);
    await page.type('#studio-meta-title', 'Studio E2E Title');
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent === 'Save metadata')
        ?.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('Studio E2E Title'), {
      timeout: 60000,
    });
    check('metadata patch round-trips in UI', true);
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
    await page.waitForFunction(() => document.body.innerText.includes('Build PDF'), {
      timeout: 30000,
    });
    let cards = await cardOrder();
    check(
      'images page manager shows two previews in upload order',
      cards.length === 2 && cards[0].includes('red-wide.png') && cards[1].includes('blue-tall.jpg'),
      cards.join(' | '),
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
      cards[0].includes('blue-tall.jpg') && cards[1].includes('red-wide.png'),
      cards.join(' | '),
    );
    // Keyboard drag (dnd-kit KeyboardSensor): lift the first card, move
    // right, drop — exercises the same sortable path as pointer/touch drag.
    // Key steps need settle time: lift measurement and indicator commits
    // are async renders, so back-to-back presses race them.
    await page.evaluate(() => {
      document
        .querySelector('ul[aria-label="Pages in PDF order"] > li button[aria-label^="Drag"]')
        ?.focus();
    });
    await page.keyboard.press('Space');
    // Settle time: lift measurement and indicator commits are async
    // renders — back-to-back presses race them (proven 3/3 with sleeps).
    await new Promise((r) => setTimeout(r, 400));
    let overlayShown = false;
    try {
      await page.waitForFunction(() => document.querySelector('[data-drag-overlay]') !== null, {
        timeout: 10000,
      });
      overlayShown = true;
    } catch {
      overlayShown = false;
    }
    check('images keyboard drag lifts a DragOverlay', overlayShown);
    await page.keyboard.press('ArrowRight');
    await new Promise((r) => setTimeout(r, 500));
    let indicatorShown = false;
    try {
      await page.waitForFunction(() => document.querySelector('[data-drop-indicator]') !== null, {
        timeout: 10000,
      });
      indicatorShown = true;
    } catch {
      indicatorShown = false;
    }
    check('images drag shows an insertion indicator', indicatorShown);
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () =>
        document
          .querySelector('ul[aria-label="Pages in PDF order"] > li')
          ?.getAttribute('aria-label')
          ?.includes('red-wide.png'),
      { timeout: 10000 },
    );
    cards = await cardOrder();
    check(
      'images keyboard drag reorders pages',
      cards[0].includes('red-wide.png') && cards[1].includes('blue-tall.jpg'),
      cards.join(' | '),
    );
    // Rotate red 90° (badge appears; build exercises the canvas re-encode path).
    await clickButton('Rotate red-wide.png 90 degrees clockwise');
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
      cards.length === 2 && cards[0].includes('red-wide.png'),
      cards.join(' | '),
    );
    const dlDir = path.join(__dirname, 'downloads');
    const before = new Set(fs.readdirSync(dlDir));
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.startsWith('Build PDF'))
        ?.click();
    });
    await page.waitForFunction(() => document.querySelector('a[download]') !== null, {
      timeout: 300000,
    });
    await page.evaluate(() => {
      document.querySelector('a[download]')?.click();
    });
    const out = await waitForDownload(dlDir, 120000, before);
    check('images tool builds a PDF', out !== null, out);
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
    check('images scanner failure explains itself', true);
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
    check('images uploads work after scanner failure', true);
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
    // Route downloads for this browser session (the main suite only
    // configures its own browser).
    const camDlSession = await camBrowser.target().createCDPSession();
    await camDlSession.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.join(__dirname, 'downloads'),
    });
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
    // Document mode (default): capture → processed review → accept.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Capture page')
        ?.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('Scan ready'), {
      timeout: 120000,
    });
    check('images scan produces a processed review', true);
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Use scan')?.click();
    });
    await page.waitForFunction(
      () => document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length === 1,
      { timeout: 30000 },
    );
    let cards = await page.evaluate(() =>
      [...document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li')].map(
        (li) => li.getAttribute('aria-label') ?? '',
      ),
    );
    check(
      'images accepted scan enters the page collection',
      cards.length === 1 && cards[0].includes('scan-'),
      cards.join(' | '),
    );
    // Scan more in Grayscale mode: collection preserved, second page added.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Scan more')?.click();
    });
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v !== null && v.videoWidth > 100;
      },
      { timeout: 30000 },
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Grayscale scan mode')
        ?.click();
    });
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Capture page')
        ?.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('Scan ready'), {
      timeout: 120000,
    });
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Use scan')?.click();
    });
    await page.waitForFunction(
      () => document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length === 2,
      { timeout: 30000 },
    );
    cards = await page.evaluate(() =>
      [...document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li')].map(
        (li) => li.getAttribute('aria-label') ?? '',
      ),
    );
    check(
      'images scan-more preserves pages across sessions',
      cards.length === 2,
      cards.join(' | '),
    );
    // Stale-result safety: capture then leave immediately — no page appears.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Scan more')?.click();
    });
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
        .find((b) => b.getAttribute('aria-label') === 'Done scanning')
        ?.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
    const count = await page.evaluate(
      () => document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length,
    );
    check('images stale scan result never becomes a page', count === 2, `pages=${count}`);
    // Responsive HUD geometry: dock below viewport, pill inside it,
    // strip below the dock — at desktop and narrow-phone widths.
    // (Torch/zoom stay hidden: the fake track reports no capabilities.)
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
    // Strip lives between viewport and dock: below the framing area,
    // above the shutter row.
    const hudSane = (g) =>
      g.viewport !== null &&
      g.shutter !== null &&
      g.shutter.top >= g.viewport.bottom - 1 &&
      (g.pill === null || (g.pill.top >= g.viewport.top && g.pill.bottom <= g.viewport.bottom)) &&
      (g.strip === null ||
        (g.strip.top >= g.viewport.bottom - 1 && g.strip.bottom <= g.shutter.top + 1)) &&
      g.torch === false;
    // Desktop composition (current 1280px viewport): reopen the scanner.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Scan more')?.click();
    });
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v !== null && v.videoWidth > 100;
      },
      { timeout: 30000 },
    );
    let hud = await hudGeometry();
    check('images scanner HUD layers cleanly on desktop', hudSane(hud), JSON.stringify(hud));
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === 'Done scanning')
        ?.click();
    });
    // Narrow phone: fresh scanner session plus one accept (so the
    // session strip is present), then the same geometry assertions.
    await page.setViewport({ width: 375, height: 667 });
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Scan more')?.click();
    });
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
    });
    await page.waitForFunction(() => document.body.innerText.includes('Scan ready'), {
      timeout: 120000,
    });
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Use scan')?.click();
    });
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Pages captured this session"]') !== null,
      { timeout: 30000 },
    );
    hud = await hudGeometry();
    check('images scanner HUD layers cleanly on narrow phone', hudSane(hud), JSON.stringify(hud));
    await page.setViewport({ width: 1280, height: 900 });
    // Scanned pages build a real PDF. Proven in-page (second browser
    // sessions don't route OS downloads): fetch the result blob and
    // assert real PDF bytes. Download plumbing itself is covered by the
    // main-browser download tests above.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.startsWith('Build PDF'))
        ?.click();
    });
    await page.waitForFunction(() => document.querySelector('a[download]') !== null, {
      timeout: 300000,
    });
    const probe = await page.evaluate(async () => {
      const a = document.querySelector('a[download]');
      if (!a) return null;
      const res = await fetch(a.href);
      const buf = new Uint8Array(await res.arrayBuffer());
      return { bytes: buf.length, magic: String.fromCharCode(...buf.slice(0, 5)) };
    });
    check(
      'images scanned pages build a PDF',
      probe !== null && probe.magic === '%PDF-' && probe.bytes > 10000,
      probe ? `${probe.magic} ${probe.bytes} bytes` : 'missing',
    );
    if (consoleErrors.length > 0)
      console.log(`[section-errors] ${consoleErrors.join(' | ').slice(0, 500)}`);
    await page.close();
    await camBrowser.close();
    try {
      fs.unlinkSync(y4m);
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
    await page.waitForFunction(() => document.body.innerText.includes('ready to merge'), {
      timeout: 300000,
    });
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
  if (failed.length > 0) {
    console.log('Failed:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

async function waitForDownload(dir, timeoutMs, before = new Set()) {
  const start = Date.now();
  for (;;) {
    const files = fs.readdirSync(dir);
    const fresh = files.filter((f) => !before.has(f));
    // A stuck `.crdownload` still counts as progress: keep waiting for it
    // to resolve instead of reporting "no download". Slow blob writes
    // under load can take minutes for ~10 MB files.
    const done = fresh.filter((f) => !f.endsWith('.crdownload'));
    if (done.length > 0) {
      // Wait for the file to stop growing (download complete).
      const full = path.join(dir, done[0]);
      let s1 = -1;
      let s2 = -2;
      try {
        s2 = fs.statSync(full).size;
      } catch {
        break;
      }
      while (s1 !== s2 && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 500));
        s1 = s2;
        try {
          s2 = fs.statSync(full).size;
        } catch {
          break;
        }
      }
      return done[0];
    }
    if (Date.now() - start > timeoutMs) {
      const pending = fresh.join(', ');
      console.log(`[download-wait] timed out with pending: ${pending || '(none started)'}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch((error) => {
  console.error('E2E fatal:', error);
  process.exit(1);
});
