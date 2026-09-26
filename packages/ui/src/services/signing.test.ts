import { describe, expect, it } from 'vitest';
import { signPdf, signedVersion, type SigningNetwork } from './signing';
import type { EngineClient, Reply } from './engine';

const b = (...x: number[]) => new Uint8Array(x);

/** Records engine calls and answers like warraq-core's sign.* methods. */
function fakeEngine(log: { method: string; params: unknown; blobs: number }[]): EngineClient {
  const reply = (json: unknown, ...blobs: Uint8Array[]): Reply<never> => ({ json: json as never, blobs });
  return {
    open: async () => ({ json: {}, blobs: [] }),
    close: async () => {},
    terminate: () => {},
    callStatic: async () => reply({}),
    call: async <J,>(_id: string, method: string, params: unknown = {}, blobs: Uint8Array[] = []) => {
      log.push({ method, params, blobs: blobs.length });
      switch (method) {
        case 'sign.prepare': {
          const p = params as { level: string };
          return reply({ field: 'Signature1', signer: 'أحمد', next: p.level === 'B-B' ? 'done' : 'timestamp', tsaRequestBlob: 1 }, b(1), b(0xaa)) as Reply<J>;
        }
        case 'sign.finish':
          return reply({ completed: 'x' }, b(2)) as Reply<J>;
        case 'sign.revocationRequests':
          return reply(
            {
              requests: [
                { subject: 'Signer', ocspUrls: ['http://ocsp.test/'], crlUrls: ['http://crl.test/int.crl'], ocspRequestBlob: 0 },
                { subject: 'Intermediate', ocspUrls: [], crlUrls: ['http://crl.test/root.crl'], ocspRequestBlob: null },
                { subject: 'Root', ocspUrls: [], crlUrls: [], ocspRequestBlob: null },
              ],
              certificateBlobs: [1, 2],
            },
            b(0x0c),
            b(0xc1),
            b(0xc2),
          ) as Reply<J>;
        case 'sign.addDss': {
          const p = params as { docTimestamp: boolean };
          return reply({ next: p.docTimestamp ? 'timestamp' : 'done', tsaRequestBlob: 1 }, b(3), b(0xbb)) as Reply<J>;
        }
        default:
          throw new Error(method);
      }
    },
  };
}

function fakeNetwork(calls: string[], failOcsp = false): SigningNetwork {
  return {
    timestamp: async (url, req) => (calls.push(`tsa ${url} ${req[0]}`), b(0x70)),
    ocsp: async (url) => {
      calls.push(`ocsp ${url}`);
      if (failOcsp) throw new Error('offline');
      return b(0x0e);
    },
    fetchCrl: async (url) => (calls.push(`crl ${url}`), b(0xc0)),
  };
}

describe('signing flow', () => {
  it('B-B needs no network and sends the picture as the second blob', async () => {
    const log: { method: string; params: unknown; blobs: number }[] = [];
    const r = await signPdf(fakeEngine(log), b(0), {
      p12: b(9),
      password: 'x',
      page: 0,
      rect: [1, 2, 3, 4],
      lines: ['أحمد'],
      image: { width: 1, height: 1, rgba: b(0, 0, 0, 255) },
      level: 'B-B',
    });
    expect(r.bytes).toEqual(b(1));
    expect(log.map((l) => l.method)).toEqual(['sign.prepare']);
    expect(log[0]!.blobs).toBe(2);
    expect(log[0]!.params).toMatchObject({ appearance: { lines: ['أحمد'], image: { width: 1, height: 1 } }, rect: [1, 2, 3, 4] });
  });

  it('refuses timestamp levels without the desktop network', async () => {
    await expect(signPdf(fakeEngine([]), b(0), { p12: b(9), password: 'x', page: 0, level: 'B-T' })).rejects.toThrow(/desktop/);
  });

  it('B-LTA: timestamp, OCSP (CRL as fallback), DSS, document timestamp — only the chosen TSA and the certificate URLs', async () => {
    const log: { method: string; params: unknown; blobs: number }[] = [];
    const calls: string[] = [];
    const steps: string[] = [];
    const r = await signPdf(
      fakeEngine(log),
      b(0),
      { p12: b(9), password: 'x', page: 0, level: 'B-LTA' },
      { network: fakeNetwork(calls, true), tsaUrl: 'http://tsa.test', onStep: (s) => steps.push(s) },
    );
    expect(r.bytes).toEqual(b(2));
    expect(calls).toEqual([
      'tsa http://tsa.test 170',
      'ocsp http://ocsp.test/',
      'crl http://crl.test/int.crl',
      'crl http://crl.test/root.crl',
      'tsa http://tsa.test 187',
    ]);
    const dss = log.find((l) => l.method === 'sign.addDss')!;
    expect(dss.params).toEqual({ kinds: ['crl', 'crl', 'cert', 'cert'], docTimestamp: true });
    expect(steps).toEqual(['signing', 'timestamp', 'revocation', 'archive']);
    expect(r.revocationFailures).toEqual([]);
  });

  it('B-T stops after the signature timestamp', async () => {
    const log: { method: string; params: unknown; blobs: number }[] = [];
    const calls: string[] = [];
    await signPdf(fakeEngine(log), b(0), { p12: b(9), password: 'x', page: 0, level: 'B-T' }, { network: fakeNetwork(calls), tsaUrl: 'https://t' });
    expect(log.map((l) => l.method)).toEqual(['sign.prepare', 'sign.finish']);
    expect(calls).toEqual(['tsa https://t 170']);
  });

  it('the signed version is the prefix the byte range covers', () => {
    const bytes = new Uint8Array(100).map((_, i) => i);
    expect(signedVersion(bytes, { byteRange: [0, 10, 20, 30] })).toEqual(bytes.slice(0, 50));
    expect(signedVersion(bytes, { byteRange: [0, 10, 90, 30] })).toBeNull();
    expect(signedVersion(bytes, { byteRange: [5, 10, 20, 30] })).toBeNull();
  });
});
