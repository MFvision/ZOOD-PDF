import type { ProviderId } from './providers';

/** One page's text as Warraq's reader gives it, in logical order; `page` is one-based. */
export interface PageText {
  page: number;
  text: string;
}

export type TaskKind = 'summarize' | 'ask' | 'translate' | 'fixOcr' | 'fill' | 'pii' | 'tables';

/**
 * How much document text one request may carry, in characters. Claude reads
 * a whole report (about 150,000 characters); a model on a laptop does well
 * with far less; the on-device model has a window of 4,096 tokens, which
 * Arabic fills at about 1.5 characters a token, so after its rules and its
 * reply about 4,000 characters of the document fit — a question about a
 * longer document goes with the passages that answer it (`device/retrieval.ts`).
 * A translation comes back about as long as it went, and so do an OCR
 * correction and a page's tables, so those are kept small enough for their
 * reply to fit.
 */
export function budgetFor(provider: ProviderId, task: TaskKind): number {
  const echoes = task === 'translate' || task === 'fixOcr' || task === 'tables';
  if (provider === 'claude') return echoes ? 20_000 : 150_000;
  if (provider === 'device') return echoes ? 1_500 : 4_000;
  return echoes ? 6_000 : 16_000;
}

export interface Budgeted {
  /** Whole pages, in order, that fit. */
  sent: PageText[];
  /** The first page that did not fit and every page after it: never cut, never silently dropped. */
  left: number[];
  /** Characters of document text in `sent`. */
  characters: number;
}

/**
 * Reads `pages` in order with `read` while they fit `budget`. A page is sent
 * whole or not at all, and once one does not fit, it and the rest are left
 * out — and listed, so the person is told — without being read at all: a
 * long document is not read to the end only to be cut.
 */
export async function takeWithinBudget(
  pages: readonly number[],
  budget: number,
  read: (page: number) => Promise<string>,
): Promise<Budgeted> {
  const sent: PageText[] = [];
  let characters = 0;
  for (const [index, page] of pages.entries()) {
    const text = await read(page);
    if (characters + text.length > budget) return { sent, left: pages.slice(index), characters };
    sent.push({ page, text });
    characters += text.length;
  }
  return { sent, left: [], characters };
}

/** "1–3, 5, 7–8": ascending page numbers as runs. */
export function formatPages(pages: readonly number[]): string {
  const runs: string[] = [];
  let start: number | undefined;
  let end: number | undefined;
  const flush = () => {
    if (start === undefined || end === undefined) return;
    runs.push(start === end ? String(start) : `${start}–${end}`);
  };
  for (const page of pages) {
    if (end !== undefined && page === end + 1) {
      end = page;
      continue;
    }
    flush();
    start = page;
    end = page;
  }
  flush();
  return runs.join(', ');
}

/** The pages from `from` to `to`, both included, either way round, each end kept inside the document. */
export function pageRange(from: number, to: number, pageCount: number): number[] {
  if (pageCount < 1) return [];
  const inside = (page: number) => Math.min(pageCount, Math.max(1, Math.round(page)));
  const first = inside(Math.min(from, to));
  const last = inside(Math.max(from, to));
  const pages: number[] = [];
  for (let page = first; page <= last; page += 1) pages.push(page);
  return pages;
}
