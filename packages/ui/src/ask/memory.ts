import type { CoreClient } from '../core/client';
import { coreLibrary } from '../library/ops';
import type { SearchHit } from '../library/ops';
import { libraryStore } from '../library/store';
import type { DocumentLine } from './draft';

/**
 * Ask ZOOD's memory of the person's work is their Library: the PDFs and
 * Office files of the folders they chose, read into an index on this
 * computer (Library tool). For a draft, the index is opened once, asked for
 * each word worth looking up, and closed; nothing is written to it.
 */

/** Lines taken for each word, and in all. */
const PER_WORD = 3;
const MOST = 6;

/** The best lines for `words`, one document's same line only once. */
export async function recall(
  client: Pick<CoreClient, 'callStatic'>,
  words: readonly string[],
): Promise<DocumentLine[]> {
  if (words.length === 0) return [];
  const bytes = await libraryStore().readIndex();
  if (!bytes || bytes.byteLength === 0) return [];
  const library = coreLibrary(client);
  const { handle } = await library.open(bytes);
  try {
    const found: SearchHit[] = [];
    for (const word of words) {
      const { hits } = await library.search(handle, word, { limit: PER_WORD });
      found.push(...hits);
    }
    return bestLines(found);
  } finally {
    await library.close(handle).catch(() => undefined);
  }
}

/** Hits as lines for the prompt: best first, each place once, at most `MOST`. */
export function bestLines(hits: readonly SearchHit[], most: number = MOST): DocumentLine[] {
  const seen = new Set<string>();
  return [...hits]
    .sort((a, b) => b.score - a.score)
    .filter((hit) => {
      const place = `${hit.key}#${hit.page}#${hit.line}`;
      if (seen.has(place)) return false;
      seen.add(place);
      return hit.text.trim().length > 0;
    })
    .slice(0, most)
    .map((hit) => ({ name: hit.name, page: hit.page, text: hit.text.slice(0, 240) }));
}
