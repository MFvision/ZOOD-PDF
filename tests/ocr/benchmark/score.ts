/**
 * OCR accuracy scoring. Character accuracy = 1 − Levenshtein(ocr, truth) / length(truth), after NFC,
 * removal of invisible format characters (bidi marks, ZWJ; ZWNJ becomes a space-less join), tatweel
 * and whitespace collapsing. "Without tashkeel" also drops Arabic diacritics (harakat, shadda, sukun,
 * superscript alef, Quranic marks) from both sides; "with tashkeel" keeps them.
 */

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g;
const TATWEEL = /\u0640/g;
const TASHKEEL = /[\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08FF]/g;

export function normalise(s: string, keepTashkeel: boolean): string {
  let t = s.normalize('NFC').replace(INVISIBLE, '').replace(TATWEEL, '');
  if (!keepTashkeel) t = t.replace(TASHKEEL, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** Levenshtein distance over code points, O(n·m) time and O(m) memory. */
export function levenshtein(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let prev = new Uint32Array(y.length + 1);
  let cur = new Uint32Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    const xi = x[i - 1];
    for (let j = 1; j <= y.length; j++) {
      const cost = xi === y[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[y.length]!;
}

export interface Score {
  /** 0–100, tashkeel removed from both sides. */
  accuracy: number;
  /** 0–100, tashkeel kept. */
  withTashkeel: number;
  truthChars: number;
}

export function score(ocr: string, truth: string): Score {
  const t0 = normalise(truth, false);
  const o0 = normalise(ocr, false);
  const t1 = normalise(truth, true);
  const o1 = normalise(ocr, true);
  const acc = (o: string, t: string) => Math.max(0, 100 * (1 - levenshtein(o, t) / Math.max(1, [...t].length)));
  return { accuracy: acc(o0, t0), withTashkeel: acc(o1, t1), truthChars: [...t0].length };
}
