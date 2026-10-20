import type { CoreClient } from '../../core/client';
import { coreLibrary } from '../../library/ops';
import { libraryStore } from '../../library/store';
import type { LibraryLine } from './across';

/** Matched lines asked of the index for one question: the material's budget cuts them further. */
const LINES = 60;

/**
 * The Library as the AI reads it: the index kept on this device, opened for
 * one question and closed after, searched with the same Arabic-aware ranking
 * the Library tool uses. Nothing is written to it.
 */
export async function searchLibrary(client: Pick<CoreClient, 'callStatic'>, query: string): Promise<LibraryLine[]> {
  if (query.trim().length === 0) return [];
  const bytes = await libraryStore().readIndex();
  if (!bytes || bytes.byteLength === 0) return [];
  const library = coreLibrary(client);
  const { handle } = await library.open(bytes);
  try {
    const { hits } = await library.search(handle, query.trim(), { limit: LINES });
    return hits.map((hit) => ({ key: hit.key, name: hit.name, page: hit.page, text: hit.text }));
  } finally {
    await library.close(handle).catch(() => undefined);
  }
}

/** Whether this device has a Library with any document in it. */
export async function hasLibrary(): Promise<boolean> {
  const meta = await libraryStore().readMeta().catch(() => null);
  return meta !== null && Object.keys(meta.files).length > 0;
}
