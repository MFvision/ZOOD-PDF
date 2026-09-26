import type { CoreClient } from '../../core/client';
import type { PageText } from '../budget';

/**
 * The passages of a long document that answer a question, for a model whose
 * window holds a few pages at most. The document's pages go into a Library
 * index of their own — the same inverted index and Arabic-aware ranking the
 * Library searches folders with (`library.*`, on this device) — the question
 * is the query, and the lines it ranks highest come back with the lines
 * around them, in page order, as far as the budget allows. The prompt then
 * carries those passages, each inside its page's tag, so the answer can
 * still cite its page.
 */

interface Hit {
  page: number;
  /** Zero-based line on that page. */
  line: number;
  text: string;
}

type Client = Pick<CoreClient, 'callStatic'>;

/** Lines kept on each side of a matched line. */
const AROUND = 2;
/** Matched lines asked for, before the budget cuts them. */
const HITS = 40;
/** What stands between passages of one page that are not next to each other. */
const GAP = '…';

export interface Retrieved {
  /** The passages, one entry per page that has any, in page order. */
  passages: PageText[];
  /** How many characters of document text they hold. */
  characters: number;
  /** Pages with a passage. */
  pages: number[];
}

/** Whether a document is too long for the budget as a whole, so its passages go instead. */
export function needsRetrieval(pages: readonly PageText[], budget: number): boolean {
  return pages.reduce((sum, page) => sum + page.text.length, 0) > budget;
}

/**
 * The passages of `pages` for `query`, within `budget` characters. With no
 * hit at all — a question in words the document never uses — the first
 * lines of the document go, so the model can still say what it is about.
 */
export async function retrievePassages(client: Client, pages: readonly PageText[], query: string, budget: number): Promise<Retrieved> {
  const { result: opened } = await client.callStatic<{ handle: number }>('library.open', {}, []);
  try {
    await client.callStatic('library.add', {
      handle: opened.handle,
      key: 'document',
      name: 'document',
      kind: 'pdf',
      text: pages.map((page) => ({ page: page.page, text: page.text })),
    });
    const { result } = await client.callStatic<{ hits: Hit[] }>('library.search', {
      handle: opened.handle,
      query,
      limit: HITS,
    });
    return assemble(pages, result.hits, budget);
  } finally {
    await client.callStatic('library.close', { handle: opened.handle }).catch(() => undefined);
  }
}

/** The passages around `hits`, in page order, within `budget`. Pure, so it is tested without the core. */
export function assemble(pages: readonly PageText[], hits: readonly Hit[], budget: number): Retrieved {
  const byPage = new Map<number, string[]>(pages.map((page) => [page.page, page.text.split('\n')]));
  // The lines to keep, per page, in the order the ranking gave them — so the
  // budget takes the best first — then read out in page order.
  const chosen = new Map<number, Set<number>>();
  let characters = 0;
  const take = (page: number, line: number) => {
    const lines = byPage.get(page);
    if (!lines || line < 0 || line >= lines.length) return;
    const set = chosen.get(page) ?? new Set<number>();
    for (let at = Math.max(0, line - AROUND); at <= Math.min(lines.length - 1, line + AROUND); at += 1) {
      if (set.has(at)) continue;
      const cost = lines[at]!.length + 1;
      if (characters + cost > budget) return;
      set.add(at);
      characters += cost;
    }
    chosen.set(page, set);
  };
  for (const hit of hits) take(hit.page, hit.line);
  if (chosen.size === 0) {
    // Nothing matched: the beginning of the document, as far as it fits.
    for (const page of pages) {
      const lines = page.text.split('\n');
      for (let at = 0; at < lines.length; at += 1) {
        const cost = lines[at]!.length + 1;
        if (characters + cost > budget) break;
        const set = chosen.get(page.page) ?? new Set<number>();
        set.add(at);
        chosen.set(page.page, set);
        characters += cost;
      }
      if (characters >= budget) break;
    }
  }
  const passages: PageText[] = [];
  for (const page of pages) {
    const set = chosen.get(page.page);
    if (!set || set.size === 0) continue;
    const lines = page.text.split('\n');
    const kept = [...set].sort((a, b) => a - b);
    const parts: string[] = [];
    let previous = -2;
    for (const at of kept) {
      if (at !== previous + 1 && parts.length > 0) parts.push(GAP);
      parts.push(lines[at]!);
      previous = at;
    }
    passages.push({ page: page.page, text: parts.join('\n') });
  }
  return { passages, characters, pages: passages.map((page) => page.page) };
}
