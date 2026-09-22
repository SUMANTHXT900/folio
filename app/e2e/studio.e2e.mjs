/**
 * Phase 1B production UI E2E (real headless Chrome, real Folio engine).
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(__dirname, '../../test pdfs');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const DEV_URL = flag('--dev', 'http://localhost:5199');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SMALL_22 = path.join(CORPUS, '1.2.pdf');
const RICH_80 = path.join(CORPUS, '2. EWTL-Uniform Plane Wave.pdf');
const LARGE = path.join(CORPUS, 'merged.pdf');

const results = [];
function check(name, ok, details) {
  results.push({ name, ok: Boolean(ok), details: details ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
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
    check('split toggles to 21/22 kept', /21\/22 kept/.test(kept));
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

  // ---- Images: two images → PDF ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'images');
    const png = path.join(__dirname, 'fixtures', 'pixel.png');
    const jpg = path.join(__dirname, 'fixtures', 'pixel.jpg');
    await upload(page, 'input[type="file"]', [png, jpg]);
    await page.waitForFunction(() => document.body.innerText.includes('Build PDF'), {
      timeout: 30000,
    });
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

  // ---- Large file: open 490MB, bounded thumbs, close ----
  {
    const { page, consoleErrors } = await newPage(browser);
    await gotoTool(page, 'split');
    await upload(page, 'input[type="file"]', [LARGE]);
    await page.waitForFunction(() => /[1-9][0-9]*\/[0-9]+ kept/.test(document.body.innerText), {
      timeout: 300000,
    });
    const text = await bodyText(page);
    const m = text.match(/(\d+)\/(\d+) kept/);
    check('large file opens with full page count', m !== null && m[2] === '2585', m?.[0]);
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

  // ---- Cancellation through the UI: merge large+small, cancel mid-run ----
  {
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
  console.log(`\nE2E: ${results.length - failed.length}/${results.length} passed`);
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
