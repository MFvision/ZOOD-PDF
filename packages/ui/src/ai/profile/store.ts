import { invokeHost, isTauriHost } from '../../core/host-tauri';
import { sanitizeProfile } from './profile';
import type { Profile } from './profile';

/**
 * Where the person's details are kept, encrypted at rest:
 *
 * - On the desktop, in the system's credential store — the macOS keychain,
 *   Windows Credential Manager (DPAPI), the Secret Service — through the
 *   host (`src-tauri/src/profile.rs`), like a cloud drive's token. The
 *   webview never keeps a copy.
 * - In a browser, in IndexedDB, encrypted with AES-GCM under a key WebCrypto
 *   made for this origin and will not give out (`extractable: false`): the
 *   database holds the key object and the ciphertext, and nothing that
 *   reads the database file gets the details.
 * - Where neither exists, for the session only.
 *
 * `where()` says which, so the settings can say it too.
 */

export type ProfileHome = 'keychain' | 'browser' | 'memory';

export interface ProfileStore {
  where(): ProfileHome;
  load(): Promise<Profile | null>;
  save(profile: Profile): Promise<void>;
  clear(): Promise<void>;
}

/* ------------------------------------------------------------- desktop */

function keychainStore(): ProfileStore {
  return {
    where: () => 'keychain',
    load: async () => {
      const json = await invokeHost('profile_get');
      if (typeof json !== 'string' || json.length === 0) return null;
      try {
        return sanitizeProfile(JSON.parse(json));
      } catch {
        return null;
      }
    },
    save: async (profile) => {
      await invokeHost('profile_set', { json: JSON.stringify(sanitizeProfile(profile)) });
    },
    clear: async () => {
      await invokeHost('profile_delete');
    },
  };
}

/* ------------------------------------------------------------- browser */

const DB = 'warraq-profile';
const STORE = 'secrets';
const KEY_ROW = 'key';
const PROFILE_ROW = 'profile';

interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('E_STORAGE: IndexedDB'));
  });
}

function row<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('E_STORAGE: IndexedDB'));
  });
}

/** The origin's key, made once and kept in the database as a key object that cannot be exported. */
async function originKey(db: IDBDatabase): Promise<CryptoKey> {
  const kept = await row<CryptoKey | undefined>(db, 'readonly', (store) => store.get(KEY_ROW));
  if (kept) return kept;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await row(db, 'readwrite', (store) => store.put(key, KEY_ROW));
  return key;
}

function browserStore(): ProfileStore {
  return {
    where: () => 'browser',
    load: async () => {
      const db = await openDb();
      try {
        const sealed = await row<Sealed | undefined>(db, 'readonly', (store) => store.get(PROFILE_ROW));
        if (!sealed) return null;
        const key = await originKey(db);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.data);
        return sanitizeProfile(JSON.parse(new TextDecoder().decode(plain)));
      } catch {
        return null;
      } finally {
        db.close();
      }
    },
    save: async (profile) => {
      const db = await openDb();
      try {
        const key = await originKey(db);
        const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(sanitizeProfile(profile))));
        await row(db, 'readwrite', (store) => store.put({ iv, data } satisfies Sealed, PROFILE_ROW));
      } finally {
        db.close();
      }
    },
    clear: async () => {
      const db = await openDb();
      try {
        await row(db, 'readwrite', (store) => store.delete(PROFILE_ROW));
      } finally {
        db.close();
      }
    },
  };
}

/* -------------------------------------------------------------- memory */

function memoryStore(): ProfileStore {
  let kept: Profile | null = null;
  return {
    where: () => 'memory',
    load: async () => kept,
    save: async (profile) => {
      kept = sanitizeProfile(profile);
    },
    clear: async () => {
      kept = null;
    },
  };
}

let store: ProfileStore | null = null;

export function profileStore(): ProfileStore {
  if (store) return store;
  if (isTauriHost()) store = keychainStore();
  else if (typeof indexedDB !== 'undefined' && globalThis.crypto?.subtle) store = browserStore();
  else store = memoryStore();
  return store;
}
