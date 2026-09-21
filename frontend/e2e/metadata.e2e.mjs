/**
 * Lesson 15 metadata E2E (real headless Chrome, real Rust/WASM engine).
 *
 * Drives `pdf.read_metadata` + `pdf.set_metadata` through the production
 * path (Developer Console adapter → Web Worker → WASM → lopdf) via the
 * `window.__folioE2E` hook: read corpus metadata, patch fields, write an
 * output, re-read the output (round-trip), verify Unicode/dates/clears,
 * error codes, progress streaming, XMP preservation, and the large-file
 * read/write/reopen cycle.
 *
 * IDM-proof transports (see e2e/thumbnail.e2e.mjs): test bytes travel
 * Node → page as base64 chunks over the DevTools protocol — zero HTTP
 * byte transfers, so download managers cannot intercept the harness.
 *
 * Usage (from frontend/):
 *   1. Terminal A: npx vite --port 5199   (or any free port + --dev)
 *   2. Terminal B: node e2e/metadata.e2e.mjs [--dev http://localhost:5199]
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
  rich: '2. EWTL-Uniform Plane Wave.pdf',
  partial: '1.2.pdf',
  empty: 'AI_ML vs. Software-Defined Vehicles_ Course and Career Comparison.pdf',
  large: 'merged.pdf',
};

const CHUNK_BYTES = 6 * 1024 * 1024;

async function pushBytes(page, id, absPath) {
  const stat = fs.statSync(absPath);
  const total = stat.size;
  await page.evaluate(
    ([key, size]) => {
      window.__metaBytes = window.__metaBytes ?? {};
      window.__metaPending = window.__metaPending ?? {};
      window.__metaPending[key] = { buf: new Uint8Array(size), off: 0 };
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
          const p = window.__metaPending[key];
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
      const p = window.__metaPending[key];
      const ok = p.off === size;
      window.__metaBytes[key] = p.buf;
      delete window.__metaPending[key];
      return { bytes: window.__metaBytes[key].length, complete: ok };
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
  await page.waitForFunction('Boolean(window.__folioE2E?.engine)', { timeout: 30000 });
  const flavor = await page.evaluate(() => window.__folioE2E.engineInfo());
  console.log(`engine: ${flavor.kind} (simulated=${flavor.simulated})`);
  check(
    'real WASM engine in the browser',
    flavor.kind === 'wasm-worker' && flavor.simulated === false,
  );

  console.log('Pushing test bytes over CDP (no HTTP, IDM-proof)…');
  await pushBytes(page, 'rich', path.resolve(PDF_DIR, FILE_NAMES.rich));
  await pushBytes(page, 'partial', path.resolve(PDF_DIR, FILE_NAMES.partial));
  await pushBytes(page, 'empty', path.resolve(PDF_DIR, FILE_NAMES.empty));

  // Phase 1: corpus read/set/round-trip/unicode/errors/progress.
  const phase1 = await page.evaluate(async (files) => {
    const out = {};
    const hook = window.__folioE2E;
    const store = window.__metaBytes;

    async function runOp(operation, name, bytes, options) {
      const events = [];
      const { jobId, done } = hook.engine.execute({
        operation,
        inputs: [{ name, bytes }],
        options,
      });
      const unsub = hook.engine.subscribe(jobId, (e) => events.push(e));
      const finished = await done;
      unsub();
      return { finished, events };
    }
    const progressCount = (events) => events.filter((e) => e.kind === 'progress').length;

    // --- Read rich corpus metadata ---
    let t0 = performance.now();
    const read = await runOp('pdf.read_metadata', files.rich, store.rich, {});
    out.readMs = performance.now() - t0;
    out.readStatus = read.finished.status;
    out.readProgressEvents = progressCount(read.events);
    const summary = read.finished.result?.summary;
    out.readPageCount = summary?.pageCount;
    out.readMeta = summary?.metadata;
    out.readDurationMs = read.finished.engineDurationMs;

    // --- Patch: set title (Unicode), clear author, set keywords ---
    t0 = performance.now();
    const set = await runOp('pdf.set_metadata', files.rich, store.rich, {
      patch: {
        title: { op: 'set', value: 'E2E Title — 中文テスト 🎉' },
        author: { op: 'clear' },
        keywords: { op: 'set', value: 'e2e, тест, తెలుగు' },
      },
    });
    out.setMs = performance.now() - t0;
    out.setStatus = set.finished.status;
    out.setProgressEvents = progressCount(set.events);
    out.setDurationMs = set.finished.engineDurationMs;
    const output = set.finished.result?.outputs?.[0];
    out.outputName = output?.name ?? null;
    out.outputBytes = output ? (hook.getOutputBytes(output.outputId)?.length ?? null) : null;
    window.__metaOut1 = output ? hook.getOutputBytes(output.outputId) : null;

    // --- Re-read the output (round-trip) ---
    const reread = await runOp('pdf.read_metadata', 'reread.pdf', window.__metaOut1, {});
    out.rereadMeta = reread.finished.result?.summary?.metadata;
    out.rereadPages = reread.finished.result?.summary?.pageCount;
    const outText = new TextDecoder('latin1').decode(window.__metaOut1);
    out.outputHasXmp = outText.includes('x:xmpmeta');

    // --- Unicode + date patch on the rich bytes ---
    const uni = await runOp('pdf.set_metadata', files.rich, store.rich, {
      patch: {
        author: { op: 'set', value: 'తెలుగు రచయిత' },
        subject: { op: 'set', value: 'हिन्दी विषय' },
        creator: { op: 'set', value: 'Tést — tëst' },
        creation_date: {
          op: 'set',
          value: {
            year: 2026,
            month: 1,
            day: 23,
            hour: 9,
            minute: 30,
            second: 0,
            tz_offset_minutes: 330,
          },
        },
        modification_date: { op: 'clear' },
      },
    });
    const uniOut = uni.finished.result?.outputs?.[0];
    const uniBytes = uniOut ? hook.getOutputBytes(uniOut.outputId) : null;
    const uniRead = await runOp('pdf.read_metadata', 'uni.pdf', uniBytes, {});
    out.uniMeta = uniRead.finished.result?.summary?.metadata;

    // --- Error paths: empty set → INVALID_INPUT, bad op → INVALID_OPTIONS ---
    const emptySet = await runOp('pdf.set_metadata', files.rich, store.rich, {
      patch: { title: { op: 'set', value: '' } },
    });
    out.emptySetCode = emptySet.finished.error?.code ?? emptySet.finished.status;
    const badOp = await runOp('pdf.set_metadata', files.rich, store.rich, {
      patch: { title: { op: 'bogus' } },
    });
    out.badOpCode = badOp.finished.error?.code ?? badOp.finished.status;
    const badDate = await runOp('pdf.set_metadata', files.rich, store.rich, {
      patch: {
        creation_date: {
          op: 'set',
          value: {
            year: 2026,
            month: 13,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
            tz_offset_minutes: 0,
          },
        },
      },
    });
    out.badDateCode = badDate.finished.error?.code ?? badDate.finished.status;

    // --- Sparse metadata (title/author present, dates absent) ---
    const empty = await runOp('pdf.read_metadata', files.empty, store.empty, {});
    out.emptyMeta = empty.finished.result?.summary?.metadata;
    out.emptyPages = empty.finished.result?.summary?.pageCount;

    // --- Partial metadata (1.2.pdf): title present, subject absent,
    // --- empty-string author preserved as "" (not normalized to null).
    const partial = await runOp('pdf.read_metadata', files.partial, store.partial, {});
    out.partialMeta = partial.finished.result?.summary?.metadata;

    return out;
  }, FILE_NAMES);

  console.log('\n--- phase 1 outcome ---');
  console.log(JSON.stringify(phase1, null, 2));

  await pushBytes(page, 'large', path.resolve(PDF_DIR, FILE_NAMES.large));

  // Phase 2: large-file read/write/reopen + cancel race.
  const phase2 = await page.evaluate(async (files) => {
    const out = {};
    const hook = window.__folioE2E;
    const store = window.__metaBytes;

    async function runOp(operation, name, bytes, options) {
      const events = [];
      const { jobId, done } = hook.engine.execute({
        operation,
        inputs: [{ name, bytes }],
        options,
      });
      const unsub = hook.engine.subscribe(jobId, (e) => events.push(e));
      const finished = await done;
      unsub();
      return { finished, events };
    }

    let t0 = performance.now();
    const read = await runOp('pdf.read_metadata', files.large, store.large, {});
    out.readMs = performance.now() - t0;
    out.readStatus = read.finished.status;
    out.readPages = read.finished.result?.summary?.pageCount;
    out.readDurationMs = read.finished.engineDurationMs;

    t0 = performance.now();
    const set = await runOp('pdf.set_metadata', files.large, store.large, {
      patch: { title: { op: 'set', value: 'Large E2E Title' } },
    });
    out.setMs = performance.now() - t0;
    out.setStatus = set.finished.status;
    out.setDurationMs = set.finished.engineDurationMs;
    const output = set.finished.result?.outputs?.[0];
    const outBytes = output ? hook.getOutputBytes(output.outputId) : null;
    out.outputBytes = outBytes?.length ?? null;

    t0 = performance.now();
    const reread = await runOp('pdf.read_metadata', 'large-out.pdf', outBytes, {});
    out.rereadMs = performance.now() - t0;
    out.rereadTitle = reread.finished.result?.summary?.metadata?.title ?? null;
    out.rereadPages = reread.finished.result?.summary?.pageCount;

    // Cancel race on a second large write: either outcome is acceptable,
    // but the run must settle honestly with no corrupt output.
    const { jobId, done } = hook.engine.execute({
      operation: 'pdf.set_metadata',
      inputs: [{ name: files.large, bytes: store.large }],
      options: { patch: { title: { op: 'set', value: 'Race' } } },
    });
    const cancelPromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await hook.engine.cancel(jobId);
    })();
    const [finished] = await Promise.all([done, cancelPromise]);
    out.cancelRaceStatus = finished.status;
    out.cancelRaceCode = finished.error?.code ?? null;
    if (finished.status === 'completed') {
      const raceOut = finished.result?.outputs?.[0];
      const raceBytes = raceOut ? hook.getOutputBytes(raceOut.outputId) : null;
      const verify = await runOp('pdf.read_metadata', 'race.pdf', raceBytes, {});
      out.cancelRaceReparseTitle = verify.finished.result?.summary?.metadata?.title ?? null;
    }
    return out;
  }, FILE_NAMES);

  console.log('\n--- phase 2 outcome ---');
  console.log(JSON.stringify(phase2, null, 2));

  // --- Assertions ---
  const m = phase1.readMeta ?? {};
  check(
    'corpus read works via WASM',
    phase1.readStatus === 'completed',
    `${phase1.readStatus} in ${Number(phase1.readMs).toFixed(0)} ms`,
  );
  check(
    'corpus title/author/dates correct',
    m.title === 'PowerPoint Presentation' && m.author === 'pradeep vinaik kodavanti',
    `title=${JSON.stringify(m.title)} author=${JSON.stringify(m.author)}`,
  );
  check(
    'corpus creation date typed with +05:30',
    m.creationDate?.year === 2026 && m.creationDate?.tzOffsetMinutes === 330,
    JSON.stringify(m.creationDate),
  );
  check('corpus page count 80', phase1.readPageCount === 80, String(phase1.readPageCount));
  check(
    'progress streams on read',
    (phase1.readProgressEvents ?? 0) >= 1,
    `${phase1.readProgressEvents} progress events`,
  );
  check(
    'set writes an output',
    phase1.setStatus === 'completed' && (phase1.outputBytes ?? 0) > 0,
    `${phase1.setStatus} ${phase1.outputBytes} bytes in ${Number(phase1.setMs).toFixed(0)} ms`,
  );
  check(
    'progress streams on write',
    (phase1.setProgressEvents ?? 0) >= 1,
    `${phase1.setProgressEvents} progress events`,
  );
  const r = phase1.rereadMeta ?? {};
  check(
    'round-trip: Unicode title survives',
    r.title === 'E2E Title — 中文テスト 🎉',
    JSON.stringify(r.title),
  );
  check(
    'round-trip: cleared author is absent',
    r.author === null || r.author === undefined,
    JSON.stringify(r.author),
  );
  check(
    'round-trip: keywords set, creator preserved',
    r.keywords === 'e2e, тест, తెలుగు' && typeof r.creator === 'string',
    `keywords=${JSON.stringify(r.keywords)} creator=${JSON.stringify(r.creator)}`,
  );
  check(
    'round-trip: page count unchanged (80)',
    phase1.rereadPages === 80,
    String(phase1.rereadPages),
  );
  check('XMP survives the write', phase1.outputHasXmp === true);
  const u = phase1.uniMeta ?? {};
  check(
    'Unicode scripts round-trip',
    u.author === 'తెలుగు రచయిత' && u.subject === 'हिन्दी विषय' && u.creator === 'Tést — tëst',
    JSON.stringify({ author: u.author, subject: u.subject, creator: u.creator }),
  );
  check(
    'date set + clear round-trip',
    u.creationDate?.tzOffsetMinutes === 330 && u.modificationDate == null,
    JSON.stringify({ creation: u.creationDate, modification: u.modificationDate }),
  );
  check(
    'empty set-value → INVALID_INPUT',
    phase1.emptySetCode === 'INVALID_INPUT',
    phase1.emptySetCode,
  );
  check('bad patch op → INVALID_OPTIONS', phase1.badOpCode === 'INVALID_OPTIONS', phase1.badOpCode);
  check(
    'out-of-range date → INVALID_INPUT',
    phase1.badDateCode === 'INVALID_INPUT',
    phase1.badDateCode,
  );
  const e = phase1.emptyMeta ?? {};
  check(
    'sparse metadata: present reads, absent reads as null',
    typeof e.title === 'string' &&
      e.subject == null &&
      e.keywords == null &&
      e.creationDate == null &&
      e.modificationDate == null,
    `title=${JSON.stringify(e.title)} pages=${phase1.emptyPages}`,
  );
  const p = phase1.partialMeta ?? {};
  check(
    'partial metadata: present stays, absent is null, empty string preserved',
    typeof p.title === 'string' && p.subject == null && p.author === '',
    JSON.stringify({ title: p.title, subject: p.subject, author: p.author }),
  );

  check(
    'large read: 2585 pages',
    phase2.readStatus === 'completed' && phase2.readPages === 2585,
    `${phase2.readPages} pp in ${Number(phase2.readMs).toFixed(0)} ms (engine ${Number(phase2.readDurationMs).toFixed(0)} ms)`,
  );
  check(
    'large write produces output',
    phase2.setStatus === 'completed' && (phase2.outputBytes ?? 0) > 100 * 1024 * 1024,
    `${((phase2.outputBytes ?? 0) / 1048576).toFixed(0)} MB in ${Number(phase2.setMs).toFixed(0)} ms`,
  );
  check(
    'large round-trip: title + page count',
    phase2.rereadTitle === 'Large E2E Title' && phase2.rereadPages === 2585,
    `title=${JSON.stringify(phase2.rereadTitle)} pages=${phase2.rereadPages} in ${Number(phase2.rereadMs).toFixed(0)} ms`,
  );
  const raceOk =
    (phase2.cancelRaceStatus === 'cancelled' && phase2.cancelRaceCode === 'CANCELLED') ||
    (phase2.cancelRaceStatus === 'completed' && phase2.cancelRaceReparseTitle === 'Race');
  check(
    'large cancel race settles honestly',
    raceOk,
    `${phase2.cancelRaceStatus}/${phase2.cancelRaceCode}`,
  );
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
        corpus: { readMs: phase1.readMs, setMs: phase1.setMs, outputBytes: phase1.outputBytes },
        large: {
          readMs: phase2.readMs,
          setMs: phase2.setMs,
          outputBytes: phase2.outputBytes,
          rereadMs: phase2.rereadMs,
          readDurationMs: phase2.readDurationMs,
          setDurationMs: phase2.setDurationMs,
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
