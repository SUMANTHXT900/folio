import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, 'fixtures');
fs.mkdirSync(dir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'shell',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 120, height: 120 });
await page.setContent('<div style="width:120px;height:120px;background:#b3472a"></div>');
await page.screenshot({ path: path.join(dir, 'pixel.png'), type: 'png' });
await page.screenshot({ path: path.join(dir, 'pixel.jpg'), type: 'jpeg', quality: 85 });
await browser.close();
for (const f of ['pixel.png', 'pixel.jpg']) {
  const st = fs.statSync(path.join(dir, f));
  console.log(f, st.size, 'bytes');
}
