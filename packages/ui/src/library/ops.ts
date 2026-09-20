import type { CoreClient } from '../core/client';
import type { LibraryKind } from './kinds';

/**
 * The Library's operations on the core, as one small adapter.
 *
 * The ops are static (`call_static`), so an index is built and read with no
 * document open. Their names, arguments and answers are the fixed contract in
 * `.tools/briefs/library.md`; everything above this file talks to the index
 * through `LibraryOps`, so the panel's own tests drive a fake and the desktop
 * and the browser drive the same real one.
 *
 * `library.add` is not here: the readers (`ingest.ts`) call it as each file is
 * read, because only they know what a file turned out to be.
 */

export const LIBRARY_KINDS: readonly LibraryKind[] = [
  'pdf',
  'scan',
  'image',
  'word',
  'excel',
  'powerpoint',
  'html',
  'text',
  'markdown',
];

export interface LibraryOpened {
  handle: number;
  documents: number;
  words: number;
}

export interface SearchFilters {
  kinds?: readonly LibraryKind[];
  folders?: readonly string[];
  tags?: readonly string[];
  from?: string;
  to?: string;
  scannedOnly?: boolean;
}

/**
 * One match. `spans` mark the matched words inside `text`, each `[start,
 * length]` counted in **UTF-8 bytes** — the core reads the line as Rust holds
 * it — so `snippet.ts` turns them into places in the string before marking.
 */
export interface SearchHit {
  key: string;
  name: string;
  page: number;
  /** Its line on that page, zero-based. */
  line: number;
  text: string;
  spans: readonly (readonly [number, number])[];
  score: number;
  date?: string;
  kind: LibraryKind;
  tags: readonly string[];
}

export interface SearchResult {
  total: number;
  hits: SearchHit[];
}

export interface IndexedDocument {
  key: string;
  name: string;
  kind: LibraryKind;
  pages: number;
  chars: number;
  date?: string;
  tags: readonly string[];
  /** When it was read into the index, in seconds since the epoch. */
  indexed: number;
  modified: number;
  bytes?: number;
  path?: string;
}

export interface LibraryStats {
  documents: number;
  pages: number;
  words: number;
  bytes: number;
  kinds: Record<string, number>;
  tags: Record<string, number>;
}

/**
 * One tag rule, as the core keeps it with the index: "a document whose text
 * holds any of these words takes this tag". `all` asks for every word instead
 * of any, `scope` is `text`, `name` or `both`, and `kinds` narrows it to some
 * kinds of document.
 */
export interface TagRule {
  tag: string;
  words: string[];
  all?: boolean;
  enabled?: boolean;
  scope?: 'text' | 'name' | 'both';
  kinds?: LibraryKind[];
}

export interface RulesAnswer {
  rules: TagRule[];
  /** How many documents took a tag they did not have; 0 unless `apply` was asked for. */
  tagged: number;
}

/** The index as bytes, ready for the host to keep. */
export interface SavedIndex {
  bytes: number;
  data: ArrayBuffer;
}

export interface LibraryOps {
  /** Opens an index — the bytes the host kept, or nothing for a new one. */
  open(bytes?: ArrayBuffer): Promise<LibraryOpened>;
  forget(handle: number, keys: readonly string[]): Promise<{ documents: number }>;
  search(
    handle: number,
    query: string,
    options?: { limit?: number; offset?: number; filters?: SearchFilters },
  ): Promise<SearchResult>;
  document(handle: number, key: string): Promise<IndexedDocument>;
  tag(
    handle: number,
    key: string,
    change: { add?: readonly string[]; remove?: readonly string[] },
  ): Promise<{ tags: string[] }>;
  stats(handle: number): Promise<LibraryStats>;
  /** Reads the rules back, writes a new set (`set`), and runs them (`apply`). */
  rules(handle: number, options?: { set?: readonly TagRule[]; apply?: boolean }): Promise<RulesAnswer>;
  save(handle: number): Promise<SavedIndex>;
  close(handle: number): Promise<void>;
}

/** The core does not know this operation: this build has no Library engine. */
export function missingLibraryEngine(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /E_UNKNOWN_OP|unknown op|unsupported op/i.test(message);
}

/** The real thing: every op through the core, in the browser's worker or natively on the desktop. */
export function coreLibrary(client: Pick<CoreClient, 'callStatic'>): LibraryOps {
  const call = <T>(op: string, args: object, blobs: ArrayBuffer[] = []) => client.callStatic<T>(op, args, blobs);
  return {
    async open(bytes) {
      const { result } = await call<LibraryOpened>('library.open', {}, bytes ? [bytes] : []);
      return result;
    },
    async forget(handle, keys) {
      const { result } = await call<{ documents: number }>('library.forget', { handle, keys: [...keys] });
      return result;
    },
    async search(handle, query, options) {
      const { result } = await call<SearchResult>('library.search', {
        handle,
        query,
        limit: options?.limit,
        offset: options?.offset,
        filters: options?.filters,
      });
      return result;
    },
    async document(handle, key) {
      const { result } = await call<IndexedDocument>('library.document', { handle, key });
      return result;
    },
    async tag(handle, key, change) {
      const { result } = await call<{ tags: string[] }>('library.tag', {
        handle,
        key,
        add: change.add ? [...change.add] : [],
        remove: change.remove ? [...change.remove] : [],
      });
      return result;
    },
    async stats(handle) {
      const { result } = await call<LibraryStats>('library.stats', { handle });
      return result;
    },
    async rules(handle, options) {
      const { result } = await call<RulesAnswer>('library.rules', {
        handle,
        set: options?.set ? options.set.map((rule) => ({ ...rule, words: [...rule.words] })) : undefined,
        apply: options?.apply ?? false,
      });
      return result;
    },
    async save(handle) {
      const { result, blobs } = await call<{ bytes: number }>('library.save', { handle });
      return { bytes: result.bytes, data: blobs[0] ?? new ArrayBuffer(0) };
    },
    async close(handle) {
      await call('library.close', { handle });
    },
  };
}
