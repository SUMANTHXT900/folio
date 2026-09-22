/**
 * Minimal VALID PDF generator for simulated operation outputs.
 *
 * The temporary local adapter needs downloadable, reloadable bytes so the
 * Save and re-inspect flows work end-to-end. Rather than opaque junk, it
 * emits a real, minimal PDF (catalog → pages → N MediaBox pages, optional
 * per-page `/Rotate`, Info title declaring its simulated origin) with a
 * correct xref table. Validity is verifiable with the actual Rust engine
 * (`cargo run --example inspect_pdf`), which is part of Lesson 9 checks.
 *
 * This lives in the engine-adapter layer (engine side of the boundary),
 * never in UI components. It is used only by the unit-test mock adapter.
 */

export interface PlaceholderPage {
  rotationDeg?: number;
}

const encoder = new TextEncoder();

function toBytes(text: string): number[] {
  return Array.from(encoder.encode(text));
}

export function makePlaceholderPdf(
  pageCount: number,
  label: string,
  pages: PlaceholderPage[] = [],
): Uint8Array {
  const count = Math.max(1, Math.floor(pageCount));
  const objects: number[][] = [];

  // 1: catalog, 2: pages, 3..: page objects, last: info dict.
  objects.push(toBytes('<< /Type /Catalog /Pages 2 0 R >>'));
  const kids = Array.from({ length: count }, (_, i) => `${3 + i} 0 R`).join(' ');
  objects.push(toBytes(`<< /Type /Pages /Kids [${kids}] /Count ${count} >>`));
  for (let i = 0; i < count; i += 1) {
    const rotation = pages[i]?.rotationDeg ?? 0;
    const rotate = rotation !== 0 ? ` /Rotate ${rotation}` : '';
    objects.push(toBytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${rotate} >>`));
  }
  const infoId = 3 + count;
  const title = `folio-engine testbench (simulated) - ${label}`.replace(/[()\\]/g, '_');
  objects.push(toBytes(`<< /Title (${title}) /Producer (folio-testbench-sim) >>`));

  const out: number[] = [...toBytes('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out.push(...toBytes(`${index + 1} 0 obj\n`));
    out.push(...body);
    out.push(...toBytes('\nendobj\n'));
  });
  const xrefStart = out.length;
  const size = objects.length + 1;
  out.push(...toBytes(`xref\n0 ${size}\n`));
  out.push(...toBytes('0000000000 65535 f \n'));
  for (const offset of offsets) {
    out.push(...toBytes(`${String(offset).padStart(10, '0')} 00000 n \n`));
  }
  out.push(...toBytes(`trailer\n<< /Size ${size} /Root 1 0 R /Info ${infoId} 0 R >>\n`));
  out.push(...toBytes(`startxref\n${xrefStart}\n%%EOF`));
  return new Uint8Array(out);
}
