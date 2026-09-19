import { describe, expect, it } from 'vitest';
import { MAX_PIXELS, PRINT_DPI, pageRules, printScale } from './printPages';

describe('printing by pages', () => {
  it('draws a page at 300 dpi, and a poster at no more pixels than a page can take', () => {
    // A4 portrait: 595 × 842 points.
    expect(printScale(595, 842)).toBeCloseTo(PRINT_DPI / 72);
    // An A0 poster at 300 dpi would be 139 million pixels.
    const poster = printScale(2384, 3370);
    expect(poster).toBeLessThan(PRINT_DPI / 72);
    expect(2384 * 3370 * poster * poster).toBeLessThanOrEqual(MAX_PIXELS * 1.0001);
  });

  it('gives each paper size its own page rule, with no margins', () => {
    const a4 = { width: 595.276, height: 841.89 };
    const landscape = { width: 841.89, height: 595.276 };
    const { css, names } = pageRules([a4, landscape, a4]);
    expect(names).toEqual(['warraq-print-0', 'warraq-print-1', 'warraq-print-0']);
    expect(css).toContain('@page { margin: 0; }');
    expect(css).toContain('@page warraq-print-0 { size: 595.28pt 841.89pt; margin: 0; }');
    expect(css).toContain('@page warraq-print-1 { size: 841.89pt 595.28pt; margin: 0; }');
  });
});
