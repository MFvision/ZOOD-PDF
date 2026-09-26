/**
 * Page ranges typed by people: "1-3, 5", «١-٣، ٥», "4-" (to the end), "-2" (from the start).
 * Arabic-Indic (٠-٩) and Extended Arabic-Indic/Persian (۰-۹) digits, the Arabic comma «،»,
 * semicolons and en/em dashes are accepted. Output is 0-based inclusive `[first, last]` pairs.
 */

export type RangeResult =
  | { ok: true; ranges: [number, number][] }
  | { ok: false; reason: 'empty' | 'syntax' | 'reversed' | 'outOfRange' | 'tooMany'; token?: string };

/** Most ranges accepted in one expression (a split makes at most this many files). */
export const MAX_RANGES = 1000;

export function normalizeDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x0660 && c <= 0x0669) out += String(c - 0x0660);
    else if (c >= 0x06f0 && c <= 0x06f9) out += String(c - 0x06f0);
    else if (ch === '،' || ch === '؛' || ch === ';') out += ',';
    else if (ch === '–' || ch === '—' || ch === '−') out += '-';
    else out += ch;
  }
  return out;
}

export function parseRanges(input: string, pageCount: number): RangeResult {
  const text = normalizeDigits(input).trim();
  if (!text) return { ok: false, reason: 'empty' };
  const tokens = text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: false, reason: 'empty' };
  if (tokens.length > MAX_RANGES) return { ok: false, reason: 'tooMany' };
  const ranges: [number, number][] = [];
  for (const token of tokens) {
    const m = /^(\d*)\s*(-?)\s*(\d*)$/.exec(token);
    if (!m || (!m[1] && !m[3])) return { ok: false, reason: 'syntax', token };
    const dash = m[2] === '-';
    if (!dash && m[3]) return { ok: false, reason: 'syntax', token };
    const a = m[1] ? Number(m[1]) : 1;
    const b = dash ? (m[3] ? Number(m[3]) : pageCount) : a;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < 1 || a > pageCount || b > pageCount) {
      return { ok: false, reason: 'outOfRange', token };
    }
    if (a > b) return { ok: false, reason: 'reversed', token };
    ranges.push([a - 1, b - 1]);
  }
  return { ok: true, ranges };
}

/** 0-based page indices → "1-3,5,7-8" (1-based, Latin digits: used in file names). */
export function formatRanges(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const a = sorted[i]! + 1;
    const b = sorted[j]! + 1;
    parts.push(a === b ? String(a) : `${a}-${b}`);
    i = j + 1;
  }
  return parts.join(',');
}
