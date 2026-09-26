import { describe, expect, it } from 'vitest';
import { deltaFromView, fromView, openableScheme, rectFromView, rectToView, toView, type PageGeometry } from './editor';
import { asciiDigits } from '../app/LinkSheets';

describe('page ↔ view coordinates', () => {
  for (const rotation of [0, 90, 180, 270]) {
    it(`round-trips points and boxes at ${rotation}°`, () => {
      const g: PageGeometry = { width: 600, height: 800, rotation };
      const p = { x: 100, y: 50 };
      expect(fromView(g, toView(g, p))).toEqual(p);
      const box = { x0: 10, y0: 20, x1: 110, y1: 70 };
      const v = rectToView(g, box);
      expect(rectFromView(g, v)).toEqual([10, 20, 110, 70]);
      expect(v.width * v.height).toBe(100 * 50);
    });
  }

  it('maps a rotated page like PDFium shows it', () => {
    const g: PageGeometry = { width: 600, height: 800, rotation: 90 };
    // The top-left of the unrotated page appears at the top-right of the view.
    expect(toView(g, { x: 0, y: 0 })).toEqual({ x: 800, y: 0 });
    // Moving right on screen moves down the unrotated page.
    expect(deltaFromView(g, 10, 0)).toEqual({ x: 0, y: -10 });
  });
});

describe('links', () => {
  it('only opens web and mail links', () => {
    const c = { verdict: 'ok' as const, host: 'a', asciiHost: 'a', url: 'x', problems: [] };
    expect(openableScheme({ ...c, scheme: 'https' })).toBe(true);
    expect(openableScheme({ ...c, scheme: 'javascript' })).toBe(false);
  });

  it('reads Arabic-Indic and Persian digits', () => {
    expect(asciiDigits('٣')).toBe('3');
    expect(asciiDigits('۱۲')).toBe('12');
  });
});
