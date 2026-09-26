import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { idbTrustStore, importTrusted, loadTrusted } from './trust';
import type { EngineClient, Reply } from './engine';

/** Engine stand-in for `sign.certInfo`: every byte ≥ 0x30 of the file is one "certificate". */
function fakeEngine(calls: string[] = []): EngineClient {
  return {
    open: async () => ({ json: {}, blobs: [] }),
    call: async () => ({ json: {}, blobs: [] }) as unknown as Reply<never>,
    close: async () => {},
    terminate: () => {},
    callStatic: async <J,>(method: string, _p?: unknown, blobs: Uint8Array[] = []) => {
      calls.push(method);
      const file = blobs[0] ?? new Uint8Array();
      const certs = [...file].map((b) => ({
        name: `Cert ${b}`,
        subject: `CN=Cert ${b}`,
        issuer: 'CN=Root',
        serial: '01',
        keyAlgorithm: 'RSA-2048',
        notBefore: '2020-01-01T00:00:00Z',
        notAfter: '2050-01-01T00:00:00Z',
        isCa: true,
        selfIssued: b === 0x31,
        sha256: b.toString(16).padStart(64, 'a'),
      }));
      return { json: { certificates: certs } as J, blobs: [...file].map((b) => new Uint8Array([b])) };
    },
  };
}

describe('trust list', () => {
  it('is empty by default and keeps imported certificates (DER) across store instances', async () => {
    const idb = new IDBFactory();
    const store = idbTrustStore(idb);
    expect(await store.list()).toEqual([]);
    const added = await importTrusted(fakeEngine(), store, new Uint8Array([0x30, 0x31]));
    expect(added.map((c) => c.info.name)).toEqual(['Cert 48', 'Cert 49']);
    const again = idbTrustStore(idb);
    const listed = await again.list();
    expect(listed).toHaveLength(2);
    expect(listed.map((x) => [...x.der])).toEqual([[0x31], [0x30]].sort((a, b) => b[0]! - a[0]!).reverse());
    const loaded = await loadTrusted(fakeEngine(), again);
    expect(loaded.map((c) => c.info.selfIssued).sort()).toEqual([false, true]);
  });

  it('re-importing is idempotent and removal is by fingerprint (any case)', async () => {
    const store = idbTrustStore(new IDBFactory());
    await importTrusted(fakeEngine(), store, new Uint8Array([0x30]));
    await importTrusted(fakeEngine(), store, new Uint8Array([0x30]));
    const [one] = await store.list();
    expect(await store.list()).toHaveLength(1);
    await store.remove(one!.sha256.toLowerCase());
    expect(await store.list()).toEqual([]);
  });

  it('skips entries the engine cannot read', async () => {
    const store = idbTrustStore(new IDBFactory());
    await store.add('B'.repeat(64), new Uint8Array([0x30]));
    const broken: EngineClient = { ...fakeEngine(), callStatic: async () => Promise.reject(new Error('malformed')) };
    expect(await loadTrusted(broken, store)).toEqual([]);
  });
});
