import { describe, expect, it } from 'vitest';
import {
  NO_CLEANUP,
  anyCleanup,
  blobs,
  cleanUp,
  flattenBackground,
  greyOf,
  inkByOtsu,
  isBorder,
  sanitizeCleanup,
  sauvola,
  stretchContrast,
} from './cleanup';
import type { Grey } from './cleanup';
import type { Pixels } from './deskew';

const W = 400;
const H = 300;

/** A page of "letters": 6 × 10 px bars in rows, like lines of text at 300 dpi. */
function isLetter(x: number, y: number): boolean {
  const inLine = y % 40 >= 12 && y % 40 < 28;
  const inLetter = x % 14 >= 4 && x % 14 < 10;
  return x > 30 && x < W - 30 && y > 20 && y < H - 20 && inLine && inLetter;
}

/** The page lit unevenly: the paper falls from 240 to 70 towards the left. */
function shadowed(): Grey {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const light = 0.29 + 0.71 * Math.min(1, x / (W * 0.8));
      data[y * W + x] = Math.round((isLetter(x, y) ? 25 : 240) * light);
    }
  }
  return { width: W, height: H, data };
}

const letters = () => {
  let n = 0;
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (isLetter(x, y)) n += 1;
  return n;
};

/** How well `ink` finds the letters: the share of letter pixels found, and of paper pixels taken for ink. */
function agreement(ink: Uint8Array): { found: number; false: number } {
  let found = 0;
  let wrong = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      if (isLetter(x, y)) found += ink[i]!;
      else wrong += ink[i]!;
    }
  }
  return { found: found / letters(), false: wrong / (W * H - letters()) };
}

function toPixels(grey: Grey): Pixels {
  const rgba = new Uint8ClampedArray(grey.width * grey.height * 4);
  grey.data.forEach((v, i) => {
    rgba.set([v, v, v, 255], i * 4);
  });
  return { width: grey.width, height: grey.height, rgba };
}

describe('cleaning a scan up', () => {
  it('one threshold for the page turns the shadowed paper into ink', () => {
    const { false: wrong } = agreement(inkByOtsu(shadowed()));
    // A good part of the page's paper counts as ink: the words there are a blot.
    expect(wrong).toBeGreaterThan(0.2);
  });

  it('evening out the paper makes the shadow white again and keeps the letters', () => {
    const page = shadowed();
    flattenBackground(page, 300);
    const paper: number[] = [];
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (!isLetter(x, y)) paper.push(page.data[y * W + x]!);
    paper.sort((a, b) => a - b);
    // Nearly all of the paper is close to white, in the shadow too.
    expect(paper[Math.floor(paper.length * 0.05)]).toBeGreaterThan(215);
    const { found, false: wrong } = agreement(inkByOtsu(page));
    expect(found).toBeGreaterThan(0.95);
    expect(wrong).toBeLessThan(0.01);
  });

  it("Sauvola's threshold finds the letters in the shadow without evening the paper out", () => {
    const { found, false: wrong } = agreement(sauvola(shadowed(), 300));
    expect(found).toBeGreaterThan(0.9);
    expect(wrong).toBeLessThan(0.02);
  });

  it('stretches the ink to black and the paper to white', () => {
    const data = new Uint8Array(1000);
    data.fill(180);
    data.fill(90, 0, 100);
    const page = { width: 100, height: 10, data };
    stretchContrast(page);
    expect(page.data[0]).toBe(0);
    expect(page.data[500]).toBe(255);
  });

  it('leaves a flat page alone', () => {
    const data = new Uint8Array(1000).fill(200);
    const page = { width: 100, height: 10, data };
    stretchContrast(page);
    expect(page.data.every((v) => v === 200)).toBe(true);
  });

  it('finds connected pieces of ink, diagonals included', () => {
    const ink = new Uint8Array(6 * 5);
    // A diagonal of three pixels, and a separate 2 × 2 square.
    for (const [x, y] of [[0, 0], [1, 1], [2, 2], [4, 3], [5, 3], [4, 4], [5, 4]] as const) ink[y * 6 + x] = 1;
    const found = blobs(ink, 6, 5).blobs.sort((a, b) => a.x0 - b.x0);
    expect(found).toEqual([
      { area: 3, x0: 0, y0: 0, x1: 3, y1: 3 },
      { area: 4, x0: 4, y0: 3, x1: 6, y1: 5 },
    ]);
  });

  it('takes away specks and keeps the dots of the letters', () => {
    const data = new Uint8Array(W * H).fill(255);
    // A letter's dot, 6 px across at 300 dpi, and single-pixel specks.
    for (let y = 100; y < 106; y += 1) for (let x = 100; x < 106; x += 1) data[y * W + x] = 0;
    for (const [x, y] of [[20, 20], [300, 50], [200, 250]] as const) data[y * W + x] = 0;
    const pixels = toPixels({ width: W, height: H, data });
    const report = cleanUp(pixels, { ...NO_CLEANUP, despeckle: true }, 300);
    expect(report.specks).toBe(3);
    const after = greyOf(pixels);
    expect(after.data[20 * W + 20]).toBe(255);
    expect(after.data[103 * W + 103]).toBe(0);
  });

  it("takes away a scanner's dark band along an edge, and not the words beside it", () => {
    const data = new Uint8Array(W * H).fill(255);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < 12; x += 1) data[y * W + x] = 10;
    // A word touching nothing, near the band.
    for (let y = 100; y < 115; y += 1) for (let x = 20; x < 60; x += 1) data[y * W + x] = 10;
    const pixels = toPixels({ width: W, height: H, data });
    const report = cleanUp(pixels, { ...NO_CLEANUP, borders: true }, 300);
    expect(report.borders).toBe(1);
    const after = greyOf(pixels);
    expect(after.data[150 * W + 5]).toBe(255);
    expect(after.data[105 * W + 30]).toBe(10);
  });

  it('does not take a shadow over a corner, reaching far in, for a border', () => {
    expect(isBorder({ area: 20_000, x0: 0, y0: 150, x1: 200, y1: 300 }, W, H)).toBe(false);
    expect(isBorder({ area: 3_600, x0: 0, y0: 0, x1: 12, y1: 300 }, W, H)).toBe(true);
    // A letter touching the edge is not a band either.
    expect(isBorder({ area: 40, x0: 0, y0: 100, x1: 6, y1: 110 }, W, H)).toBe(false);
  });

  it('with nothing chosen, the page is read exactly as it is drawn', () => {
    const pixels = toPixels(shadowed());
    const before = pixels.rgba.slice();
    expect(anyCleanup(NO_CLEANUP)).toBe(false);
    cleanUp(pixels, NO_CLEANUP, 300);
    expect(pixels.rgba).toEqual(before);
  });

  it('the whole cleanup reads the shadowed page as ink and paper', () => {
    const pixels = toPixels(shadowed());
    cleanUp(pixels, { background: true, contrast: true, binarize: true, despeckle: true, borders: true }, 300);
    const grey = greyOf(pixels);
    expect(grey.data.every((v) => v === 0 || v === 255)).toBe(true);
    const ink = new Uint8Array(grey.data.length);
    grey.data.forEach((v, i) => (ink[i] = v === 0 ? 1 : 0));
    const { found, false: wrong } = agreement(ink);
    expect(found).toBeGreaterThan(0.9);
    expect(wrong).toBeLessThan(0.01);
  });

  it('reads stored options defensively', () => {
    expect(sanitizeCleanup({ background: true, binarize: 'yes', extra: 1 })).toEqual({ ...NO_CLEANUP, background: true });
    expect(sanitizeCleanup(null)).toEqual(NO_CLEANUP);
  });
});
