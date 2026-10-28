import { describe, expect, it } from 'vitest';
import { fitMoved, fitWidthZoom } from './zoom';

describe('fitting the page to the view', () => {
  it('ignores the flicker a scrollbar makes, so the page gets drawn', () => {
    // A4 landscape at a width where the scrollbar's 17 px flips 83% to 82%.
    const page = { width: 842, height: 595 };
    const without = fitWidthZoom({ width: 980, height: 700 }, page);
    const withBar = fitWidthZoom({ width: 963, height: 700 }, page);
    expect(fitMoved(without, withBar)).toBe(true);
    expect(fitMoved(0.83, 0.8325)).toBe(false);
  });

  it('applies the first fit and any real change of size', () => {
    expect(fitMoved(null, 0.83)).toBe(true);
    expect(fitMoved(0.83, 1.2)).toBe(true);
  });
});
