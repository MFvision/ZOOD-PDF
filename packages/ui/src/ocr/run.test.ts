import { describe, expect, it } from 'vitest';
import { renderScale, toPoints } from './run';

describe('reading scanned pages', () => {
  it('draws a page at 300 dpi, and a very large one smaller', () => {
    expect(renderScale([595, 842])).toBeCloseTo(300 / 72);
    const poster = renderScale([2384, 3370]); // A0
    expect(Math.max(2384, 3370) * poster).toBeCloseTo(4200);
  });

  it('turns word boxes from pixels into points', () => {
    const words = toPoints([{ text: 'مرحبا', bbox: [300, 150, 600, 225], confidence: 91 }], 3);
    expect(words).toEqual([{ text: 'مرحبا', bbox: [100, 50, 200, 75] }]);
  });
});
