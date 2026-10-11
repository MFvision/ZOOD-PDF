/**
 * What an analysis leaves behind, kept on this device so a document is read
 * by the model once: the summary of each of its chunks, the summaries those
 * were combined into, and its outline. Each is kept under the SHA-256 of the
 * text it was made from (and the model that made it), never under a file's
 * name or path: the same text is recognised wherever the file is opened
 * from, a page that changes is read again while the rest is reused, and an
 * analysis stopped half-way goes on from what is here.
 *
 * In the browser's IndexedDB — which, in the desktop app, is the webview's
 * own store inside the app's data folder. Nothing here leaves the device.
 * Where IndexedDB cannot be used (a private window that refuses it), it is
 * kept for as long as the app is open.
 */
export interface Kept {
  get(key: string): Promise<string | null>;
  put(key: string, text: string): Promise<void>;
  /** Forgets everything kept. */
  clear(): Promise<void>;
  /** How many summaries are kept. */
  count(): Promise<number>;
}

const DATABASE = 'warraq-ai-analysis';
const STORE = 'summaries';
/** Summaries kept at most; past it the oldest are dropped. */
const LIMIT = 20_000;

/** A store that lives as long as the page: what tests use, and the fallback. */
export function memoryKept(): Kept {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key) ?? null,
    put: async (key, text) => {
      map.set(key, text);
    },
    clear: async () => map.clear(),
    count: async () => map.size,
  };
}

function request<T>(made: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    made.onsuccess = () => resolve(made.result);
    made.onerror = () => reject(made.error ?? new Error('IndexedDB'));
  });
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1);
    opening.onupgradeneeded = () => {
      const store = opening.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('at', 'at');
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('IndexedDB'));
    opening.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

function indexedKept(): Kept {
  let database: Promise<IDBDatabase> | null = null;
  const fallback = memoryKept();
  let broken = false;
  const db = () => (database ??= open());
  const guarded = async <T>(work: (store: IDBDatabase) => Promise<T>, otherwise: () => Promise<T>): Promise<T> => {
    if (broken) return otherwise();
    try {
      return await work(await db());
    } catch {
      broken = true;
      return otherwise();
    }
  };
  return {
    get: (key) =>
      guarded(
        async (store) => {
          const row = await request<{ text?: unknown } | undefined>(store.transaction(STORE).objectStore(STORE).get(key));
          return typeof row?.text === 'string' ? row.text : fallback.get(key);
        },
        () => fallback.get(key),
      ),
    put: (key, text) =>
      guarded(
        async (store) => {
          const summaries = store.transaction(STORE, 'readwrite').objectStore(STORE);
          await request(summaries.put({ key, text, at: Date.now() }));
          const extra = (await request(summaries.count())) - LIMIT;
          if (extra > 0) {
            // The oldest go first, a bounded number at a time.
            const keys = await request(summaries.index('at').getAllKeys(undefined, Math.min(extra, 500)));
            for (const old of keys) summaries.delete(old);
          }
        },
        () => fallback.put(key, text),
      ),
    clear: () =>
      guarded(
        async (store) => {
          await request(store.transaction(STORE, 'readwrite').objectStore(STORE).clear());
          await fallback.clear();
        },
        () => fallback.clear(),
      ),
    count: () =>
      guarded(
        async (store) => (await request(store.transaction(STORE).objectStore(STORE).count())) + (await fallback.count()),
        () => fallback.count(),
      ),
  };
}

let shared: Kept | null = null;

/** The device's store: IndexedDB where there is one. */
export function keptOnDevice(): Kept {
  shared ??= typeof indexedDB === 'undefined' ? memoryKept() : indexedKept();
  return shared;
}

/** SHA-256 of `text`, in hex: the name a summary is kept under. */
export async function textHash(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
