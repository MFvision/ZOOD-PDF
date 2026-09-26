import { describe, expect, it } from 'vitest';
import { cropBoxFromMargins, dropChoice, marginsFromRect, moveTarget, nextFocus, orderAfterMove, select } from './logic';

describe('organize selection', () => {
  it('click selects one, meta toggles, shift extends from the anchor', () => {
    let s = select({ selected: [], anchor: null }, 2, {});
    expect(s).toEqual({ selected: [2], anchor: 2 });
    s = select(s, 5, { meta: true });
    expect(s.selected).toEqual([2, 5]);
    s = select(s, 2, { meta: true });
    expect(s.selected).toEqual([5]);
    s = select({ selected: [1], anchor: 1 }, 4, { shift: true });
    expect(s).toEqual({ selected: [1, 2, 3, 4], anchor: 1 });
    s = select({ selected: [6], anchor: 6 }, 3, { shift: true });
    expect(s.selected).toEqual([3, 4, 5, 6]);
  });

  it('arrow keys move focus in reading order, mirrored in RTL', () => {
    expect(nextFocus(2, 'ArrowRight', 'ltr', 10, 4)).toBe(3);
    expect(nextFocus(2, 'ArrowRight', 'rtl', 10, 4)).toBe(1);
    expect(nextFocus(2, 'ArrowLeft', 'rtl', 10, 4)).toBe(3);
    expect(nextFocus(2, 'ArrowDown', 'rtl', 10, 4)).toBe(6);
    expect(nextFocus(8, 'ArrowDown', 'ltr', 10, 4)).toBe(9);
    expect(nextFocus(0, 'ArrowUp', 'ltr', 10, 4)).toBe(0);
    expect(nextFocus(4, 'Home', 'ltr', 10, 4)).toBe(0);
    expect(nextFocus(4, 'End', 'ltr', 10, 4)).toBe(9);
  });
});

describe('moving pages', () => {
  it('turns a drop slot into the engine `to` (index without the moved pages)', () => {
    // pages 0..5, move [1,2] so they land before page 5 (slot 5)
    expect(moveTarget([1, 2], 5)).toBe(3);
    expect(orderAfterMove(6, [1, 2], 3)).toEqual([0, 3, 4, 1, 2, 5]);
    // to the very start / end
    expect(moveTarget([4], 0)).toBe(0);
    expect(orderAfterMove(6, [4], 0)).toEqual([4, 0, 1, 2, 3, 5]);
    expect(moveTarget([0], 6)).toBe(5);
    expect(orderAfterMove(6, [0], 5)).toEqual([1, 2, 3, 4, 5, 0]);
    // dropping a page next to itself changes nothing
    expect(orderAfterMove(4, [2], moveTarget([2], 2))).toEqual([0, 1, 2, 3]);
    expect(orderAfterMove(4, [2], moveTarget([2], 3))).toEqual([0, 1, 2, 3]);
  });
});

describe('crop geometry', () => {
  const media: [number, number, number, number] = [0, 0, 600, 800];
  it('maps displayed margins to a CropBox for every rotation', () => {
    const m = { top: 10, right: 20, bottom: 30, left: 40 };
    expect(cropBoxFromMargins(media, 0, m)).toEqual([40, 30, 580, 790]);
    // /Rotate 90: the page's left edge is shown on top, its top edge on the right
    expect(cropBoxFromMargins(media, 90, m)).toEqual([10, 40, 570, 780]);
    expect(cropBoxFromMargins(media, 180, m)).toEqual([20, 10, 560, 770]);
    expect(cropBoxFromMargins(media, 270, m)).toEqual([30, 20, 590, 760]);
  });

  it('refuses margins that leave nothing', () => {
    expect(cropBoxFromMargins(media, 0, { top: 500, right: 0, bottom: 400, left: 0 })).toBeNull();
    expect(cropBoxFromMargins(media, 0, { top: -1, right: 0, bottom: 0, left: 0 })).toBeNull();
  });

  it('turns a rectangle drawn on the preview into margins (points)', () => {
    // preview 300×400 px of a 600×800 pt page; rectangle from (30,40) to (270,380)
    expect(marginsFromRect({ x: 30, y: 40, w: 240, h: 340 }, 300, 400, 600, 800)).toEqual({ top: 80, right: 60, bottom: 40, left: 60 });
  });
});

describe('drop overlay', () => {
  it('the first (start) half combines, the other opens — mirrored in RTL', () => {
    expect(dropChoice(100, 1000, 'ltr')).toBe('combine');
    expect(dropChoice(900, 1000, 'ltr')).toBe('open');
    expect(dropChoice(100, 1000, 'rtl')).toBe('open');
    expect(dropChoice(900, 1000, 'rtl')).toBe('combine');
  });
});
