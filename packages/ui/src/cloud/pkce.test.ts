import { describe, expect, it } from 'vitest';
import { base64url, challengeOf, newPkce, newState, randomToken } from './pkce';

describe('PKCE', () => {
  it('makes the S256 challenge RFC 7636 gives for its own example verifier', async () => {
    // RFC 7636, Appendix B.
    expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('draws verifiers of 64 unreserved characters, a new one each time', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const { verifier, challenge } = await newPkce();
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await challengeOf(verifier)).toBe(challenge);
      seen.add(verifier);
    }
    expect(seen.size).toBe(50);
  });

  it('draws states of 32 characters and never the same twice', () => {
    const states = new Set(Array.from({ length: 200 }, () => newState()));
    expect(states.size).toBe(200);
    for (const state of states) expect(state).toMatch(/^[A-Za-z0-9\-._~]{32}$/);
  });

  it('uses every character of the set, none much more often than another', () => {
    const counts = new Map<string, number>();
    for (const ch of randomToken(66_000)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(66);
    // 1 000 expected each; byte % 66 without drawing again would make 58 of them a third likelier.
    for (const count of counts.values()) expect(count).toBeGreaterThan(850);
    for (const count of counts.values()) expect(count).toBeLessThan(1150);
  });

  it('writes base64url without padding', () => {
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(base64url(new Uint8Array([]))).toBe('');
  });
});
