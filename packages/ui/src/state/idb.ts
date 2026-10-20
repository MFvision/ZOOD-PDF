/**
 * A small key–value store on IndexedDB, one database per use (saved chats,
 * earlier versions of files, recovery copies). In the desktop app IndexedDB
 * is the webview's own store inside the app's data folder; nothing here
 * leaves the device. Where IndexedDB cannot be opened (a private window that
 * refuses it, a test), the store lives in memory for as long as the app is
 * open, and says so through `persistent`.
 */

export interface Entry<T> {
  key: string;
  value: T;
  /** When it was written, in milliseconds since the epoch. */
  at: number;
}

export interface KeyValueStore<T> {
  get(key: string): Promise<T | null>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every entry whose key starts with `prefix`, newest first. */
  list(prefix?: string): Promise<Entry<T>[]>;
  clear(): Promise<void>;
  readonly persistent: boolean;
}

function request<R>(made: IDBRequest<R>): Promise<R> {
  return new Promise((resolve, reject) => {
    made.onsuccess = () => resolve(made.result);
    made.onerror = () => reject(made.error ?? new Error('IndexedDB'));
  });
}

const STORE = 'entries';

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => {
      const store = opening.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('at', 'at');
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('IndexedDB'));
    opening.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

export function memoryStore<T>(): KeyValueStore<T> {
  const map = new Map<string, Entry<T>>();
  return {
    persistent: false,
    get: async (key) => map.get(key)?.value ?? null,
    put: async (key, value) => {
      map.set(key, { key, value, at: Date.now() });
    },
    delete: async (key) => {
      map.delete(key);
    },
    list: async (prefix = '') => [...map.values()].filter((entry) => entry.key.startsWith(prefix)).sort((a, b) => b.at - a.at),
    clear: async () => map.clear(),
  };
}

/** The store named `name`; falls back to memory, once, if IndexedDB fails. */
export function keyValueStore<T>(name: string): KeyValueStore<T> {
  let database: Promise<IDBDatabase> | null = null;
  let fallback: KeyValueStore<T> | null = typeof indexedDB === 'undefined' ? memoryStore<T>() : null;
  const db = () => (database ??= openDatabase(name));
  const run = async <R, F = R>(work: (store: IDBObjectStore) => IDBRequest<R>, mode: IDBTransactionMode, orElse: (store: KeyValueStore<T>) => Promise<F>): Promise<R | F> => {
    if (fallback) return orElse(fallback);
    try {
      const store = (await db()).transaction(STORE, mode).objectStore(STORE);
      return await request(work(store));
    } catch {
      fallback = memoryStore<T>();
      return orElse(fallback);
    }
  };
  return {
    get persistent() {
      return fallback === null;
    },
    get: async (key) => {
      const entry = await run<Entry<T> | undefined>((store) => store.get(key) as IDBRequest<Entry<T> | undefined>, 'readonly', async (mem) => {
        const value = await mem.get(key);
        return value === null ? undefined : { key, value, at: 0 };
      });
      return entry?.value ?? null;
    },
    put: async (key, value) => {
      await run((store) => store.put({ key, value, at: Date.now() } satisfies Entry<T>), 'readwrite', (mem) => mem.put(key, value));
    },
    delete: async (key) => {
      await run((store) => store.delete(key), 'readwrite', (mem) => mem.delete(key));
    },
    list: async (prefix = '') => {
      const all = await run<Entry<T>[]>((store) => store.getAll() as IDBRequest<Entry<T>[]>, 'readonly', (mem) => mem.list(prefix));
      return all.filter((entry) => entry.key.startsWith(prefix)).sort((a, b) => b.at - a.at);
    },
    clear: async () => {
      await run((store) => store.clear(), 'readwrite', (mem) => mem.clear());
    },
  };
}
