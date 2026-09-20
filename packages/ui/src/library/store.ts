import { deleteLibraryIndex, hasLibraryHost, loadLibraryIndex, saveLibraryIndex } from '../core/host-tauri';
import type { LibraryKind } from './kinds';

/**
 * Where the Library's index lives on this device.
 *
 * The index holds text taken from the person's own documents, so it is kept
 * where their data is and nowhere else: in the desktop app the host writes it
 * into the app's own data directory, and in a browser it goes to IndexedDB.
 * Nothing is ever sent anywhere, and "Delete the index" removes the file, or
 * the database itself, rather than emptying it — with the ledger of what was
 * already read (`ledger.ts`), so nothing is left behind.
 *
 * Beside the index the store keeps only what the panel needs to go on: the
 * folders that were added — with the browser's directory handle, when it has
 * one, so the same folder can be read again after a reload — and, for each
 * indexed file, its name and the folder it came from. No text, and nothing
 * the person did not already have.
 */

const DATABASE = 'warraq-library';
const VERSION = 2;
const INDEX_STORE = 'index';
const META_STORE = 'meta';
const THUMB_STORE = 'thumbs';
const INDEX_KEY = 'bytes';
const META_KEY = 'meta';
/** The one index the app keeps, by name, in the desktop host's data directory. */
export const INDEX_NAME = 'library';

/** A file in the index: enough to list a folder and to name a hit's file. */
export interface FileRecord {
  key: string;
  name: string;
  /** The id (browser) or path (desktop) of the folder it was added under. */
  folder: string;
  kind: LibraryKind;
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

export interface LibraryMeta {
  folders: FolderRecord[];
  files: Record<string, FileRecord>;
}

export const emptyMeta = (): LibraryMeta => ({ folders: [], files: {} });

/** A small picture of a document's first page, made by the readers. */
export interface Thumbnail {
  image: ArrayBuffer;
  mime: string;
}

export interface LibraryStore {
  readIndex(): Promise<ArrayBuffer | null>;
  writeIndex(bytes: ArrayBuffer): Promise<void>;
  readMeta(): Promise<LibraryMeta>;
  writeMeta(meta: LibraryMeta): Promise<void>;
  readThumb(key: string): Promise<Thumbnail | null>;
  writeThumbs(thumbs: ReadonlyMap<string, Thumbnail>): Promise<void>;
  forgetThumbs(keys: readonly string[]): Promise<void>;
  /** Really deletes: the index, the folders, the file records and the pictures. */
  forgetEverything(): Promise<void>;
}

/** Makes a well-formed meta out of whatever came back, however old or broken. */
export function tidyMeta(value: unknown): LibraryMeta {
  const meta = (value ?? {}) as Partial<LibraryMeta>;
  const folders = Array.isArray(meta.folders) ? meta.folders.filter((one) => typeof one?.id === 'string') : [];
  const files: Record<string, FileRecord> = {};
  for (const [key, record] of Object.entries(meta.files ?? {})) {
    if (record && typeof record === 'object' && typeof (record as FileRecord).name === 'string') files[key] = record as FileRecord;
  }
  return { folders, files };
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
      if (!db.objectStoreNames.contains(THUMB_STORE)) db.createObjectStore(THUMB_STORE);
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

async function remove(store: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDatabase();
  try {
    const tx = db.transaction(store, 'readwrite');
    const shelf = tx.objectStore(store);
    for (const key of keys) shelf.delete(key);
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

function deleteDatabase(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const gone = indexedDB.deleteDatabase(DATABASE);
    gone.onsuccess = () => resolve();
    gone.onerror = () => reject(gone.error ?? new Error('IndexedDB failed'));
    // Another window of the app holds the database; the page closes it after
    // every write, so this only happens while one is open elsewhere.
    gone.onblocked = () => resolve();
  });
}

export function browserStore(): LibraryStore {
  return {
    async readIndex() {
      return (await get<ArrayBuffer>(INDEX_STORE, INDEX_KEY)) ?? null;
    },
    writeIndex: (bytes) => put(INDEX_STORE, INDEX_KEY, bytes),
    async readMeta() {
      return tidyMeta(await get<LibraryMeta>(META_STORE, META_KEY));
    },
    writeMeta: (meta) => put(META_STORE, META_KEY, meta),
    async readThumb(key) {
      return (await get<Thumbnail>(THUMB_STORE, key)) ?? null;
    },
    async writeThumbs(thumbs) {
      for (const [key, thumbnail] of thumbs) await put(THUMB_STORE, key, thumbnail);
    },
    forgetThumbs: (keys) => remove(THUMB_STORE, keys),
    forgetEverything: deleteDatabase,
  };
}

/**
 * The desktop: the index itself is the host's file in the app's data
 * directory. The folders and the file records stay in the webview's own
 * database, which lives in that same directory.
 */
export function desktopStore(): LibraryStore {
  const browser = storeAvailable() ? browserStore() : memoryStore();
  return {
    readIndex: () => loadLibraryIndex(INDEX_NAME),
    writeIndex: async (bytes) => {
      await saveLibraryIndex(INDEX_NAME, new Uint8Array(bytes));
    },
    readMeta: browser.readMeta,
    writeMeta: browser.writeMeta,
    readThumb: browser.readThumb,
    writeThumbs: browser.writeThumbs,
    forgetThumbs: browser.forgetThumbs,
    async forgetEverything() {
      await deleteLibraryIndex(INDEX_NAME).catch(() => false);
      await browser.forgetEverything();
    },
  };
}

/** The same store in memory: for the panel's tests, and where a browser has no database. */
export function memoryStore(): LibraryStore {
  let index: ArrayBuffer | null = null;
  let meta = emptyMeta();
  const thumbs = new Map<string, Thumbnail>();
  return {
    readIndex: () => Promise.resolve(index),
    writeIndex: (bytes) => {
      index = bytes;
      return Promise.resolve();
    },
    readMeta: () => Promise.resolve(copyMeta(meta)),
    writeMeta: (next) => {
      meta = copyMeta(next);
      return Promise.resolve();
    },
    readThumb: (key) => Promise.resolve(thumbs.get(key) ?? null),
    writeThumbs: (fresh) => {
      for (const [key, thumbnail] of fresh) thumbs.set(key, thumbnail);
      return Promise.resolve();
    },
    forgetThumbs: (keys) => {
      for (const key of keys) thumbs.delete(key);
      return Promise.resolve();
    },
    forgetEverything: () => {
      index = null;
      meta = emptyMeta();
      thumbs.clear();
      return Promise.resolve();
    },
  };
}

/** A copy that a caller's later edits cannot reach; folder handles are kept as they are. */
function copyMeta(meta: LibraryMeta): LibraryMeta {
  return {
    folders: meta.folders.map((folder) => ({ ...folder })),
    files: Object.fromEntries(Object.entries(meta.files).map(([key, file]) => [key, { ...file }])),
  };
}

export function libraryStore(): LibraryStore {
  if (hasLibraryHost()) return desktopStore();
  return storeAvailable() ? browserStore() : memoryStore();
}
