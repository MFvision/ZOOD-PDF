/**
 * EmbedPDF 2.15 lays its interface out for left-to-right only. In Arabic it
 * mirrors part of itself — its shadow root inherits the page's direction, so
 * the toolbar and menus read right to left — but it centres the document
 * with a computed left margin, which right to left pushes every page against
 * the right edge (measured: 256 px off centre at 1400 px), and it spaces its
 * controls with fixed left/right margins, so checkboxes touch their labels.
 *
 * This stylesheet, added to its shadow root, keeps the page area left to
 * right — pages are not text, so centring works — while form fields typed on
 * a page still follow the text's own direction, and mirrors the side margins
 * of its controls. It names EmbedPDF 2.15.1's own classes, which is why the
 * version is pinned; `e2e/embed-arabic.spec.ts` checks the centring.
 */

/** EmbedPDF's side margins, as its Tailwind build defines them (2.15.1). */
const MARGINS: ReadonlyArray<[cls: string, side: 'left' | 'right', steps: string]> = [
  ['ml-1', 'left', '1'],
  ['ml-2', 'left', '2'],
  ['-mr-1', 'right', '-1'],
  ['mr-1\\.5', 'right', '1.5'],
  ['mr-2', 'right', '2'],
  ['mr-3', 'right', '3'],
  ['mr-4', 'right', '4'],
];

export const EMBED_RTL_CSS = [
  // The scroller that holds the pages.
  '.bg-bg-app { direction: ltr; }',
  '.bg-bg-app :is(input, textarea):dir(rtl) { direction: rtl; unicode-bidi: plaintext; }',
  ...MARGINS.map(([cls, side, steps]) => {
    const other = side === 'left' ? 'right' : 'left';
    return `.${cls}:dir(rtl) { margin-${side}: 0; margin-${other}: calc(var(--spacing) * ${steps}); }`;
  }),
].join('\n');

/** Adds the stylesheet to EmbedPDF's shadow root, once. */
export function installRtlStyles(root: ShadowRoot | null | undefined): void {
  if (!root || root.querySelector('style[data-warraq-rtl]')) return;
  const style = document.createElement('style');
  style.dataset.warraqRtl = '';
  style.textContent = EMBED_RTL_CSS;
  root.append(style);
}
