import { describe, expect, it } from 'vitest';
import { MAX_RENDER_PIXELS, withinPixelBudget } from './useRenderedCanvas';

describe('the scale a page is drawn at', () => {
  it('is what was asked for while the page fits the core’s pixel budget', () => {
    expect(withinPixelBudget(8, [595, 842])).toBe(8);
    expect(withinPixelBudget(1.5, [2384, 3370])).toBe(1.5);
  });

  it('is smaller for a large page at a high zoom, so it is drawn softer rather than refused', () => {
    // A3 at 8× is just past 64 million pixels; A0 far past it.
    for (const size of [
      [842, 1191],
      [2384, 3370],
    ] as const) {
      const scale = withinPixelBudget(8, size);
      expect(scale).toBeLessThan(8);
      expect(Math.floor(size[0] * scale) * Math.floor(size[1] * scale)).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
    }
  });
});
