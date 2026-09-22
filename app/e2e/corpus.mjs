/**
 * Shared E2E corpus policy (Phase 3).
 *
 * Canonical vs optional split:
 *
 * - `studio.e2e.mjs` is the CANONICAL suite. It must pass from a fresh clone
 *   with no private corpus: when the small `test pdfs/` fixtures are absent it
 *   falls back to deterministic synthetic PDFs generated below (same page
 *   shapes, ASCII metadata), and it SKIPs only the large-file sections.
 * - `large-files.e2e.mjs`, `thumbnail.e2e.mjs`, `metadata.e2e.mjs` are
 *   OPTIONAL suites: they assert corpus-specific facts (private titles,
 *   authors, dates, 39/80/2585 page counts) that cannot be synthesized
 *   honestly, so they exit 0 with an explicit SKIP when the corpus is absent.
 *   Use `missingFiles()` + `reportOptionalSkip()` for that guard.
 *
 * The optional developer-owned corpus lives in the gitignored `test pdfs/`
 * directory at the repo root and is never committed (see `.gitignore`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Gitignored, optional, never committed. Absent on fresh clones. */
export const CORPUS_DIR = path.resolve(__dirname, '../../test pdfs');

/** Names (relative to CORPUS_DIR) that are absent from disk. */
export function missingFiles(names) {
  return names.filter((n) => !fs.existsSync(path.join(CORPUS_DIR, n)));
}

/**
 * Clean SKIP for optional suites: prints why, exits 0 (a missing optional
 * corpus is not a failure). Call before launching the browser.
 */
export function reportOptionalSkip(suite, missing) {
  console.log(`SKIP — optional corpus unavailable (${suite})`);
  console.log(`  Missing ${missing.length} file(s) in ${CORPUS_DIR}:`);
  for (const name of missing) console.log(`    - ${name}`);
  console.log('  Canonical testing does not require these files;');
  console.log('  run `node e2e/studio.e2e.mjs` for the fresh-clone suite.');
  process.exit(0);
}

function pdfEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Deterministic minimal PDF: N blank US-Letter pages plus a standard Info
 * dict. ASCII metadata only (keeps the writer byte-exact under latin1).
 * Parses under lopdf and loads under PDF.js; used ONLY as a fresh-clone
 * stand-in for the small private fixtures, never as large-file evidence.
 */
export function buildMinimalPdf({ pages, info = {} }) {
  if (!Number.isInteger(pages) || pages < 1) {
    throw new Error('buildMinimalPdf: pages must be a positive integer');
  }
  const kids = [];
  for (let i = 0; i < pages; i += 1) kids.push(`${3 + i} 0 R`);
  const objs = [];
  objs[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1');
  objs[2] = Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`, 'latin1');
  for (let i = 0; i < pages; i += 1) {
    objs[3 + i] = Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>',
      'latin1',
    );
  }
  const infoNum = 3 + pages;
  const entries = [];
  if (info.title !== undefined) entries.push(`/Title (${pdfEscape(info.title)})`);
  if (info.author !== undefined) entries.push(`/Author (${pdfEscape(info.author)})`);
  if (info.subject !== undefined) entries.push(`/Subject (${pdfEscape(info.subject)})`);
  if (info.keywords !== undefined) entries.push(`/Keywords (${pdfEscape(info.keywords)})`);
  if (info.creator !== undefined) entries.push(`/Creator (${pdfEscape(info.creator)})`);
  if (info.producer !== undefined) entries.push(`/Producer (${pdfEscape(info.producer)})`);
  entries.push("/CreationDate (D:20260101000000+05'30')");
  objs[infoNum] = Buffer.from(`<< ${entries.join(' ')} >>`, 'latin1');
  const size = infoNum + 1;

  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [0];
  const totalLength = () => parts.reduce((a, b) => a + b.length, 0);
  for (let n = 1; n <= infoNum; n += 1) {
    offsets[n] = totalLength();
    parts.push(Buffer.from(`${n} 0 obj\n`, 'latin1'), objs[n], Buffer.from('\nendobj\n', 'latin1'));
  }
  const xrefPos = totalLength();
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n <= infoNum; n += 1) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${size} /Root 1 0 R /Info ${infoNum} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/**
 * Writes a synthetic stand-in PDF to a fresh OS temp dir (never the repo, so
 * nothing needs gitignoring) and returns its absolute path.
 */
export function writeSyntheticPdf({ name, pages, info }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-e2e-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buildMinimalPdf({ pages, info }));
  return file;
}
