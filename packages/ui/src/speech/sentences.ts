import type { TextLineData } from '../core/types';
import type { PageBox } from '../embed/embedControl';

/**
 * Read aloud: a page's text, as Warraq's reader gives its lines in logical
 * order, cut into sentences — each one utterance, so the voice pauses where
 * the writer did, a long page never trips the browser's limit on one
 * utterance, and the sentence being read can be shown on the page: the
 * stretch of each line it covers, by the share of the line's characters it
 * takes. Arabic sentences are read in order because the lines are.
 */

export interface Sentence {
  /** Offsets into the page's text (`pageText`), the end exclusive. */
  start: number;
  end: number;
  text: string;
  /** The language to read it in: Arabic script, Latin, or neither (read in the page's main language). */
  lang: 'ar' | 'en' | 'other';
}

/** A page number on its own: "3", "- 3 -", "Page 3 of 10", «صفحة ٣ من ١٠», "iv". */
const PAGE_NUMBER =
  /^[\s\-–—|•]*(?:(?:page|p\.|pg\.?|صفحة|صفحه|ص)\s*)?(?:[\d٠-٩۰-۹]{1,5}|[ivxlc]{1,7})(?:\s*(?:of|من|\/|-)\s*[\d٠-٩۰-۹]{1,5})?[\s\-–—|•]*$/i;

/** How many lines at the top and at the bottom of a page may be its header or footer. */
const EDGE_LINES = 2;

/** A line as headers and footers repeat it: no digits (the page number changes), no case, no spaces. */
function edgeKey(text: string): string {
  return text.replace(/[\d٠-٩۰-۹]+/g, '#').replace(/\s+/g, '').toLowerCase();
}

/** Which of `lines` sit at the top and bottom of the page, by where they are. */
function edgeIndexes(lines: readonly TextLineData[]): number[] {
  const order = lines.map((_, index) => index).sort((a, b) => lines[a]!.y - lines[b]!.y);
  if (order.length <= EDGE_LINES * 2) return order.length > 1 ? [order[0]!, order.at(-1)!] : [];
  return [...order.slice(0, EDGE_LINES), ...order.slice(-EDGE_LINES)];
}

/**
 * The lines worth reading aloud: a page number standing alone at the top or
 * bottom of the page is left out, and so is a header or footer — a line at
 * the edge that the pages beside it (`neighbours`) repeat at their edges,
 * the way a book's title or a firm's footer runs on every page. Nothing in
 * the body is ever left out; a page that would lose everything keeps it all.
 */
export function readableLines(
  lines: readonly TextLineData[],
  neighbours: readonly (readonly TextLineData[])[] = [],
): TextLineData[] {
  const repeated = new Set(
    neighbours.flatMap((other) => edgeIndexes(other).map((index) => edgeKey(other[index]!.text))),
  );
  const skipped = new Set(
    edgeIndexes(lines).filter((index) => {
      const text = lines[index]!.text;
      if (PAGE_NUMBER.test(text)) return true;
      const key = edgeKey(text);
      return key.length >= 3 && repeated.has(key);
    }),
  );
  const kept = lines.filter((_, index) => !skipped.has(index));
  return kept.length > 0 ? kept : [...lines];
}

/** The page's text: its lines in logical order, one to a line. */
export function pageText(lines: readonly TextLineData[]): string {
  return lines.map((line) => line.text).join('\n');
}

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-ﻼ]/g;
const LATIN = /[A-Za-zÀ-ɏ]/g;

/** Which script carries the text: the one with more letters. */
export function languageOf(text: string): Sentence['lang'] {
  const arabic = text.match(ARABIC)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  if (arabic === 0 && latin === 0) return 'other';
  return arabic >= latin ? 'ar' : 'en';
}

/** Where a sentence ends: a full stop, question or exclamation mark (Arabic ones too), then space or the end; or a blank line. */
const END = /[.!?؟۔។]+["»”’)]*(?=\s|$)|\n\s*\n/g;

/** Longest a sentence may be: a page of run-on text is still read in pieces the voice can take. */
const MAX_SENTENCE = 400;

export function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  const push = (start: number, end: number) => {
    // Whitespace at either end is not read, and not shown.
    let from = start;
    let to = end;
    while (from < to && /\s/.test(text[from]!)) from += 1;
    while (to > from && /\s/.test(text[to - 1]!)) to -= 1;
    if (to <= from) return;
    // A very long piece is cut at a space, so every piece stays readable.
    while (to - from > MAX_SENTENCE) {
      let cut = text.lastIndexOf(' ', from + MAX_SENTENCE);
      if (cut <= from) cut = from + MAX_SENTENCE;
      const piece = text.slice(from, cut);
      sentences.push({ start: from, end: cut, text: piece, lang: languageOf(piece) });
      from = cut;
      while (from < to && /\s/.test(text[from]!)) from += 1;
    }
    const piece = text.slice(from, to);
    sentences.push({ start: from, end: to, text: piece, lang: languageOf(piece) });
  };
  let at = 0;
  for (const match of text.matchAll(END)) {
    const end = match.index + match[0].length;
    push(at, end);
    at = end;
  }
  push(at, text.length);
  return sentences;
}

/** A line's place in the page's text, so a sentence's offsets can be laid over the lines. */
interface Placed {
  line: TextLineData;
  start: number;
  end: number;
}

function place(lines: readonly TextLineData[]): Placed[] {
  const placed: Placed[] = [];
  let at = 0;
  for (const line of lines) {
    placed.push({ line, start: at, end: at + line.text.length });
    at += line.text.length + 1;
  }
  return placed;
}

/**
 * The boxes of a sentence on its page, in page points from the top-left
 * corner: for each line it touches, the stretch of the line it covers,
 * measured by characters — from the line's start in its own direction, so
 * an Arabic line is covered from its right.
 */
export function sentenceBoxes(lines: readonly TextLineData[], sentence: Pick<Sentence, 'start' | 'end'>): PageBox[] {
  const boxes: PageBox[] = [];
  for (const { line, start, end } of place(lines)) {
    const from = Math.max(start, sentence.start);
    const to = Math.min(end, sentence.end);
    if (to <= from || line.text.length === 0) continue;
    const a = (from - start) / line.text.length;
    const b = (to - start) / line.text.length;
    const x0 = line.direction === 'rtl' ? line.x + line.width * (1 - b) : line.x + line.width * a;
    const x1 = line.direction === 'rtl' ? line.x + line.width * (1 - a) : line.x + line.width * b;
    boxes.push({ x: x0, y: line.y, width: Math.max(1, x1 - x0), height: line.height });
  }
  return boxes;
}
