import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PREMIUM_LOOK_IDS } from '../state/preferences';
import { PREMIUM_THEMES } from './premiumThemes';
import type { ThemeSide } from './premiumThemes';

const css = readFileSync(fileURLToPath(new URL('./looks/premium.css', import.meta.url)), 'utf8');

/** WCAG 2 relative luminance and contrast ratio. */
function luminance(colour: string): number {
  const hex = colour.length === 4 ? `#${[...colour.slice(1)].map((c) => c + c).join('')}` : colour;
  const channel = (at: number) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The declarations of one rule, by its exact selector. */
function rule(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return new Map(
    body
      .split(';')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]),
  );
}

describe('premium themes', () => {
  it('lists every theme once, in the order Settings shows them', () => {
    expect(PREMIUM_THEMES.map((theme) => theme.id)).toEqual([...PREMIUM_LOOK_IDS]);
  });

  for (const theme of PREMIUM_THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      const side: ThemeSide = theme[mode];

      it(`${theme.id} (${mode}) reads at 4.5:1 or better`, () => {
        expect(contrast(side.text, side.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(side.text, side.card)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(side.muted, side.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(side.muted, side.card)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(side.ink, side.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(side.ink, side.card)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(side.onAccent, side.accent)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(side.onHi, side.hi)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${theme.id} (${mode}) has the same colours in premium.css`, () => {
        const selectors =
          mode === 'light'
            ? [`:root:root[data-look="${theme.id}"]`]
            : [`:root:root[data-look="${theme.id}"]:not([data-theme="light"])`, `:root:root[data-look="${theme.id}"][data-theme="dark"]`];
        for (const selector of selectors) {
          const tokens = rule(selector);
          expect(tokens.get('--accent')).toBe(side.accent);
          expect(tokens.get('--accent-contrast')).toBe(side.onAccent);
          expect(tokens.get('--window-background')).toBe(side.bg);
          expect(tokens.get('--content-background')).toBe(side.card);
          expect(tokens.get('--label')).toBe(side.text);
          expect(tokens.get('--secondary-label')).toBe(side.muted);
          expect(tokens.get('--look-link')).toBe(side.ink);
        }
      });
    }
  }
});
