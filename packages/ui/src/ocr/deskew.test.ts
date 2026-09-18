import { describe, expect, it } from 'vitest';
import { skewAngle, turnedFrame } from './deskew';
import type { Pixels } from './deskew';

/**
 * A page of `lines` lines of "words" — dark dashes with gaps — slanting
 * `degrees` counter-clockwise as shown, like a crooked scan.
 */
function page(degrees: number, lines = 24, width = 1200, height = 1700): Pixels {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(235);
  const t = (degrees * Math.PI) / 180;
  const [cx, cy] = [width / 2, height / 2];
  const ink = (x: number, y: number) => {
    // A point of the straight page, turned about the centre (y grows down).
    const dx = x - cx;
    const dy = y - cy;
    const px = Math.round(cx + dx * Math.cos(t) + dy * Math.sin(t));
    const py = Math.round(cy - dx * Math.sin(t) + dy * Math.cos(t));
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const at = (py * width + px) * 4;
    rgba[at] = rgba[at + 1] = rgba[at + 2] = 20;
  };
  for (let line = 0; line < lines; line += 1) {
    const top = 200 + line * 55;
    for (let x = 150; x < width - 150; x += 1) {
      if (x % 90 > 70) continue; // the gap between words
      for (let y = top; y < top + 18; y += 1) if ((x + y) % 3 !== 0) ink(x, y);
    }
  }
  return { width, height, rgba };
}

describe('how crooked a scan is', () => {
  it('finds the slant of the lines, either way', () => {
    for (const degrees of [3, 5, 8, -6, 12]) {
      expect(Math.abs(skewAngle(page(degrees)) - degrees), `${degrees}°`).toBeLessThanOrEqual(0.3);
    }
  });

  it('leaves a straight page, and one barely turned, as it is', () => {
    expect(skewAngle(page(0))).toBe(0);
    expect(skewAngle(page(0.2))).toBe(0);
  });

  it('says nothing about a blank page or a picture', () => {
    expect(skewAngle(page(5, 0))).toBe(0);
    const photo = page(0, 0);
    photo.rgba.fill(40);
    expect(skewAngle(photo)).toBe(0);
  });

  it('makes room for the turned page, and says where it begins', () => {
    const frame = turnedFrame(1000, 1400, 5);
    expect(frame.width).toBe(
      Math.ceil(1000 * Math.cos(Math.PI / 36) + 1400 * Math.sin(Math.PI / 36)),
    );
    expect(frame.offset[0]).toBeCloseTo((frame.width - 1000) / 2);
    expect(turnedFrame(1000, 1400, 0)).toEqual({ width: 1000, height: 1400, offset: [0, 0] });
  });
});
