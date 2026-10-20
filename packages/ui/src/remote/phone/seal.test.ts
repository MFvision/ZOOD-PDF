import { describe, expect, it } from 'vitest';
import { hex, keyFromText, open, seal, sealWithNonce, sessionKey } from './seal';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const NONCE = Uint8Array.from({ length: 12 }, (_, i) => 100 + i);
const MESSAGE = new TextEncoder().encode('{"t":"next","s":1,"d":"p"}');

describe('the remote lock', () => {
  // The same vector as `seal.rs` (matches_the_shared_vector): the phone and the PC agree byte for byte.
  it('matches the PC byte for byte', () => {
    expect(hex(sealWithNonce(KEY, NONCE, MESSAGE))).toBe(
      '6465666768696a6b6c6d6e6f4f33cfe8a287183783aa3753d0fafaa941eab050bd6ac9dde442d2ed1eaaa54355a30c6438807266f4d3',
    );
    expect(hex(sessionKey(KEY, '00112233445566778899aabbccddeeff'))).toBe('11b2171425486fa3b7259d9096a3bee8f58f3ea3821fe2f52cc4fab0082e3d79');
  });

  it('opens what it sealed, and nothing else', () => {
    const sealed = seal(KEY, MESSAGE);
    expect(open(KEY, sealed)).toEqual(MESSAGE);
    const changed = sealed.slice();
    changed[20] = (changed[20] ?? 0) ^ 1;
    expect(open(KEY, changed)).toBeNull();
    expect(open(new Uint8Array(32), sealed)).toBeNull();
    expect(open(KEY, new Uint8Array(5))).toBeNull();
  });

  it('reads keys from the QR code and from messages', () => {
    expect(keyFromText('_'.repeat(43))).toEqual(new Uint8Array(32).fill(255));
    expect(keyFromText('/'.repeat(43) + '=')).toEqual(new Uint8Array(32).fill(255));
    expect(keyFromText('short')).toBeNull();
  });
});
