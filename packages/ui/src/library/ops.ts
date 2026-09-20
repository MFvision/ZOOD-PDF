import type { CoreClient } from '../core/client';

/**
 * The Library's operations on the core, as one small adapter.
 *
 * The ops themselves are static (`call_static`): an index is built and read
 * without a document open. Their names, arguments and answers are the fixed
 * contract in `.tools/briefs/library.md`; everything above this file talks to
 * the index through `LibraryOps`, so the panel's own tests drive a fake and
 * the desktop and the browser drive the same real one.
 */

/** What kind of document the index holds. A PDF whose pages have no text is a `scan`. */
export type LibraryKind =
  | 'pdf'
  | 'scan'
  | 'image'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'html'
  | 'text'
  | 'markdown';

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

/** One page's text, when a reader outside the core produced it (OCR, Word, a web page). */
export interface PageText {
  page: number;
  text: string;
}

export interface LibraryOpened {
  handle: number;
  documents: number;
  words: number;
}

export interface AddRequest {
  key: string;
  name: string;
  kind: LibraryKind;
  /** The file's own modified time, in milliseconds since the epoch. */
  modified: number;
  pages?: number;
  password?: string;
  /** Page text read outside the core; without it the core reads the bytes itself. */
  text?: readonly PageText[];
}

export interface AddResult {
  added: boolean;
  /** Why the file was not indexed. The run carries on. */
  skipped?: string;
  pages: number;
  chars: number;
  /** The date the document itself carries, when one was found — not the file's date. */
  date?: string;
  guessedKind: LibraryKind;
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
 * length]` counted in Unicode scalar values (what Rust's `char_indices` and
 * JavaScript's `Array.from(text)` agree on), so Arabic marks in the right
 * place. `markSpans` clamps anything outside the line rather than throwing.
 */
export interface SearchHit {
  key: string;
  name: string;
  page: number;
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
  /** When it was read into the index, in milliseconds since the epoch. */
  indexed: number;
  modified: number;
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

/** The index as bytes, ready for the host to keep. */
export interface SavedIndex {
  bytes: number;
  data: ArrayBuffer;
}

export interface LibraryOps {
  /** Opens an index — the bytes the host kept, or nothing for a new one. */
  open(bytes?: ArrayBuffer): Promise<LibraryOpened>;
  /** Reads one file into the index; `bytes` are omitted when `request.text` is given. */
  add(handle: number, request: AddRequest, bytes?: ArrayBuffer): Promise<AddResult>;
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
  save(handle: number): Promise<SavedIndex>;
  close(handle: number): Promise<void>;
}

/** The core does not know this operation: this build has no Library engine. */
export function missingLibraryEngine(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /E_UNKNOWN_OP|unknown op|unsupported op/i.test(message);
}

/** The real thing: every op through the core, in the browser's worker or natively on the desktop. */
export function coreLibrary(client: CoreClient): LibraryOps {
  const call = async <T>(op: string, args: object, blobs: ArrayBuffer[] = []) =>
    client.callStatic<T>(op, args, blobs);
  return {
    async open(bytes) {
      const { result } = await call<LibraryOpened>('library.open', {}, bytes ? [bytes] : []);
      return result;
    },
    async add(handle, request, bytes) {
      const { result } = await call<AddResult>('library.add', { handle, ...request }, bytes ? [bytes] : []);
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
        add: change.add ? [...change.add] : undefined,
        remove: change.remove ? [...change.remove] : undefined,
      });
      return result;
    },
    async stats(handle) {
      const { result } = await call<LibraryStats>('library.stats', { handle });
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
