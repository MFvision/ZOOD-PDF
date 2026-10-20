import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * The phone's half of the remote's lock (the PC's is
 * `apps/desktop/src-tauri/src/remote/seal.rs`; the vectors in `seal.test.ts`
 * are the same as its). ChaCha20-Poly1305 in plain JavaScript: a page on the
 * local network is not a "secure context", so the browser's own WebCrypto is
 * not there to use. `crypto.getRandomValues` is, and makes every nonce.
 */

const SESSION_LABEL = new TextEncoder().encode('zood-remote/1 session');

export function sealWithNonce(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array {
  const sealed = chacha20poly1305(key, nonce).encrypt(plain);
  const out = new Uint8Array(12 + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, 12);
  return out;
}

/** `plain` sealed with `key`: a random nonce, the ciphertext and its tag. */
export function seal(key: Uint8Array, plain: Uint8Array): Uint8Array {
  return sealWithNonce(key, randomBytes(12), plain);
}

/** What `seal` sealed, or `null` for anything else. */
export function open(key: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < 12 + 16 + 2) return null;
  try {
    return chacha20poly1305(key, sealed.subarray(0, 12)).decrypt(sealed.subarray(12));
  } catch {
    return null;
  }
}

/** The key of one connection: the key the phone holds, and that connection's challenge. */
export function sessionKey(key: Uint8Array, challenge: string): Uint8Array {
  const challengeBytes = new TextEncoder().encode(challenge);
  const input = new Uint8Array(SESSION_LABEL.length + key.length + challengeBytes.length);
  input.set(SESSION_LABEL, 0);
  input.set(key, SESSION_LABEL.length);
  input.set(challengeBytes, SESSION_LABEL.length + key.length);
  return sha256(input);
}

function fromBase64Any(text: string): Uint8Array | null {
  try {
    const normal = text.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A 32-byte key from base64 or base64url, or `null`. */
export function keyFromText(text: string): Uint8Array | null {
  const key = fromBase64Any(text);
  return key && key.length === 32 ? key : null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
