/**
 * The user's trusted certificates (roots or intermediates) for signature verification.
 * Empty by default: signatures then verify as "valid, signer identity unknown" (ADR 0008).
 * Web/extension: IndexedDB. Desktop: DER files in the app data directory (host `signing.trust`).
 * Certificates are parsed and fingerprinted by the engine (`sign.certInfo`); stores keep DER.
 */
import type { EngineClient } from './engine';
import type { SignerInfo } from './signatures';

export interface TrustStore {
  /** DER of every trusted certificate. */
  list(): Promise<{ sha256: string; der: Uint8Array }[]>;
  add(sha256: string, der: Uint8Array): Promise<void>;
  remove(sha256: string): Promise<void>;
}

export interface CertInfo extends SignerInfo {
  isCa: boolean;
  selfIssued: boolean;
  sha256: string;
}

export interface TrustedCert {
  info: CertInfo;
  der: Uint8Array;
}

const DB = 'zood-pdf-trust';
const STORE = 'certs';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** IndexedDB store (web, PWA, extension). */
export function idbTrustStore(idb: IDBFactory = indexedDB): TrustStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(DB, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'sha256' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => {
        db = null;
        reject(r.error);
      };
    }));
  const store = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    async list() {
      const all = await req((await store('readonly')).getAll() as IDBRequest<{ sha256: string; der: Uint8Array }[]>);
      return all.map((x) => ({ sha256: x.sha256, der: new Uint8Array(x.der) })).sort((a, b) => a.sha256.localeCompare(b.sha256));
    },
    async add(sha256, der) {
      await req((await store('readwrite')).put({ sha256: sha256.toUpperCase(), der: der.slice() }));
    },
    async remove(sha256) {
      await req((await store('readwrite')).delete(sha256.toUpperCase()));
    },
  };
}

/** Certificates in a PEM/DER file, parsed by the engine (DER of each in the same order). */
export async function readCertificates(engine: EngineClient, file: Uint8Array): Promise<TrustedCert[]> {
  const r = await engine.callStatic<{ certificates: CertInfo[] }>('sign.certInfo', {}, [file.slice()]);
  return r.json.certificates.map((info, i) => ({ info, der: r.blobs[i] ?? new Uint8Array() }));
}

/** Adds every certificate of `file` to the store; returns what was added. */
export async function importTrusted(engine: EngineClient, store: TrustStore, file: Uint8Array): Promise<TrustedCert[]> {
  const certs = await readCertificates(engine, file);
  for (const c of certs) await store.add(c.info.sha256, c.der);
  return certs;
}

/** The trusted certificates with their summaries (unreadable entries are skipped). */
export async function loadTrusted(engine: EngineClient, store: TrustStore): Promise<TrustedCert[]> {
  const out: TrustedCert[] = [];
  for (const e of await store.list()) {
    try {
      const [c] = await readCertificates(engine, e.der);
      if (c) out.push(c);
    } catch {
      /* a damaged entry is ignored; the user can remove it */
    }
  }
  return out;
}
