/**
 * Straightening a crooked scan before it is read.
 *
 * Tesseract reads a page turned a degree or two about as well as a straight
 * one, and much worse past that: on the corpus, 89 % of the words at 3°,
 * 80 % at 5°, 56 % at 8° — and straightened first, 92 % at 5°, 93 % at 8°
 * (up to 4° the two are within its noise). A page's lines of text line up in rows only when
 * looked at along their own slant, so the slant that makes the rows of dark
 * pixels most uneven is the slant of the lines; the page is turned back by
 * it before it is read, and the words are written back at it.
 */

/** A render, RGBA row by row. */
export interface Pixels {
  width: number;
  height: number;
  rgba: Uint8ClampedArray | Uint8Array;
}

/** A page is sampled at most this many times along its longer side. */
const SAMPLE = 900;
/** The slants looked at, in degrees either way. */
const RANGE = 15;
/** A slant smaller than this is left alone: Tesseract reads through it. */
const NEGLIGIBLE = 0.4;
/** A slant must make the rows this much more uneven than none, or it is noise. */
const EVIDENCE = 1.05;

/** The luminance a histogram of 256 levels splits best into ink and paper at (Otsu). */
function otsu(histogram: Uint32Array, total: number): number {
  let sum = 0;
  for (let level = 0; level < 256; level += 1) sum += level * histogram[level]!;
  let below = 0;
  let sumBelow = 0;
  let best = 128;
  let bestSpread = -1;
  for (let level = 0; level < 256; level += 1) {
    below += histogram[level]!;
    if (below === 0 || below === total) continue;
    sumBelow += level * histogram[level]!;
    const above = total - below;
    const spread = below * above * (sumBelow / below - (sum - sumBelow) / above) ** 2;
    if (spread > bestSpread) {
      bestSpread = spread;
      best = level;
    }
  }
  return best;
}

/**
 * How far the lines of text on `page` are turned, in degrees counter-clockwise
 * as it is shown: 0 when they are straight, or when there is not enough ink
 * to tell.
 */
export function skewAngle(page: Pixels): number {
  const step = Math.max(1, Math.floor(Math.max(page.width, page.height) / SAMPLE));
  const histogram = new Uint32Array(256);
  const levels: number[] = [];
  for (let y = 0; y < page.height; y += step) {
    for (let x = 0; x < page.width; x += step) {
      const at = (y * page.width + x) * 4;
      const level = Math.round(
        0.2126 * page.rgba[at]! + 0.7152 * page.rgba[at + 1]! + 0.0722 * page.rgba[at + 2]!,
      );
      histogram[level] = (histogram[level] ?? 0) + 1;
      levels.push(level);
    }
  }
  const threshold = Math.min(otsu(histogram, levels.length), 200);
  const xs: number[] = [];
  const ys: number[] = [];
  const columns = Math.ceil(page.width / step);
  // Otsu's level is the last of the dark class.
  levels.forEach((level, k) => {
    if (level <= threshold) {
      xs.push((k % columns) * step);
      ys.push(Math.floor(k / columns) * step);
    }
  });
  // Ink on a quarter of the page is a picture, not lines of text.
  if (xs.length < 200 || xs.length > levels.length / 4) return 0;
  const span = page.width + page.height;
  const bins = new Uint32Array(Math.ceil((2 * span) / step) + 2);
  // How uneven the rows are when looked at along `degrees`: the sum of the
  // squares of their counts, which a row of text lined up raises most.
  const unevenness = (degrees: number) => {
    const t = (degrees * Math.PI) / 180;
    const [s, c] = [Math.sin(t), Math.cos(t)];
    bins.fill(0);
    for (let k = 0; k < xs.length; k += 1) {
      const row = Math.floor((ys[k]! * c + xs[k]! * s + span) / step);
      bins[row] = (bins[row] ?? 0) + 1;
    }
    let total = 0;
    for (const count of bins) total += count * count;
    return total;
  };
  const straight = unevenness(0);
  let best = 0;
  let bestScore = straight;
  for (let degrees = -RANGE; degrees <= RANGE; degrees += 0.5) {
    const score = unevenness(degrees);
    if (score > bestScore) [best, bestScore] = [degrees, score];
  }
  for (let degrees = best - 0.4; degrees <= best + 0.4 + 1e-9; degrees += 0.1) {
    const score = unevenness(degrees);
    if (score > bestScore) [best, bestScore] = [degrees, score];
  }
  if (Math.abs(best) < NEGLIGIBLE || bestScore < straight * EVIDENCE) return 0;
  return Math.round(best * 10) / 10;
}

/**
 * The size of the canvas a `width` by `height` image turned by `degrees`
 * needs, and where the turned image's own frame begins in it: a word read
 * there at `p` is at `p - offset` on the straightened page.
 */
export function turnedFrame(
  width: number,
  height: number,
  degrees: number,
): { width: number; height: number; offset: [number, number] } {
  const t = Math.abs((degrees * Math.PI) / 180);
  const turnedWidth = Math.ceil(width * Math.cos(t) + height * Math.sin(t));
  const turnedHeight = Math.ceil(width * Math.sin(t) + height * Math.cos(t));
  return {
    width: turnedWidth,
    height: turnedHeight,
    offset: [(turnedWidth - width) / 2, (turnedHeight - height) / 2],
  };
}

/**
 * `source` turned `degrees` clockwise — straightening lines that slant that
 * much counter-clockwise — on white, in a canvas large enough to hold it.
 */
export function straighten(
  source: HTMLCanvasElement,
  degrees: number,
): { canvas: HTMLCanvasElement; offset: [number, number] } {
  const frame = turnedFrame(source.width, source.height, degrees);
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, frame.width, frame.height);
    // The letters' edges are what Tesseract reads: the best resampling there is.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.translate(frame.width / 2, frame.height / 2);
    // The canvas turns clockwise for a positive angle.
    context.rotate((degrees * Math.PI) / 180);
    context.drawImage(source, -source.width / 2, -source.height / 2);
  }
  return { canvas, offset: frame.offset };
}
