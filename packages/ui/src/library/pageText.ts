import { blockText } from '../create/blocks';
import type { Block, ReadDocument } from '../create/blocks';

/**
 * The text of a page, as the index takes it. `page` is one-based, the number
 * a person is shown and the page a hit opens at.
 */
export interface PageText {
  page: number;
  text: string;
}

/** Bounds on what one file may put in the index, hostile or merely enormous. */
export interface TextLimits {
  /** Pages kept; the rest of the file is left out. */
  pages: number;
  /** Characters kept on one page. */
  charsPerPage: number;
  /** Characters kept of the whole file. */
  chars: number;
}

export const TEXT_LIMITS: TextLimits = { pages: 5000, charsPerPage: 200_000, chars: 4_000_000 };

/** A page's worth of text, trimmed to `limits`; whether anything was left out. */
export function boundPages(pages: readonly PageText[], limits: TextLimits = TEXT_LIMITS): { pages: PageText[]; truncated: boolean } {
  const kept: PageText[] = [];
  let truncated = pages.length > limits.pages;
  let total = 0;
  for (const page of pages.slice(0, limits.pages)) {
    if (total >= limits.chars) {
      truncated = true;
      break;
    }
    let text = page.text;
    if (text.length > limits.charsPerPage) {
      text = text.slice(0, limits.charsPerPage);
      truncated = true;
    }
    if (text.length > limits.chars - total) {
      text = text.slice(0, limits.chars - total);
      truncated = true;
    }
    total += text.length;
    if (text.trim().length > 0) kept.push({ page: page.page, text });
  }
  return { pages: kept, truncated };
}

/** A cell's text and the next one's, parted so two words never run together. */
const CELL_GAP = '\t';

/** Everything a block says, in reading order; a frame's blocks come with it. */
function textOf(block: Block, into: string[]): void {
  switch (block.type) {
    case 'text':
      into.push(blockText(block));
      break;
    case 'table':
      for (const row of block.rows) into.push(row.map((cell) => cell.text).join(CELL_GAP));
      break;
    case 'frame':
      for (const inner of block.blocks) textOf(inner, into);
      break;
    default:
      break;
  }
}

/**
 * A document read by one of Create PDF's readers (`create/`), as the pages
 * the index holds: a page break — and a page of its own size, which is what
 * a slide and a landscape section are — starts a new page, so a hit points
 * at the slide or the sheet it is really on.
 *
 * A Word file's running head and foot are said once, with the first page:
 * they hold the title and the date on many documents, and repeating them on
 * every page would only crowd the index.
 */
export function documentPages(read: ReadDocument, limits: TextLimits = TEXT_LIMITS): { pages: PageText[]; truncated: boolean } {
  const pages: string[][] = [[]];
  const running: string[] = [];
  for (const block of read.header ?? []) textOf(block, running);
  for (const block of read.footer ?? []) textOf(block, running);
  if (read.title) running.unshift(read.title);
  pages[0]!.push(...running.filter((line) => line.trim().length > 0));
  for (const block of read.blocks) {
    // `page` opens one of its own size (a slide, a turned section); `pageBreak` just parts them.
    if (block.type === 'pageBreak' || (block.type === 'page' && pages[pages.length - 1]!.length > 0)) {
      pages.push([]);
      continue;
    }
    textOf(block, pages[pages.length - 1]!);
  }
  const numbered = pages.map((lines, k) => ({ page: k + 1, text: lines.join('\n').replace(/[ \t]+\n/g, '\n').trim() }));
  const bounded = boundPages(numbered, limits);
  return { pages: bounded.pages, truncated: bounded.truncated || read.truncated };
}

/**
 * The words Tesseract read on a page, as one line-broken text. The words
 * already carry the space that follows them (`ocr/engine.ts`), so a line
 * ends where a word carries none.
 */
export function wordsAsText(words: readonly { text: string }[]): string {
  let text = '';
  for (const word of words) {
    text += word.text;
    if (!word.text.endsWith(' ')) text += '\n';
  }
  return text.trim();
}
