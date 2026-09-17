import { describe, expect, it } from 'vitest';
import { PT_TO_CSS_PX, ZOOM_STEPS } from '../state/zoom';
import { pageScale, paragraphRect, rectContains } from './geometry';
import type { ParagraphBox } from './geometry';

/** A justified Arabic paragraph on an A4 page, in device space. */
const box: ParagraphBox = { x: 72, y: 120.5, width: 451, height: 96 };

describe('paragraph box to overlay rectangle', () => {
  it('is the identity at 100 % on a 72 dpi scale', () => {
    expect(paragraphRect(box, 1)).toEqual({
      inlineStart: 72,
      blockStart: 120.5,
      inlineSize: 451,
      blockSize: 96,
    });
  });

  it('scales every edge by the same factor at each zoom level', () => {
    for (const zoom of [0.25, 0.5, 0.75, 1, 1.5, 2, 4]) {
      const scale = pageScale(zoom);
      const rect = paragraphRect(box, scale);
      expect(rect.inlineStart).toBeCloseTo(box.x * scale, 10);
      expect(rect.blockStart).toBeCloseTo(box.y * scale, 10);
      expect(rect.inlineSize).toBeCloseTo(box.width * scale, 10);
      expect(rect.blockSize).toBeCloseTo(box.height * scale, 10);
    }
  });

  it('maps 100 % to 96/72 CSS px per point, like the page canvas', () => {
    expect(pageScale(1)).toBe(PT_TO_CSS_PX);
    const rect = paragraphRect(box, pageScale(1));
    expect(rect.inlineStart).toBeCloseTo(96, 10);
    expect(rect.inlineSize).toBeCloseTo(601.333_333, 5);
  });

  it('keeps the box inside the page at every zoom step of the UI', () => {
    const page = { width: 595, height: 842 };
    for (const zoom of ZOOM_STEPS) {
      const scale = pageScale(zoom);
      const rect = paragraphRect(box, scale);
      expect(rect.inlineStart + rect.inlineSize).toBeLessThanOrEqual(page.width * scale);
      expect(rect.blockStart + rect.blockSize).toBeLessThanOrEqual(page.height * scale);
    }
  });

  it('doubling the zoom doubles the rectangle', () => {
    const at100 = paragraphRect(box, pageScale(1));
    const at200 = paragraphRect(box, pageScale(2));
    expect(at200.inlineStart).toBeCloseTo(at100.inlineStart * 2, 10);
    expect(at200.blockStart).toBeCloseTo(at100.blockStart * 2, 10);
    expect(at200.inlineSize).toBeCloseTo(at100.inlineSize * 2, 10);
    expect(at200.blockSize).toBeCloseTo(at100.blockSize * 2, 10);
  });

  it('hit-tests a point in overlay pixels', () => {
    const rect = paragraphRect(box, 2);
    expect(rectContains(rect, 144, 241)).toBe(true);
    expect(rectContains(rect, 144 + 902, 241 + 192)).toBe(true);
    expect(rectContains(rect, 143, 241)).toBe(false);
    expect(rectContains(rect, 144, 240)).toBe(false);
    expect(rectContains(rect, 2000, 2000)).toBe(false);
  });

  it('places a zero-sized box without producing NaN', () => {
    const rect = paragraphRect({ x: 0, y: 0, width: 0, height: 0 }, pageScale(1.5));
    expect(Object.values(rect).every(Number.isFinite)).toBe(true);
    expect(rect).toEqual({ inlineStart: 0, blockStart: 0, inlineSize: 0, blockSize: 0 });
  });
});
