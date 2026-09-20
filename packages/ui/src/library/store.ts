import type { LibraryKind } from './ops';

/**
 * Where the Library's index lives on this device.
 *
 * The index holds text taken from the person's own documents, so it is kept
 * where their data is and nowhere else: in the browser it is IndexedDB, which
 * inside the desktop app is the app's own data directory. Nothing is ever
 * sent anywhere, and "Delete the index" deletes the database itself rather
 * than emptying it, so nothing is left behind.
 *
 * Beside the index the store keeps only what the panel needs to go on: the
 * folders that were added (with the browser's directory handle, when it has
 * one, so the same folder can be read again after a reload), one small record
 * per file so an unchanged file is not read twice, and the person's tag rules.
 */

const DATABASE = 'warraq-library';
const VERSION = 1;
const INDEX_STORE = 'index';
const META_STORE = 'meta';
const INDEX_KEY = 'bytes';
const META_KEY = 'meta';

/** A file already in the index: enough to tell whether it must be read again. */
export interface FileRecord {
  key: string;
  name: string;
  folder: string;
  kind: LibraryKind;
  size?: number;
  modified: number;
  indexed: number;
}

/** Where files came from. A browser folder keeps its handle so it can be read again. */
export interface FolderRecord {
  id: string;
  label: string;
  /** `directory` is a browser folder handle, `path` a desktop folder, `files` files chosen one by one. */
  source: 'directory' | 'path' | 'files';
  path?: string;
  handle?: FileSystemDirectoryHandle;
}

/** "If the text holds {word}, tag it {tag}." The person's own, kept on this device. */
export interface TagRule {
  id: string;
  word: string;
  tag: string;
}

export interface LibraryMeta {
  folders: FolderRecord[];
  files: Record<string, FileRecord>;
  rules: TagRule[];
}

export const emptyMeta = (): LibraryMeta => ({ folders: [], files: {}, rules: [] });

export interface LibraryStore {
  readIndex(): Promise<ArrayBuffer | null>;
  writeIndex(bytes: ArrayBuffer): Promise<void>;
  readMeta(): Promise<LibraryMeta>;
  writeMeta(meta: LibraryMeta): Promise<void>;
  /** Really deletes: the index, the file records, the folders and the rules. */
  forgetEverything(): Promise<void>;
}

/** Makes a well-formed meta out of whatever came back, however old or broken. */
export function tidyMeta(value: unknown): LibraryMeta {
  const meta = (value ?? {}) as Partial<LibraryMeta>;
  const folders = Array.isArray(meta.folders) ? meta.folders.filter((f) => typeof f?.id === 'string') : [];
  const rules = Array.isArray(meta.rules)
    ? meta.rules.filter((r) => typeof r?.id === 'string' && typeof r.word === 'string' && typeof r.tag === 'string')
    : [];
  const files: Record<string, FileRecord> = {};
  for (const [key, record] of Object.entries(meta.files ?? {})) {
    if (record && typeof record === 'object' && typeof (record as FileRecord).modified === 'number') files[key] = record as FileRecord;
  }
  return { folders, files, rules };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(INDEX_STORE)) db.createObjectStore(INDEX_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB failed'));
    open.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

async function put(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(store, 'readwrite');
    await request(tx.objectStore(store).put(value, key));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB failed'));
    });
  } finally {
    db.close();
  }
}

async function get<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDatabase();
  try {
    return await request<T | undefined>(db.transaction(store, 'readonly').objectStore(store).get(key) as IDBRequest<T | undefined>);
  } finally {
    db.close();
  }
}

/** Whether this browser gives the page a database at all (a private window may not). */
export function storeAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function browserStore(): LibraryStore {
  return {
    async readIndex() {
      const bytes = await get<ArrayBuffer>(INDEX_STORE, INDEX_KEY);
      return bytes ?? null;
    },
    writeIndex: (bytes) => put(INDEX_STORE, INDEX_KEY, bytes),
    async readMeta() {
      return tidyMeta(await get<LibraryMeta>(META_STORE, META_KEY));
    },
    writeMeta: (meta) => put(META_STORE, META_KEY, meta),
    forgetEverything() {
      return new Promise<void>((resolve, reject) => {
        const gone = indexedDB.deleteDatabase(DATABASE);
        gone.onsuccess = () => resolve();
        gone.onerror = () => reject(gone.error ?? new Error('IndexedDB failed'));
        // A tab left open elsewhere holds the database; it is closed after
        // every write, so this only happens while another window has it.
        gone.onblocked = () => resolve();
      });
    },
  };
}

/** The same store in memory: for the panel's tests, and where a browser has no database. */
export function memoryStore(): LibraryStore {
  let index: ArrayBuffer | null = null;
  let meta = emptyMeta();
  return {
    readIndex: () => Promise.resolve(index),
    writeIndex: (bytes) => {
      index = bytes;
      return Promise.resolve();
    },
    readMeta: () => Promise.resolve(structuredCloneMeta(meta)),
    writeMeta: (next) => {
      meta = structuredCloneMeta(next);
      return Promise.resolve();
    },
    forgetEverything: () => {
      index = null;
      meta = emptyMeta();
      return Promise.resolve();
    },
  };
}

/** A copy that a caller's later edits cannot reach; folder handles are kept as they are. */
function structuredCloneMeta(meta: LibraryMeta): LibraryMeta {
  return {
    folders: meta.folders.map((folder) => ({ ...folder })),
    files: Object.fromEntries(Object.entries(meta.files).map(([key, file]) => [key, { ...file }])),
    rules: meta.rules.map((rule) => ({ ...rule })),
  };
}

export function libraryStore(): LibraryStore {
  return storeAvailable() ? browserStore() : memoryStore();
}
