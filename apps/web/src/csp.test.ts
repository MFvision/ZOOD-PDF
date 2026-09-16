import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

describe('apps/web index.html', () => {
  it('ships the strict Content-Security-Policy', () => {
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${EXPECTED_CSP}" />`);
  });

  it('has no inline scripts', () => {
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toMatch(/\bsrc=/);
  });

  it('defaults to Arabic and RTL before hydration', () => {
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });
});
