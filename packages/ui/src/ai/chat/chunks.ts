import type { PageText } from '../budget';

/**
 * A document cut into pieces a model can read one at a time. Whole pages are
 * packed together while they fit; a page longer than the budget on its own —
 * the case the old one-shot form could do nothing with — is cut between its
 * lines (and a line longer than the budget between its words), every part
 * keeping its page's number, so nothing of the document is ever left out
 * and a citation still names the right page.
 */
export interface Chunk {
  /** Where it stands among the document's chunks, from zero. */
  index: number;
  /** First and last page it holds text of, one-based. */
  from: number;
  to: number;
  /** Its text, page by page; a long page's parts appear in consecutive chunks. */
  pages: PageText[];
  characters: number;
}

/** Cuts `text` into parts of at most `budget` characters: between lines, else between words, else anywhere. */
export function splitText(text: string, budget: number): string[] {
  const size = Math.max(1, Math.floor(budget));
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let current = '';
  const push = (piece: string, joiner: string) => {
    if (piece.length > size) {
      // Too long for a part of its own: its words, and a word too long, its characters.
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      if (joiner === '\n') {
        for (const word of piece.split(' ')) push(word, ' ');
        if (current.length > 0) {
          parts.push(current);
          current = '';
        }
      } else {
        for (let at = 0; at < piece.length; at += size) parts.push(piece.slice(at, at + size));
      }
      return;
    }
    if (current.length === 0) current = piece;
    else if (current.length + joiner.length + piece.length <= size) current += joiner + piece;
    else {
      parts.push(current);
      current = piece;
    }
  };
  for (const line of text.split('\n')) push(line, '\n');
  if (current.length > 0) parts.push(current);
  return parts;
}

/** The document's pages with any text, as chunks of at most `budget` characters each. */
export function chunkPages(pages: readonly PageText[], budget: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current: PageText[] = [];
  let characters = 0;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ index: chunks.length, from: current[0]!.page, to: current.at(-1)!.page, pages: current, characters });
    current = [];
    characters = 0;
  };
  for (const page of pages) {
    if (page.text.trim().length === 0) continue;
    for (const part of splitText(page.text, budget)) {
      if (characters + part.length > budget) flush();
      current.push({ page: page.page, text: part });
      characters += part.length;
    }
  }
  flush();
  return chunks;
}

/**
 * A chunk as two, each about half of it: what is done when the model's own
 * count of a chunk turns out over its window (text dense in digits or marks
 * takes more tokens than its length suggests). Null when it cannot be cut
 * further.
 */
export function halve(chunk: Chunk): [Chunk, Chunk] | null {
  if (chunk.characters < 2) return null;
  const halves = chunkPages(chunk.pages, Math.ceil(chunk.characters / 2));
  if (halves.length < 2) return null;
  const merge = (list: Chunk[]): Chunk => ({
    index: chunk.index,
    from: list[0]!.from,
    to: list.at(-1)!.to,
    pages: list.flatMap((part) => part.pages),
    characters: list.reduce((sum, part) => sum + part.characters, 0),
  });
  return [merge(halves.slice(0, 1)), merge(halves.slice(1))];
}
