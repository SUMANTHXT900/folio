/**
 * UI-side input parsing: syntax only, never engine semantics.
 *
 * These helpers transform human text (`"1,3,5"`) into structured API
 * input (`[1, 3, 5]`). They deliberately do NOT validate ranges,
 * duplicates, permutation completeness, or angles — the engine owns all
 * semantic validation and reports it with structured errors. Only
 * unparseable text (non-integers) is a client-side error.
 */

export type ParseResult = { ok: true; pages: number[] } | { ok: false; error: string };

/**
 * Parses `"1,3,5"` (also tolerates spaces and trailing commas) into page
 * numbers. Range syntax (`1-3`) is rejected: the core has no such concept.
 */
export function parsePageList(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: true, pages: [] };
  }
  const pages: number[] = [];
  for (const raw of trimmed.split(',')) {
    const entry = raw.trim();
    if (entry === '') {
      continue;
    }
    if (!/^-?\d+$/.test(entry)) {
      return { ok: false, error: `"${entry}" is not an integer` };
    }
    pages.push(Number.parseInt(entry, 10));
  }
  return { ok: true, pages };
}

/** Parses a single integer (rotation angle). */
export function parseAngle(
  text: string,
): { ok: true; angle: number } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return { ok: false, error: `"${text.trim()}" is not an integer` };
  }
  return { ok: true, angle: Number.parseInt(trimmed, 10) };
}

export interface SplitPartDraft {
  pages: number[];
  name?: string;
}

/** Parsed metadata date in wire form (mirrors Rust `PdfDate`). */
export interface ParsedMetadataDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  tzOffsetMinutes: number;
}

/**
 * Parses a metadata date as `YYYY-MM-DD HH:MM:SS +HHMM`
 * (e.g. `2026-01-23 09:30:00 +0530`; `Z` may replace the offset for
 * UTC). Ranges mirror the engine (`PdfDate::new` revalidates anyway):
 * month 1–12, day 1–31, hour 0–23, minute/second 0–59, offset ±23:59.
 */
export function parseMetadataDate(
  text: string,
): { ok: true; date: ParsedMetadataDate } | { ok: false; error: string } {
  const trimmed = text.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (Z|[+-]\d{4})$/.exec(trimmed);
  if (match === null) {
    return {
      ok: false,
      error: `"${trimmed}" is not a metadata date (expected YYYY-MM-DD HH:MM:SS +HHMM)`,
    };
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zoneText] = match;
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const second = Number.parseInt(secondText, 10);
  let tzOffsetMinutes: number;
  if (zoneText === 'Z') {
    tzOffsetMinutes = 0;
  } else {
    const sign = zoneText[0] === '-' ? -1 : 1;
    const zoneHour = Number.parseInt(zoneText.slice(1, 3), 10);
    const zoneMinute = Number.parseInt(zoneText.slice(3, 5), 10);
    tzOffsetMinutes = sign * (zoneHour * 60 + zoneMinute);
  }
  const range = (label: string, value: number, min: number, max: number): string | null =>
    value < min || value > max ? `${label} ${value} is out of range (${min}–${max})` : null;
  const problems = [
    range('year', year, 1, 9999),
    range('month', month, 1, 12),
    range('day', day, 1, 31),
    range('hour', hour, 0, 23),
    range('minute', minute, 0, 59),
    range('second', second, 0, 59),
    range('offset', tzOffsetMinutes, -1439, 1439),
  ].filter((problem): problem is string => problem !== null);
  if (problems.length > 0) {
    return { ok: false, error: problems[0] };
  }
  return { ok: true, date: { year, month, day, hour, minute, second, tzOffsetMinutes } };
}

/**
 * Parses split plans: one part per line, `"1,2,3"` or `"1,2,3:cover"`.
 * Page-list syntax errors fail the whole plan with the line number.
 */
export function parseSplitParts(
  text: string,
): { ok: true; parts: SplitPartDraft[] } | { ok: false; error: string } {
  const parts: SplitPartDraft[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') {
      continue;
    }
    const [pagesSpec, name] = line.split(':');
    const parsed = parsePageList(pagesSpec);
    if (!parsed.ok) {
      return { ok: false, error: `line ${index + 1}: ${parsed.error}` };
    }
    const part: SplitPartDraft =
      name !== undefined && name.trim() !== ''
        ? { pages: parsed.pages, name: name.trim() }
        : { pages: parsed.pages };
    parts.push(part);
  }
  return { ok: true, parts };
}
