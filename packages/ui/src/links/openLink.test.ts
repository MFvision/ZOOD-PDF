import { describe, expect, it } from 'vitest';
import { displayUrl, isOpenableUrl, urlHost } from './openLink';

describe('the link question', () => {
  it('offers web and e-mail addresses only', () => {
    expect(isOpenableUrl('https://example.org/دليل')).toBe(true);
    expect(isOpenableUrl('  mailto:nadia@example.sa ')).toBe(true);
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false);
    expect(isOpenableUrl('file:///etc/passwd')).toBe(false);
  });

  it('refuses an address that bidi controls or other invisible characters would disguise', () => {
    for (const url of [
      'https://www.bank.com\u{202E}@oi.live/',
      'https://\u{2067}evil.example\u{2069}/',
      'https://a.example/\u{200F}x',
      'https://a.example/\u{61C}x',
      'https://a.example/\u{FEFF}',
      'https://a.example/\u{200B}',
      'https://a.example/\u{2028}',
      'https://a.example/\u{85}',
      'https://a.example/\n',
    ]) {
      expect(isOpenableUrl(url), JSON.stringify(url)).toBe(false);
    }
  });

  it('measures an address as the core does: bytes of the trimmed address', () => {
    // 2100 Arabic letters are 4200 bytes: past the bound, though 2100 code units.
    expect(isOpenableUrl(`https://example.org/${'د'.repeat(2100)}`)).toBe(false);
    expect(isOpenableUrl(`  https://example.org/${'a'.repeat(4000)}  `)).toBe(true);
  });

  it('shows an Arabic address in letters, and whatever would hide itself encoded', () => {
    expect(displayUrl('https://example.org/%D8%AF%D9%84%D9%8A%D9%84')).toBe('https://example.org/دليل');
    // Reserved characters stay escaped: the address shown is the one that opens.
    expect(displayUrl('https://example.org/a%2Fb%3Fc')).toBe('https://example.org/a%2Fb%3Fc');
    expect(displayUrl('https://www.bank.com%E2%80%AE@oi.live/')).toBe('https://www.bank.com%E2%80%AE@oi.live/');
    expect(displayUrl('https://www.bank.com\u{202E}@oi.live/')).toBe('https://www.bank.com%E2%80%AE@oi.live/');
    expect(displayUrl('https://example.org/%E0%A4%A')).toBe('https://example.org/%E0%A4%A');
  });

  it('names the host that really opens, in a form no bidi can reorder', () => {
    expect(urlHost('https://www.bank.com%E2%80%AE@oi.live/')).toBe('oi.live');
    expect(urlHost('https://مثال.example/')).toBe('xn--mgbh0fb.example');
    expect(urlHost('mailto:nadia@example.sa')).toBeNull();
    expect(urlHost('not a url')).toBeNull();
  });
});
