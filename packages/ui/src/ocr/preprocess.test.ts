import { describe, expect, it } from 'vitest';
import {
  despeckle,
  detectSkew,
  flattenShadow,
  gray,
  homography,
  imageSize,
  MAX_PIXELS,
  preprocess,
  rotate,
  sauvola,
  toGray,
  toPgm,
  warpPerspective,
  type Gray,
} from './preprocess';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A page of "text": lines of dark word blocks with dots above, on white, 300-dpi-like scale. */
function textPage(width = 1000, height = 1300, seed = 1): Gray {
  const img = gray(width, height, 255);
  const r = rng(seed);
  for (let y = 120; y + 40 < height - 120; y += 72) {
    let x = 90;
    while (x < width - 140) {
      const w = 40 + Math.floor(r() * 140);
      for (let yy = y; yy < y + 26; yy++) for (let xx = x; xx < Math.min(x + w, width - 90); xx++) img.data[yy * width + xx] = 20;
      // i'jam dots
      const dx = x + Math.floor(r() * w * 0.8);
      for (let yy = y - 12; yy < y - 5; yy++) for (let xx = dx; xx < dx + 7; xx++) img.data[yy * width + xx] = 20;
      x += w + 18 + Math.floor(r() * 12);
    }
  }
  return img;
}

function mean(img: Gray, pred: (i: number) => boolean): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i++) {
    if (!pred(i)) continue;
    s += img.data[i]!;
    n++;
  }
  return n ? s / n : NaN;
}

describe('grayscale', () => {
  it('converts RGBA with Rec. 601 weights and ignores alpha', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 10, 0, 0, 255, 255, 255, 255, 255, 255]);
    const g = toGray(rgba, 2, 2);
    expect(Array.from(g.data)).toEqual([76, 150, 29, 255]);
  });

  it('refuses images above the pixel cap', () => {
    expect(() => gray(20000, 20000)).toThrow(/too large/);
    expect(MAX_PIXELS).toBeLessThanOrEqual(100_000_000);
  });
});

describe('rotation and deskew (projection profile)', () => {
  it('rotates content counter-clockwise for positive angles', () => {
    const img = gray(400, 400, 255);
    for (let x = 100; x < 300; x++) for (let y = 198; y < 202; y++) img.data[y * 400 + x] = 0;
    const r = rotate(img, 10);
    const rowOf = (x: number) => {
      for (let y = 0; y < 400; y++) if (r.data[y * 400 + x]! < 128) return y;
      return -1;
    };
    // right end goes up (smaller y), left end goes down
    expect(rowOf(290)).toBeLessThan(200 - 10);
    expect(rowOf(110)).toBeGreaterThan(200 + 10);
  });

  it.each([5, 8, -3.7, 12.4, 0])('recovers a known rotation of %s° within 0.3°', (angle) => {
    const page = textPage();
    const crooked = sauvola(rotate(page, angle));
    const found = detectSkew(crooked);
    expect(Math.abs(found - angle)).toBeLessThan(0.3);
  });

  it('reports 0 for a blank page and stays within ±15°', () => {
    expect(detectSkew(gray(300, 300, 255))).toBe(0);
    const found = detectSkew(sauvola(rotate(textPage(), 25)));
    expect(Math.abs(found)).toBeLessThanOrEqual(15);
  });
});

function shadowed(page: Gray): Gray {
  // dark gradient from the top-left corner (a hand's shadow), like the corpus scans
  const out = gray(page.width, page.height);
  for (let y = 0; y < page.height; y++)
    for (let x = 0; x < page.width; x++) {
      const d = Math.hypot(x / page.width, y / page.height) / Math.SQRT2;
      const light = 110 + 145 * Math.min(1, d * 1.3);
      out.data[y * page.width + x] = Math.round((page.data[y * page.width + x]! * light) / 255);
    }
  return out;
}

describe('shadow flattening', () => {
  it('flattens a background gradient while keeping text dark', () => {
    const page = textPage();
    const dark = shadowed(page);
    const isBg = (i: number) => page.data[i] === 255;
    const isInk = (i: number) => page.data[i] === 20;
    // before: shadowed corner is much darker than the lit corner
    const corner = (img: Gray, x0: number, y0: number) => mean(img, (i) => isBg(i) && Math.abs((i % img.width) - x0) < 80 && Math.abs(Math.floor(i / img.width) - y0) < 80);
    expect(corner(dark, 60, 60)).toBeLessThan(140);
    const flat = flattenShadow(dark, { dpi: 300 });
    expect(corner(flat, 60, 60)).toBeGreaterThan(225);
    expect(corner(flat, 940, 1240)).toBeGreaterThan(225);
    expect(mean(flat, isInk)).toBeLessThan(90);
  });
});

describe('Sauvola binarisation', () => {
  it('separates ink from paper under a shadow', () => {
    const page = textPage();
    const bin = sauvola(flattenShadow(shadowed(page), { dpi: 300 }), { dpi: 300 });
    let wrong = 0;
    for (let i = 0; i < page.data.length; i++) {
      const ink = page.data[i] === 20;
      if (bin.data[i] !== (ink ? 0 : 255)) wrong++;
    }
    expect(new Set(bin.data)).toEqual(new Set([0, 255]));
    expect(wrong / page.data.length).toBeLessThan(0.01);
  });

  it('keeps a uniformly white page white', () => {
    const bin = sauvola(gray(200, 200, 250));
    expect(bin.data.every((v) => v === 255)).toBe(true);
  });
});

describe('despeckle', () => {
  it('removes components smaller than minArea and keeps the rest (dots included)', () => {
    const img = gray(100, 100, 255);
    const set = (x: number, y: number) => (img.data[y * 100 + x] = 0);
    set(10, 10); // 1 px speck
    set(50, 50);
    set(51, 51); // 2 px diagonal speck (8-connected)
    for (let y = 20; y < 26; y++) for (let x = 20; x < 26; x++) set(x, y); // 36 px dot
    const { image, removed } = despeckle(img, 4);
    expect(removed).toBe(2);
    expect(image.data[10 * 100 + 10]).toBe(255);
    expect(image.data[50 * 100 + 50]).toBe(255);
    expect(image.data[22 * 100 + 22]).toBe(0);
  });
});

describe('perspective correction (4-point homography)', () => {
  it('maps the output rectangle corners onto the quad', () => {
    const quad = [
      { x: 10, y: 20 },
      { x: 300, y: 5 },
      { x: 320, y: 410 },
      { x: 0, y: 400 },
    ] as const;
    const h = homography(200, 300, quad);
    const apply = (x: number, y: number) => {
      const w = h[6]! * x + h[7]! * y + 1;
      return { x: (h[0]! * x + h[1]! * y + h[2]!) / w, y: (h[3]! * x + h[4]! * y + h[5]!) / w };
    };
    for (const [p, q] of [
      [apply(0, 0), quad[0]],
      [apply(200, 0), quad[1]],
      [apply(200, 300), quad[2]],
      [apply(0, 300), quad[3]],
    ] as const) {
      expect(p.x).toBeCloseTo(q.x, 6);
      expect(p.y).toBeCloseTo(q.y, 6);
    }
  });

  it('crops an axis-aligned quad exactly', () => {
    const src = textPage(400, 400, 3);
    const out = warpPerspective(src, [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 300 },
      { x: 100, y: 300 },
    ]);
    expect(out.width).toBe(200);
    expect(out.height).toBe(200);
    let diff = 0;
    for (let y = 1; y < 199; y++) for (let x = 1; x < 199; x++) diff += Math.abs(out.data[y * 200 + x]! - src.data[(y + 100) * 400 + x + 100]!);
    expect(diff / (198 * 198)).toBeLessThan(1);
  });
});

describe('whole pipeline', () => {
  it('deskews, flattens and binarises a crooked shadowed page and reports the angle', () => {
    const page = shadowed(rotate(textPage(), 8));
    const res = preprocess(page, { dpi: 300, deskew: true, flatten: true, binarise: true, despeckle: true });
    expect(Math.abs(res.angle - 8)).toBeLessThan(0.3);
    expect(res.image.width).toBe(page.width);
    expect(new Set(res.image.data)).toEqual(new Set([0, 255]));
    // after deskew the lines are straight again: re-detection finds ~0°
    expect(Math.abs(detectSkew(res.image))).toBeLessThan(0.3);
  });

  it('can keep the page as it is (only measures the angle)', () => {
    const page = rotate(textPage(), -4);
    const res = preprocess(page, { dpi: 300, deskew: false, flatten: false, binarise: false, despeckle: false });
    expect(Math.abs(res.angle + 4)).toBeLessThan(0.3);
    expect(res.image).toBe(page);
    expect(res.deskewed).toBe(false);
  });
});

describe('image headers (dimension caps before decoding)', () => {
  it('reads PNG and JPEG sizes', () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 2481);
    new DataView(png.buffer).setUint32(20, 3509);
    expect(imageSize(png)).toEqual({ type: 'png', width: 2481, height: 3509 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x00, 0x02, 0x00, 3, 1, 0x11, 0]);
    expect(imageSize(jpeg)).toEqual({ type: 'jpeg', width: 512, height: 256 });
  });

  it('rejects unknown and truncated data', () => {
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('writes binary PGM for the recogniser', () => {
    const pgm = toPgm(gray(3, 2, 7));
    const head = new TextDecoder().decode(pgm.subarray(0, 11));
    expect(head).toBe('P5\n3 2\n255\n');
    expect(pgm.length).toBe(11 + 6);
  });
});
