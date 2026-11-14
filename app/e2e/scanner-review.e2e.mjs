/**
 * Bounded real-Chromium scanner review smoke.
 *
 * Uses the real app, Scanic ML workers, and PDF/WASM build path. Inputs are
 * deterministic synthetic JPEG files generated once into the OS temp folder.
 * The 60-page run uses small repeated inputs and validates navigation only; it
 * is not a high-resolution or performance benchmark.
 *
 * Run: node e2e/scanner-review.e2e.mjs http://127.0.0.1:5202
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5202';
const outputDir = path.join(os.tmpdir(), 'opencode', 'folio-scanner-review');
fs.mkdirSync(outputDir, { recursive: true });
const noSandboxArgs =
  process.env.FOLIO_CHROME_NO_SANDBOX === '1' || process.env.CI === 'true' ? ['--no-sandbox'] : [];

const checks = [];
const check = (name, condition, detail = '') => {
  checks.push({ name, passed: Boolean(condition), detail });
  if (!condition) console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--enable-unsafe-swiftshader',
    ...noSandboxArgs,
  ],
});

const page = await browser.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

async function waitForReady(timeout = 90000) {
  await page.waitForFunction(
    () => {
      const build = document.querySelector('[data-build-pdf]');
      return (
        build !== null &&
        !build.disabled &&
        document.querySelector('[data-build-state]')?.getAttribute('data-build-state') === 'ready'
      );
    },
    { timeout },
  );
}

async function measureReviewGeometry() {
  return page.evaluate(() => {
    const queue = document.querySelector('[data-scan-queue]');
    const mat = document.querySelector('[data-crop-result]');
    const image = mat?.querySelector('[data-crop-result-img]');
    if (!queue || !mat || !image || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      return null;
    }

    const queueRect = queue.getBoundingClientRect();
    const queueStyle = getComputedStyle(queue);
    const contentLeft =
      queueRect.left + queue.clientLeft + Number.parseFloat(queueStyle.paddingLeft || '0');
    const contentRight =
      queueRect.left +
      queue.clientLeft +
      queue.clientWidth -
      Number.parseFloat(queueStyle.paddingRight || '0');
    const contentWidth = contentRight - contentLeft;
    const matRect = mat.getBoundingClientRect();
    const imageBox = image.getBoundingClientRect();
    const scale = Math.min(
      imageBox.width / image.naturalWidth,
      imageBox.height / image.naturalHeight,
    );
    const renderedWidth = image.naturalWidth * scale;
    const renderedHeight = image.naturalHeight * scale;
    const pageContent = {
      left: imageBox.left + (imageBox.width - renderedWidth) / 2,
      top: imageBox.top + (imageBox.height - renderedHeight) / 2,
      right: imageBox.left + (imageBox.width + renderedWidth) / 2,
      bottom: imageBox.top + (imageBox.height + renderedHeight) / 2,
    };
    const contentCenterX = (contentLeft + contentRight) / 2;
    const matCenterX = (matRect.left + matRect.right) / 2;
    const pageCenterX = (pageContent.left + pageContent.right) / 2;
    const pageCenterY = (pageContent.top + pageContent.bottom) / 2;
    const matCenterY = (matRect.top + matRect.bottom) / 2;
    const matStyle = getComputedStyle(mat);

    const workspaceCandidates = [];
    for (let node = mat.parentElement; node && node !== queue; node = node.parentElement) {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const maxWidth = Number.parseFloat(style.maxWidth);
      const hasReviewActions = node.querySelector('button[aria-label="Adjust corners"]') !== null;
      if (
        hasReviewActions &&
        Number.isFinite(maxWidth) &&
        maxWidth > 0 &&
        maxWidth < contentWidth - 16 &&
        rect.width >= matRect.width
      ) {
        workspaceCandidates.push({
          width: rect.width,
          height: rect.height,
          maxWidth,
          left: rect.left,
          right: rect.right,
          centerX: (rect.left + rect.right) / 2,
          className: typeof node.className === 'string' ? node.className : '',
        });
      }
    }
    workspaceCandidates.sort((a, b) => b.width - a.width);
    const workspace = workspaceCandidates[0] ?? null;

    return {
      viewport: [innerWidth, innerHeight],
      queueContent: { left: contentLeft, right: contentRight, width: contentWidth },
      mat: {
        left: matRect.left,
        right: matRect.right,
        top: matRect.top,
        bottom: matRect.bottom,
        width: matRect.width,
        height: matRect.height,
        centerX: matCenterX,
        centerY: matCenterY,
        centerDeltaFromContent: matCenterX - contentCenterX,
        leftGap: matRect.left - contentLeft,
        rightGap: contentRight - matRect.right,
        radius: Number.parseFloat(matStyle.borderTopLeftRadius),
      },
      image: {
        natural: [image.naturalWidth, image.naturalHeight],
        box: {
          left: imageBox.left,
          right: imageBox.right,
          top: imageBox.top,
          bottom: imageBox.bottom,
          width: imageBox.width,
          height: imageBox.height,
        },
        pageContent,
        centerDeltaFromMat: {
          x: pageCenterX - matCenterX,
          y: pageCenterY - matCenterY,
        },
        contentGaps: {
          left: pageContent.left - matRect.left,
          right: matRect.right - pageContent.right,
          top: pageContent.top - matRect.top,
          bottom: matRect.bottom - pageContent.bottom,
        },
        fit: getComputedStyle(image).objectFit,
      },
      workspace,
    };
  });
}

async function openScanner() {
  await page.goto(`${baseUrl}/#/images`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-scan-open]', { timeout: 30000 });
  await page.click('[data-scan-open]');
  await page.waitForSelector('[data-scanner-root]', { timeout: 30000 });
}

async function uploadFiles(files) {
  await page.$eval('[data-scan-more]', (button) => button.click());
  await page.waitForSelector('[data-scan-sheet]');
  const input = await page.$('input[aria-label="Add image files instead"]');
  assert.ok(input, 'scanner image input exists');
  await input.uploadFile(...files);
  await page.waitForSelector('[data-review-cta]', { timeout: 30000 });
  await page.click('[data-review-cta]');
  await page.waitForSelector('[data-scan-queue]', { timeout: 30000 });
}

async function clickExactButton(text) {
  for (const button of await page.$$('button')) {
    if ((await button.evaluate((element) => element.textContent.trim())) === text) {
      await button.click();
      return true;
    }
  }
  return false;
}

async function writeSyntheticJpeg(fileName, width, height, pageInset = 0.12) {
  const dataUrl = await page.evaluate(
    ({ width: w, height: h, inset }) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context unavailable');
      context.fillStyle = '#55595d';
      context.fillRect(0, 0, w, h);
      const x = Math.round(w * inset);
      const y = Math.round(h * inset);
      const pageWidth = Math.round(w * (1 - inset * 2));
      const pageHeight = Math.round(h * (1 - inset * 2));
      context.fillStyle = '#faf9f5';
      context.fillRect(x, y, pageWidth, pageHeight);
      context.strokeStyle = '#25292b';
      context.lineWidth = Math.max(8, Math.round(Math.min(w, h) * 0.012));
      context.strokeRect(x, y, pageWidth, pageHeight);
      context.fillStyle = '#34383a';
      context.font = `bold ${Math.round(Math.min(w, h) * 0.055)}px sans-serif`;
      context.fillText('FOLIO TEST PAGE', x + pageWidth * 0.12, y + pageHeight * 0.22);
      context.lineWidth = Math.max(2, Math.round(Math.min(w, h) * 0.003));
      for (let i = 0; i < 8; i++) {
        const lineY = y + pageHeight * (0.34 + i * 0.065);
        context.beginPath();
        context.moveTo(x + pageWidth * 0.12, lineY);
        context.lineTo(x + pageWidth * (i % 2 ? 0.78 : 0.86), lineY);
        context.stroke();
      }
      return canvas.toDataURL('image/jpeg', 0.96);
    },
    { width, height, inset: pageInset },
  );
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const filePath = path.join(outputDir, fileName);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

try {
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.goto('about:blank');
  const square = await writeSyntheticJpeg('square-page.jpg', 900, 900);
  const portrait = await writeSyntheticJpeg('portrait-page.jpg', 720, 1100);
  const landscape = await writeSyntheticJpeg('landscape-page.jpg', 1100, 720);

  // First real flow: import three deterministic JPEG files and let the real
  // Scanic workers detect/warp them before inspecting the result mat.
  await openScanner();
  await uploadFiles([square, portrait, landscape]);
  let preparationCancelled = false;
  if (await page.$('[data-review-preparing-cancel]')) {
    await page.click('[data-review-preparing-cancel]');
    await page.waitForSelector('[data-scan-capture]', { timeout: 30000 });
    const count = await page.$eval('[data-gallery-count]', (badge) => badge.textContent.trim());
    preparationCancelled = count === '3';
    await page.waitForSelector('[data-review-cta]', { timeout: 30000 });
    await page.click('[data-review-cta]');
    await page.waitForSelector('[data-scan-queue]', { timeout: 30000 });
  }
  check(
    'preparing cancellation keeps the imported queue and can re-enter review',
    preparationCancelled,
    preparationCancelled
      ? 'cancelled and re-entered with all three pages'
      : 'cancel control did not appear',
  );
  await waitForReady();

  const firstPage = await page.evaluate(() => {
    const result = document.querySelector('[data-crop-result]');
    const image = result?.querySelector('[data-crop-result-img]');
    const mat = result?.getBoundingClientRect();
    const img = image?.getBoundingClientRect();
    const style = result ? getComputedStyle(result) : null;
    return {
      imageCount: result?.querySelectorAll('img').length ?? 0,
      decoded: Boolean(image && image.naturalWidth > 0 && image.naturalHeight > 0),
      natural: image ? [image.naturalWidth, image.naturalHeight] : null,
      fit: image ? getComputedStyle(image).objectFit : null,
      radius: style ? Number.parseFloat(style.borderTopLeftRadius) : null,
      padding: style ? Number.parseFloat(style.paddingTop) : null,
      insets:
        mat && img
          ? [img.left - mat.left, img.top - mat.top, mat.right - img.right, mat.bottom - img.bottom]
          : null,
    };
  });
  check(
    'single decoded square-edged result is inset on all sides of the mat',
    firstPage.imageCount === 1 &&
      firstPage.decoded &&
      firstPage.fit === 'contain' &&
      firstPage.radius === 0 &&
      firstPage.padding >= 8 &&
      firstPage.insets?.every((inset) => inset >= 8),
    JSON.stringify(firstPage),
  );
  const desktopGeometry = await measureReviewGeometry();
  const desktopMatValid =
    desktopGeometry !== null &&
    desktopGeometry.mat.width >= desktopGeometry.queueContent.width * 0.6 &&
    Math.abs(desktopGeometry.mat.centerDeltaFromContent) <= 4 &&
    Math.abs(desktopGeometry.image.centerDeltaFromMat.x) <= 2 &&
    Math.abs(desktopGeometry.image.centerDeltaFromMat.y) <= 2 &&
    desktopGeometry.image.fit === 'contain' &&
    desktopGeometry.mat.radius === 0;
  check(
    'desktop result mat fills a centered workspace proportionally and centers the actual page content',
    desktopMatValid,
    JSON.stringify(desktopGeometry),
  );
  const workspaceValid =
    desktopGeometry?.workspace !== null &&
    desktopGeometry?.workspace !== undefined &&
    desktopGeometry.workspace.width < desktopGeometry.queueContent.width - 16 &&
    Math.abs(
      desktopGeometry.workspace.centerX -
        (desktopGeometry.queueContent.left + desktopGeometry.queueContent.right) / 2,
    ) <= 4;
  check(
    'desktop review workspace has an explicit bound and is centered in review content',
    workspaceValid,
    JSON.stringify(desktopGeometry?.workspace ?? null),
  );
  await page.screenshot({ path: path.join(outputDir, 'review-desktop.png') });

  // Narrow/short viewport; inspect square, portrait and landscape pages at
  // 320px width. No fixed bar should cover controls or overlap another control.
  // Keep desktop emulation mode: toggling Puppeteer's isMobile can reload the
  // page and erase the live scanner queue. The CSS viewport width is the
  // responsive condition being tested.
  await page.setViewport({ width: 320, height: 568, deviceScaleFactor: 1 });
  for (const [pageNumber, name] of [
    [1, 'square'],
    [2, 'portrait'],
    [3, 'landscape'],
  ]) {
    await page.click(`[data-film-thumb][aria-label="Go to page ${pageNumber}"]`);
    await page.waitForFunction(
      (index) =>
        document
          .querySelector(`[data-film-thumb][aria-current="true"]`)
          ?.getAttribute('aria-label') === `Go to page ${index}`,
      {},
      pageNumber,
    );
    await waitForReady();
    const matGeometry = await measureReviewGeometry();
    const mobileMatValid =
      matGeometry !== null &&
      matGeometry.mat.width >= matGeometry.queueContent.width * 0.84 &&
      Math.abs(matGeometry.mat.centerDeltaFromContent) <= 3 &&
      Math.abs(matGeometry.image.centerDeltaFromMat.x) <= 2 &&
      Math.abs(matGeometry.image.centerDeltaFromMat.y) <= 2 &&
      matGeometry.image.fit === 'contain' &&
      matGeometry.mat.radius === 0;
    check(
      `320x568 ${name} mat is content-width/centered with actual page content centered inside it`,
      mobileMatValid,
      JSON.stringify(matGeometry),
    );
    const geometry = await page.evaluate(() => {
      const queue = document.querySelector('[data-scan-queue]');
      const buttons = [...(queue?.querySelectorAll('button') ?? [])].filter((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        const thumb = button.matches('[data-film-thumb]');
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          (!thumb || button.getAttribute('aria-current') === 'true')
        );
      });
      const boxes = buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const centerOnScreen =
          centerX >= 0 && centerX < innerWidth && centerY >= 0 && centerY < innerHeight;
        return {
          label: button.getAttribute('aria-label') || button.textContent.trim(),
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          disabled: button.disabled,
          centerCovered: centerOnScreen
            ? document.elementFromPoint(centerX, centerY) !== button &&
              !button.contains(document.elementFromPoint(centerX, centerY))
            : null,
        };
      });
      const overlaps = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          if (
            Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1
          ) {
            overlaps.push([a.label, b.label]);
          }
        }
      }
      const image = document.querySelector('[data-crop-result-img]');
      return {
        viewport: [innerWidth, innerHeight],
        image: image ? [image.naturalWidth, image.naturalHeight] : null,
        buttons: boxes,
        tooSmall: boxes.filter((box) => box.width < 44 || box.height < 44),
        // The review area is intentionally a single scroll path on short
        // screens. Offscreen queue controls are reachable by scrolling; only
        // test hit target occlusion/overlap for controls currently onscreen.
        onscreen: boxes.filter(
          (box) =>
            box.x + box.width / 2 >= 0 &&
            box.x + box.width / 2 < innerWidth &&
            box.y + box.height / 2 >= 0 &&
            box.y + box.height / 2 < innerHeight,
        ),
        covered: boxes.filter((box) => box.centerCovered === true),
        overlaps,
      };
    });
    check(
      `320x568 ${name} review controls are >=44px, visible, uncovered and non-overlapping`,
      geometry.image !== null &&
        geometry.tooSmall.length === 0 &&
        geometry.onscreen.length > 0 &&
        geometry.covered.length === 0 &&
        geometry.overlaps.length === 0,
      JSON.stringify(geometry),
    );
    await page.screenshot({
      path: path.join(outputDir, `review-320x568-${name}.png`),
    });
  }
  const scrolledActionState = await page.evaluate(() => {
    const queue = document.querySelector('[data-scan-queue]');
    queue?.scrollTo({ top: queue.scrollHeight, behavior: 'instant' });
    const selectors = [
      '[data-page-prev]',
      '[data-page-next]',
      'button[aria-label="Adjust corners"]',
      '[data-redetect]',
      'button[aria-label="Use original"]',
      'button[aria-label="Discard"]',
      '[data-scan-add]',
      '[data-build-pdf]',
    ];
    return selectors.map((selector) => {
      const button = document.querySelector(selector);
      if (!button) return { selector, found: false };
      const rect = button.getBoundingClientRect();
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      const centerHit =
        centerX >= 0 &&
        centerX < innerWidth &&
        centerY >= 0 &&
        centerY < innerHeight &&
        (document.elementFromPoint(centerX, centerY) === button ||
          button.contains(document.elementFromPoint(centerX, centerY)));
      return {
        selector,
        found: true,
        width: rect.width,
        height: rect.height,
        inViewport:
          rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight,
        centerHit,
      };
    });
  });
  check(
    'review actions remain reachable by the single short-screen scroll path',
    scrolledActionState.every(
      (button) =>
        button.found &&
        button.width >= 44 &&
        button.height >= 44 &&
        button.inViewport &&
        button.centerHit,
    ),
    JSON.stringify(scrolledActionState),
  );
  await page.screenshot({ path: path.join(outputDir, 'review-320x568-actions.png') });

  const strips = await page.evaluate(() => {
    const allThumbs = [...document.querySelectorAll('[data-film-thumb]')];
    const filmstrip = document.querySelector('[data-scan-filmstrip]');
    const outsideThumbs = allThumbs.filter((thumb) => !filmstrip?.contains(thumb));
    return {
      stripCount: document.querySelectorAll('[data-scan-filmstrip]').length,
      thumbs: allThumbs.length,
      thumbsOutsideStrip: outsideThumbs.length,
      buildState: document.querySelector('[data-build-state]')?.getAttribute('data-build-state'),
      buildEnabled: !document.querySelector('[data-build-pdf]')?.disabled,
    };
  });
  check(
    'review has one real filmstrip (not duplicate external page dots)',
    strips.stripCount === 1 && strips.thumbs === 3 && strips.thumbsOutsideStrip === 0,
    JSON.stringify(strips),
  );
  check(
    'ready review has no build error and exact original/crop action labels',
    strips.buildState === 'ready' &&
      strips.buildEnabled &&
      (await page.$('[data-build-error]')) === null &&
      (await page.$('button[aria-label="Use original"]')) !== null,
    JSON.stringify(strips),
  );
  await page.click('button[aria-label="Use original"]');
  const originalToggle = await page.$('button[aria-label="Use auto-crop"]');
  check('Use original relabels exactly to Use auto-crop', originalToggle !== null);
  if (originalToggle) await originalToggle.click();
  await waitForReady();

  // Editing guard: adjustment controls are explicit; page navigation and build
  // cannot silently consume an in-progress draft.
  const beforeCancel = await page.$eval('[data-crop-result-img]', (image) =>
    image.getAttribute('src'),
  );
  await page.click('button[aria-label="Adjust corners"]');
  await page.waitForSelector('[data-crop-adjust]');
  const editState = await page.evaluate(() => ({
    apply: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Apply'),
    cancel: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Cancel'),
    nextDisabled: document.querySelector('[data-page-next]')?.disabled,
    buildDisabled: document.querySelector('[data-build-pdf]')?.disabled,
    filmThumbsEnabled: [...document.querySelectorAll('[data-film-thumb]')].some((b) => !b.disabled),
  }));
  check(
    'edit mode offers explicit Apply/Cancel and guards navigation/build',
    editState.apply &&
      editState.cancel &&
      editState.nextDisabled === true &&
      editState.buildDisabled === true &&
      editState.filmThumbsEnabled === false,
    JSON.stringify(editState),
  );

  assert.ok(await clickExactButton('Cancel'), 'explicit Cancel button exists');
  await page.waitForSelector('[data-crop-result]');
  const afterCancel = await page.$eval('[data-crop-result-img]', (image) =>
    image.getAttribute('src'),
  );
  check(
    'Cancel exits edit mode without changing the committed preview',
    !(await page.$('[data-crop-adjust]')) && beforeCancel === afterCancel,
  );

  await page.click('button[aria-label="Adjust corners"]');
  await page.waitForSelector('[data-crop-adjust]');
  assert.ok(await clickExactButton('Apply'), 'explicit Apply button exists');
  await page.waitForFunction(() => document.querySelector('[data-crop-adjust]') === null, {
    timeout: 30000,
  });
  await waitForReady();
  check(
    'Apply exits edit mode and returns to a settled review state',
    !(await page.$('[data-crop-adjust]')),
  );

  // Build these real processed/original verdicts through the app and WASM
  // engine. The visible download card proves the scanner handed off instead
  // of merely toggling a test-only state.
  await page.click('[data-build-pdf]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-build-overlay]') !== null ||
      document.querySelector('[data-scanner-root]') === null,
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () => {
      const pages = document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li');
      return (
        document.querySelector('[data-scanner-root]') === null &&
        pages.length === 3 &&
        document.body.innerText.includes("Done — what's next?")
      );
    },
    { timeout: 90000 },
  );
  const buildResult = await page.evaluate(() => ({
    scannerGone: document.querySelector('[data-scanner-root]') === null,
    pageRows: document.querySelectorAll('ul[aria-label="Pages in PDF order"] > li').length,
    completionVisible: document.body.innerText.includes("Done — what's next?"),
    secondBuildGate: [...document.querySelectorAll('button')].some((button) =>
      button.textContent.trim().startsWith('Build PDF'),
    ),
    errorVisible: document.querySelector('[data-build-error]') !== null,
  }));
  check(
    'real Build PDF commits exactly three pages with honest completion and no second build gate',
    buildResult.scannerGone &&
      buildResult.pageRows === 3 &&
      buildResult.completionVisible &&
      !buildResult.secondBuildGate &&
      !buildResult.errorVisible,
    JSON.stringify(buildResult),
  );

  // Navigation stress only: 60 small copies of one deterministic JPEG. This
  // deliberately makes no high-resolution or large-document performance
  // claim.
  const small = await writeSyntheticJpeg('navigation-small.jpg', 320, 480, 0.1);
  const repeated = Array.from({ length: 60 }, (_, index) => {
    const target = path.join(outputDir, `navigation-${String(index + 1).padStart(2, '0')}.jpg`);
    fs.copyFileSync(small, target);
    return target;
  });
  await openScanner();
  await uploadFiles(repeated);
  await page.waitForFunction(() => document.querySelectorAll('[data-film-thumb]').length === 60, {
    timeout: 30000,
  });
  const sixtyStart = await page.evaluate(() => ({
    stripCount: document.querySelectorAll('[data-scan-filmstrip]').length,
    thumbCount: document.querySelectorAll('[data-film-thumb]').length,
  }));
  check(
    '60 small deterministic inputs form one 60-page strip',
    sixtyStart.stripCount === 1 && sixtyStart.thumbCount === 60,
    JSON.stringify(sixtyStart),
  );

  for (let index = 2; index <= 60; index++) {
    await page.click('[data-page-next]');
    await page.waitForFunction(
      (i) =>
        document
          .querySelector('[data-film-thumb][aria-current="true"]')
          ?.getAttribute('aria-label') === `Go to page ${i}`,
      { timeout: 10000 },
      index,
    );
  }
  const lastPageVisibility = await page.evaluate(() => {
    const strip = document.querySelector('[data-scan-filmstrip]');
    const selected = strip?.querySelector('[data-film-thumb][aria-current="true"]');
    if (!strip || !selected) return null;
    const sr = strip.getBoundingClientRect();
    const tr = selected.getBoundingClientRect();
    return {
      label: selected.getAttribute('aria-label'),
      visible: tr.left >= sr.left && tr.right <= sr.right,
      scrollLeft: strip.scrollLeft,
      stripWidth: strip.clientWidth,
    };
  });
  check(
    'next navigation reaches page 60 and scrolls selected thumbnail into view',
    lastPageVisibility?.label === 'Go to page 60' &&
      lastPageVisibility.visible &&
      lastPageVisibility.scrollLeft > 0,
    JSON.stringify(lastPageVisibility),
  );
  await page.screenshot({ path: path.join(outputDir, 'review-60-last.png') });

  for (let index = 59; index >= 1; index--) {
    await page.click('[data-page-prev]');
    await page.waitForFunction(
      (i) =>
        document
          .querySelector('[data-film-thumb][aria-current="true"]')
          ?.getAttribute('aria-label') === `Go to page ${i}`,
      { timeout: 10000 },
      index,
    );
  }
  const firstPageVisibility = await page.evaluate(() => {
    const strip = document.querySelector('[data-scan-filmstrip]');
    const selected = strip?.querySelector('[data-film-thumb][aria-current="true"]');
    if (!strip || !selected) return null;
    const sr = strip.getBoundingClientRect();
    const tr = selected.getBoundingClientRect();
    return {
      label: selected.getAttribute('aria-label'),
      visible: tr.left >= sr.left && tr.right <= sr.right,
      scrollLeft: strip.scrollLeft,
    };
  });
  check(
    'previous navigation returns to page 1 and scrolls its thumbnail into view',
    firstPageVisibility?.label === 'Go to page 1' && firstPageVisibility.visible,
    JSON.stringify(firstPageVisibility),
  );
  await page.screenshot({ path: path.join(outputDir, 'review-60-first.png') });
  await page.click('[data-batch-bar] button:first-child');
  await page.waitForSelector('[data-scan-capture]', { timeout: 30000 });
  check(
    'discarding the 60-page navigation queue returns to camera without building',
    (await page.$('[data-scan-queue]')) === null,
  );
} catch (error) {
  console.error(error?.stack || error);
  try {
    await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true });
  } catch {
    // A closed or crashed page cannot produce a screenshot.
  }
  checks.push({ name: 'uncaught harness error', passed: false, detail: String(error) });
} finally {
  console.log(
    JSON.stringify(
      {
        url: page.url(),
        checks,
        pageErrors,
        consoleErrors,
        screenshots: outputDir,
      },
      null,
      2,
    ),
  );
  await browser.close();
}

if (checks.some((result) => !result.passed) || pageErrors.length > 0) process.exitCode = 1;
