/**
 * Recent files in IndexedDB: name, date, first-page thumbnail PNG (rendered by PDFium in the viewer),
 * optional bytes under a size cap, star and tags. `forgetThumbnail` drops the picture and the stored
 * bytes; it is called after redaction or protection so no earlier content lingers on the device.
 */

export interface RecentItem {
  id: string;
  name: string;
  size: number;
  openedAt: number;
  starred: boolean;
  tags: string[];
  hasBytes: boolean;
  /** PNG bytes of the first page. */
  thumbnail?: Uint8Array;
}

export interface RecentsStore {
  list(): Promise<RecentItem[]>;
  add(file: { name: string; bytes: Uint8Array }): Promise<RecentItem>;
  getBytes(id: string): Promise<Uint8Array | undefined>;
  setThumbnail(id: string, png: Uint8Array): Promise<void>;
  forgetThumbnail(id: string): Promise<void>;
  update(id: string, patch: Partial<Pick<RecentItem, 'starred' | 'tags' | 'name'>>): Promise<void>;
  /** Replace the stored bytes (after a save) — respects the size cap. */
  putBytes(id: string, bytes: Uint8Array): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface RecentsOptions {
  idb?: IDBFactory;
  /** Largest file whose bytes are kept for one-click reopen. */
  maxBytes?: number;
  /** How many entries are kept. */
  maxItems?: number;
  now?: () => number;
}

const DB_NAME = 'zood-pdf';
const DB_VERSION = 1;
const META = 'recents';
const BYTES = 'recent-bytes';
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function contentId(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createRecentsStore(opts: RecentsOptions = {}): RecentsStore {
  const idb = opts.idb ?? globalThis.indexedDB;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxItems = opts.maxItems ?? 60;
  const now = opts.now ?? Date.now;
  let dbp: Promise<IDBDatabase> | null = null;

  function db(): Promise<IDBDatabase> {
    if (!dbp) {
      const open = idb.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(BYTES)) d.createObjectStore(BYTES);
      };
      dbp = req(open);
    }
    return dbp;
  }

  async function getMeta(id: string): Promise<RecentItem | undefined> {
    const d = await db();
    return req(d.transaction(META).objectStore(META).get(id) as IDBRequest<RecentItem | undefined>);
  }

  async function putMeta(item: RecentItem): Promise<void> {
    const d = await db();
    const tx = d.transaction(META, 'readwrite');
    tx.objectStore(META).put(item);
    await done(tx);
  }

  async function list(): Promise<RecentItem[]> {
    const d = await db();
    const all = await req(d.transaction(META).objectStore(META).getAll() as IDBRequest<RecentItem[]>);
    return all.sort((a, b) => b.openedAt - a.openedAt);
  }

  async function remove(id: string): Promise<void> {
    const d = await db();
    const tx = d.transaction([META, BYTES], 'readwrite');
    tx.objectStore(META).delete(id);
    tx.objectStore(BYTES).delete(id);
    await done(tx);
  }

  async function putBytes(id: string, bytes: Uint8Array): Promise<void> {
    const item = await getMeta(id);
    if (!item) return;
    const d = await db();
    const tx = d.transaction([META, BYTES], 'readwrite');
    const keep = bytes.byteLength <= maxBytes;
    if (keep) tx.objectStore(BYTES).put(bytes.slice(), id);
    else tx.objectStore(BYTES).delete(id);
    tx.objectStore(META).put({ ...item, size: bytes.byteLength, hasBytes: keep });
    await done(tx);
  }

  return {
    list,
    remove,
    putBytes,
    async add({ name, bytes }) {
      const id = await contentId(bytes);
      const existing = await getMeta(id);
      const item: RecentItem = existing
        ? { ...existing, name, openedAt: now() }
        : { id, name, size: bytes.byteLength, openedAt: now(), starred: false, tags: [], hasBytes: false };
      const keep = bytes.byteLength <= maxBytes;
      item.hasBytes = keep;
      const d = await db();
      const tx = d.transaction([META, BYTES], 'readwrite');
      tx.objectStore(META).put(item);
      if (keep) tx.objectStore(BYTES).put(bytes.slice(), id);
      await done(tx);
      const all = await list();
      for (const old of all.slice(maxItems)) if (!old.starred) await remove(old.id);
      return item;
    },
    async getBytes(id) {
      const d = await db();
      const v = await req(d.transaction(BYTES).objectStore(BYTES).get(id) as IDBRequest<Uint8Array | undefined>);
      return v ? new Uint8Array(v) : undefined;
    },
    async setThumbnail(id, png) {
      const item = await getMeta(id);
      if (item) await putMeta({ ...item, thumbnail: png.slice() });
    },
    async forgetThumbnail(id) {
      const item = await getMeta(id);
      if (!item) return;
      const rest: RecentItem = { ...item, hasBytes: false };
      delete rest.thumbnail;
      const d = await db();
      const tx = d.transaction([META, BYTES], 'readwrite');
      tx.objectStore(META).put(rest);
      tx.objectStore(BYTES).delete(id);
      await done(tx);
    },
    async update(id, patch) {
      const item = await getMeta(id);
      if (item) await putMeta({ ...item, ...patch });
    },
  };
}

const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

/** Arabic-aware search normalisation (same rules as the engine's search): drop tashkeel and tatweel,
 * unify alef / yaa / taa-marbuta forms, Arabic-Indic and Persian digits → ASCII, lower-case. */
export function normalizeForSearch(s: string): string {
  return s
    .replace(TASHKEEL, '')
    .replace(TATWEEL, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .toLowerCase();
}

export function searchRecents(items: readonly RecentItem[], query: string): RecentItem[] {
  const terms = normalizeForSearch(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return items.filter((item) => {
    const hay = normalizeForSearch([item.name, ...item.tags].join(' '));
    return terms.every((t) => hay.includes(t));
  });
}
