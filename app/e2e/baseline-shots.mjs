/** Baseline screenshots of the Folio dev UI (light theme). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(__dirname, '../../test pdfs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5201';
const OUT = path.join(__dirname, 'baseline');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.evaluateOnNewDocument(() => localStorage.clear());
await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: `${OUT}/home.png` });
await page.goto(`${BASE}/#/merge`, { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: `${OUT}/merge-empty.png` });
await page.goto(`${BASE}/#/split`, { waitUntil: 'networkidle0', timeout: 60000 });
const input = await page.$('input[type="file"]');
await input.uploadFile(path.join(CORPUS, '1.2.pdf'));
// NOTE: the legacy main-thread fallback renderer saturates the page's main
// thread in headless shell, so CDP evaluate polling times out. Capture
// blind after a fixed settle window instead (screenshots don't need JS).
await new Promise((r) => setTimeout(r, 150000));
await page.screenshot({ path: `${OUT}/split-grid.png` });
await browser.close();
console.log('baseline screenshots saved');
