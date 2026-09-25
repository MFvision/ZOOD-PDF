import { describe, expect, it } from 'vitest';
import { hasMetaCsp, stripMetaCsp } from './vite-plugin-desktop';

describe('desktop build strips the <meta> CSP', () => {
  it('removes it in any attribute order and case', () => {
    const html = `<!doctype html><html lang="ar" dir="rtl"><head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'">
    <META CONTENT="default-src 'none'" HTTP-EQUIV='content-security-policy'>
    <meta name="viewport" content="width=device-width">
    <title>زود PDF</title></head><body></body></html>`;
    expect(hasMetaCsp(html)).toBe(true);
    const out = stripMetaCsp(html);
    expect(hasMetaCsp(out)).toBe(false);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('name="viewport"');
    expect(out).toContain('<title>زود PDF</title>');
  });

  it('leaves other meta tags and report-only lookalikes of other headers alone', () => {
    const html = '<meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="description" content="Content-Security-Policy">';
    expect(stripMetaCsp(html)).toBe(html);
    expect(hasMetaCsp(html)).toBe(false);
  });
});
