/**
 * Proof Key for Code Exchange (RFC 7636) and the `state` of a sign-in: what
 * lets a public client — one with no secret — redeem the authorization code
 * it asked for, and only that one.
 */

/** RFC 7636 §4.1: a verifier is 43–128 characters of this set. */
const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/**
 * `length` characters of `UNRESERVED`, each from the system's secure random
 * source. Bytes at or above the largest multiple of 66 are drawn again, so no
 * character is likelier than another.
 */
export function randomToken(length: number): string {
  const limit = 256 - (256 % UNRESERVED.length);
  let out = '';
  while (out.length < length) {
    // getRandomValues gives at most 64 KiB at a time.
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(Math.min(4096, (length - out.length) * 2)))) {
      if (byte < limit && out.length < length) out += UNRESERVED[byte % UNRESERVED.length];
    }
  }
  return out;
}

/** Base64url without padding (RFC 4648 §5), as PKCE and JWTs write it. */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The S256 challenge of a verifier: base64url(SHA-256(ASCII(verifier))). */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** A new verifier (64 characters: 384 bits) and its S256 challenge. */
export async function newPkce(): Promise<Pkce> {
  const verifier = randomToken(64);
  return { verifier, challenge: await challengeOf(verifier) };
}

/** The state of one sign-in: 32 characters, 192 bits, compared when the answer comes back. */
export function newState(): string {
  return randomToken(32);
}
