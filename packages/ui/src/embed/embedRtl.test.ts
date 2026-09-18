import { describe, expect, it } from 'vitest';
import { EMBED_RTL_CSS } from './embedRtl';

describe("the stylesheet that mirrors EmbedPDF's interface", () => {
  it('keeps the page area left to right, and fields in their own direction', () => {
    expect(EMBED_RTL_CSS).toContain('.bg-bg-app { direction: ltr; }');
    expect(EMBED_RTL_CSS).toContain('unicode-bidi: plaintext');
  });

  it('swaps each side margin only in right-to-left', () => {
    expect(EMBED_RTL_CSS).toContain('.mr-2:dir(rtl) { margin-right: 0; margin-left: calc(var(--spacing) * 2); }');
    expect(EMBED_RTL_CSS).toContain('.ml-1:dir(rtl) { margin-left: 0; margin-right: calc(var(--spacing) * 1); }');
    expect(EMBED_RTL_CSS).toContain('.mr-1\\.5:dir(rtl)');
  });
});
