import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256, sha256Stream } from './sha256';

const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

async function reference(bytes: Uint8Array): Promise<string> {
  return hex(await webcrypto.subtle.digest('SHA-256', bytes));
}

describe('Sha256', () => {
  it('matches the known digests', () => {
    expect(new Sha256().hex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256().update(new TextEncoder().encode('abc')).hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('agrees with WebCrypto whatever the chunking', async () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + 3) & 0xff;
    const expected = await reference(bytes);
    for (const chunk of [1, 3, 63, 64, 65, 200, 1000]) {
      const hasher = new Sha256();
      for (let at = 0; at < bytes.length; at += chunk) hasher.update(bytes.subarray(at, at + chunk));
      expect(hasher.hex(), `chunks of ${chunk}`).toBe(expected);
    }
  });

  it('hashes a stream', async () => {
    const bytes = new TextEncoder().encode('محرر PDF reads on this device');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 10));
        controller.enqueue(bytes.subarray(10));
        controller.close();
      },
    });
    expect(await sha256Stream(stream)).toBe(await reference(bytes));
  });
});
