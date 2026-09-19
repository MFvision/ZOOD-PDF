import { describe, expect, it } from 'vitest';
import { apply, between, bounds, corners, crop, dragRect, fitAspect, invert, quarterTurn, resize, compose, translate, uprightIn } from './matrix';
import type { Matrix } from './matrix';

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k]!, 3));

// A picture 100×50 points, its top-left 72 in and 100 down.
const PICTURE = uprightIn({ x: 72, y: 100, width: 100, height: 50 });

describe('where a picture lands', () => {
  it('upright in a box: its unit square covers the box, bottom row at the bottom', () => {
    close(PICTURE, [100, 0, 0, -50, 72, 150]);
    expect(apply(PICTURE, 0, 0)).toEqual({ x: 72, y: 150 });
    expect(bounds(corners(PICTURE))).toEqual({ x: 72, y: 100, width: 100, height: 50 });
  });

  it('inverts and composes like PDF', () => {
    const back = compose(PICTURE, invert(PICTURE)!);
    close(back, [1, 0, 0, 1, 0, 0]);
    close(translate(PICTURE, 5, -5), [100, 0, 0, -50, 77, 145]);
  });

  it('fits a picture inside a dragged box, keeping its proportions', () => {
    expect(fitAspect({ x: 0, y: 0, width: 200, height: 200 }, 2)).toEqual({ x: 0, y: 50, width: 200, height: 100 });
    expect(between({ x: 10, y: 50 }, { x: 0, y: 20 })).toEqual({ x: 0, y: 20, width: 10, height: 30 });
  });
});

describe('what a drag does', () => {
  it('a corner handle resizes from the opposite corner; Shift keeps the proportions', () => {
    // The bottom-right corner on screen is unit (1, 0).
    const wider = resize(PICTURE, [0, 0, 1, 1], [1, 0], { x: 272, y: 175 }, false);
    expect(bounds(corners(wider))).toEqual({ x: 72, y: 100, width: 200, height: 75 });
    const kept = resize(PICTURE, [0, 0, 1, 1], [1, 0], { x: 272, y: 160 }, true);
    const box = bounds(corners(kept));
    expect(box.width / box.height).toBeCloseTo(2, 3);
    expect(box.x).toBeCloseTo(72, 3);
    expect(box.y).toBeCloseTo(100, 3);
  });

  it('an edge handle moves one side only', () => {
    const taller = resize(PICTURE, [0, 0, 1, 1], [0.5, 1], { x: 0, y: 50 }, false);
    const box = bounds(corners(taller));
    expect(box.y).toBeCloseTo(50, 3);
    expect(box.height).toBeCloseTo(100, 3);
    expect(box.width).toBeCloseTo(100, 3);
  });

  it('a quarter turn clockwise stays centred and swaps the sides', () => {
    const turned = quarterTurn(PICTURE);
    const box = bounds(corners(turned));
    close([box.x, box.y, box.width, box.height], [97, 75, 50, 100]);
    // The picture's top-left corner (unit 0, 1) goes to the top-right.
    const topLeft = apply(turned, 0, 1);
    close([topLeft.x, topLeft.y], [147, 75]);
    // Four turns come back to where it started.
    let m: Matrix = PICTURE;
    for (let k = 0; k < 4; k += 1) m = quarterTurn(m);
    close(m, PICTURE);
  });

  it('a crop handle moves that side of what shows, never past the other', () => {
    expect(crop(PICTURE, [0, 0, 1, 1], [0, 0.5], { x: 122, y: 0 })).toEqual([0.5, 0, 1, 1]);
    const [u0, , u1] = crop(PICTURE, [0.5, 0, 1, 1], [1, 0.5], { x: 0, y: 0 });
    expect(u1).toBeGreaterThan(u0);
  });

  it('a link box moves, and grows from any side', () => {
    const rect = { x: 10, y: 10, width: 50, height: 20 };
    expect(dragRect(rect, null, 5, 5)).toEqual({ x: 15, y: 15, width: 50, height: 20 });
    expect(dragRect(rect, [0, 0], -5, -5)).toEqual({ x: 5, y: 5, width: 55, height: 25 });
    expect(dragRect(rect, [1, 1], -100, -100)).toEqual({ x: 10, y: 10, width: 4, height: 4 });
  });
});
