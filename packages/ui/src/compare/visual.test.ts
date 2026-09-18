import { describe, expect, it } from 'vitest';
import { visualChanges } from './visual';
import type { Raster } from './visual';

/** A white page, `width` by `height`, with `paint` applied to it. */
function page(
  width: number,
  height: number,
  paint: (set: (x: number, y: number, grey: number) => void) => void = () => undefined,
): Raster {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  paint((x, y, grey) => {
    const at = (y * width + x) * 4;
    rgba[at] = rgba[at + 1] = rgba[at + 2] = grey;
  });
  return { width, height, rgba };
}

const block =
  (x0: number, y0: number, x1: number, y1: number) =>
  (set: (x: number, y: number, g: number) => void) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) set(x, y, 0);
  };

describe('where a page looks different', () => {
  it('finds nothing on the same page', () => {
    const text = block(20, 20, 180, 30);
    expect(visualChanges(page(200, 300, text), page(200, 300, text))).toEqual([]);
  });

  it('ignores anti-aliasing: small shifts in grey are not changes', () => {
    const faint = (set: (x: number, y: number, g: number) => void) => {
      for (let y = 0; y < 300; y += 3) for (let x = 0; x < 200; x += 2) set(x, y, 225);
    };
    expect(visualChanges(page(200, 300), page(200, 300, faint))).toEqual([]);
  });

  it('boxes a drawing added to the page, where it is', () => {
    const [box, ...rest] = visualChanges(page(200, 300), page(200, 300, block(100, 200, 140, 240)));
    expect(rest).toEqual([]);
    // It covers the drawing (to within rounding), and not much more.
    const e = 1e-9;
    expect(box!.x).toBeLessThanOrEqual(0.5 + e);
    expect(box!.x + box!.w).toBeGreaterThanOrEqual(0.7 - e);
    expect(box!.y).toBeLessThanOrEqual(200 / 300 + e);
    expect(box!.y + box!.h).toBeGreaterThanOrEqual(240 / 300 - e);
    expect(box!.w).toBeLessThan(0.4);
  });

  it('keeps two changes far apart as two boxes, and one line of text as one', () => {
    const two = visualChanges(
      page(200, 300),
      page(200, 300, (set) => {
        block(10, 10, 30, 20)(set);
        block(150, 260, 190, 280)(set);
      }),
    );
    expect(two).toHaveLength(2);
    const letters = (set: (x: number, y: number, g: number) => void) => {
      for (let x = 20; x < 180; x += 12) block(x, 100, x + 6, 110)(set);
    };
    expect(visualChanges(page(200, 300), page(200, 300, letters))).toHaveLength(1);
  });

  it('compares renders of different sizes at the same place of the page', () => {
    const small = page(100, 150, block(50, 100, 70, 120));
    const large = page(200, 300, block(100, 200, 140, 240));
    expect(visualChanges(small, large)).toEqual([]);
  });

  it('calls a page of another shape changed as a whole', () => {
    expect(visualChanges(page(200, 300), page(300, 200))).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
  });
});
