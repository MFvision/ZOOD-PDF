/**
 * Cleaning a scan up before it is read.
 *
 * Tesseract splits a page into ink and paper with one threshold for the whole
 * page (Otsu's). That works on a clean scan and fails on a real one: where a
 * book's fold, a hand or the lamp darkens the paper, or a tea stain tints it,
 * the darkened paper falls on the ink side of the threshold and the words in
 * it come out as a black blot. Measured on the corpus's shadowed and stained
 * scan (`tests/corpus/arabic/generators/gen_scans.py`), see `docs/STATUS.md`.
 *
 * Each step here is one a person can choose in Scan & OCR:
 *
 * - **background**: the paper's own brightness is estimated over the page
 *   (the bright end of each small block, spread and smoothed so letters do
 *   not count) and every pixel is divided by it — shadows and stains become
 *   white paper again, ink stays ink;
 * - **contrast**: the darkest ink is stretched to black and the paper to white;
 * - **binarize**: black and white by each pixel's own neighbourhood (Sauvola),
 *   not one threshold for the page;
 * - **despeckle**: dots of ink far too small to be part of a letter — an
 *   Arabic letter's dots are several times larger at any resolution a page is
 *   read at — are taken away;
 * - **borders**: the dark bands a scanner leaves along a page's edges are
 *   taken away, and nothing that reaches in from the edge further than a band.
 *
 * Everything works on a grey copy of the page in place, bounded in memory by
 * a few rows and one grey page; nothing here runs longer than a few passes
 * over the pixels.
 */

import type { Pixels } from './deskew';

/** A page in shades of grey, row by row: 0 is black, 255 is white. */
export interface Grey {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface CleanupOptions {
  /** Even out the paper: shadows, stains, uneven light. */
  background: boolean;
  /** Stretch the ink to black and the paper to white. */
  contrast: boolean;
  /** Black and white by each pixel's neighbourhood (Sauvola). */
  binarize: boolean;
  /** Take away specks too small to belong to a letter. */
  despeckle: boolean;
  /** Take away dark bands along the page's edges. */
  borders: boolean;
}

export const CLEANUP_STEPS = ['background', 'contrast', 'binarize', 'despeckle', 'borders'] as const;
export type CleanupStep = (typeof CLEANUP_STEPS)[number];

export const NO_CLEANUP: CleanupOptions = {
  background: false,
  contrast: false,
  binarize: false,
  despeckle: false,
  borders: false,
};

/** Whether any step is chosen: without one the page is read exactly as it is drawn. */
export function anyCleanup(options: CleanupOptions): boolean {
  return CLEANUP_STEPS.some((step) => options[step]);
}

/** Stored or passed-in options, each one checked. */
export function sanitizeCleanup(raw: unknown): CleanupOptions {
  const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...NO_CLEANUP };
  for (const step of CLEANUP_STEPS) out[step] = given[step] === true;
  return out;
}

/** The luminance of a render (premultiplied over white, so opaque). */
export function greyOf(page: Pixels): Grey {
  const n = page.width * page.height;
  const data = new Uint8Array(n);
  const rgba = page.rgba;
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    // Rec. 709 weights in integers: 54 + 183 + 19 = 256.
    data[i] = (54 * rgba[p]! + 183 * rgba[p + 1]! + 19 * rgba[p + 2]!) >> 8;
  }
  return { width: page.width, height: page.height, data };
}

/** Writes `grey` back into the render, as grey opaque pixels. */
export function writeGrey(grey: Grey, page: Pixels): void {
  const n = grey.width * grey.height;
  const rgba = page.rgba;
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    const v = grey.data[i]!;
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
  }
}

/** Pixels per point of a page drawn at `dpi`, relative to 300 dpi: sizes below are for 300. */
const at300 = (dpi: number) => Math.max(0.25, dpi / 300);

/**
 * Evens out the paper (in place). The page is cut into blocks about 2 mm
 * across; each block's paper is its bright end (the 90th percentile: noise
 * and a few bright pixels do not count). A block that is all ink — a thick
 * heading, a black box — takes the brightest paper of the blocks around it,
 * so it is not mistaken for paper; the grid is then smoothed, and each pixel
 * divided by the paper under it, read between the blocks' centres.
 */
export function flattenBackground(grey: Grey, dpi: number): void {
  const { width, height, data } = grey;
  if (width === 0 || height === 0) return;
  const block = Math.max(6, Math.round(24 * at300(dpi)));
  const gw = Math.ceil(width / block);
  const gh = Math.ceil(height / block);
  const paper = new Float32Array(gw * gh);
  const histogram = new Uint32Array(256);
  for (let by = 0; by < gh; by += 1) {
    for (let bx = 0; bx < gw; bx += 1) {
      histogram.fill(0);
      const x0 = bx * block;
      const y0 = by * block;
      const x1 = Math.min(width, x0 + block);
      const y1 = Math.min(height, y0 + block);
      for (let y = y0; y < y1; y += 1) {
        const row = y * width;
        for (let x = x0; x < x1; x += 1) histogram[data[row + x]!]! += 1;
      }
      const count = (x1 - x0) * (y1 - y0);
      // The 90th percentile, from the bright end.
      let seen = 0;
      let level = 255;
      const want = Math.ceil(count * 0.1);
      for (; level > 0; level -= 1) {
        seen += histogram[level]!;
        if (seen >= want) break;
      }
      paper[by * gw + bx] = level;
    }
  }
  // Blocks covered by ink take the paper around them: a closing (the
  // brightest within two blocks, then the darkest of those), which fills
  // what is smaller than five blocks and leaves a slope of light as it was.
  const closed = extremeFilter(extremeFilter(paper, gw, gh, 2, 'max'), gw, gh, 2, 'min');
  // Smoothed twice with a box two blocks across: close to a Gaussian.
  const smooth = boxBlur(boxBlur(closed, gw, gh, 2), gw, gh, 2);
  // Paper darker than this is not paper any more: a photo, a black box.
  const floor = 48;
  for (let y = 0; y < height; y += 1) {
    // Between the centres of the blocks above and below.
    const gy = Math.min(gh - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const fy = gy - y0;
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(gw - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const fx = gx - x0;
      const top = smooth[y0 * gw + x0]! * (1 - fx) + smooth[y0 * gw + x1]! * fx;
      const bottom = smooth[y1 * gw + x0]! * (1 - fx) + smooth[y1 * gw + x1]! * fx;
      const background = Math.max(floor, top * (1 - fy) + bottom * fy);
      const v = (data[row + x]! * 255) / background;
      data[row + x] = v >= 255 ? 255 : v;
    }
  }
}

/**
 * A grid's cell `k` along a line of `n` (from `at`, `step` apart), read past
 * either end as the line's slope carries on (an odd reflection): the filters
 * below then leave a slope of light as it is up to the page's edge, where a
 * book's fold puts its shadow, instead of bending it towards the middle.
 */
function cell(grid: Float32Array, at: number, step: number, n: number, k: number): number {
  const read = (j: number) => grid[at + j * step]!;
  if (n === 1) return read(0);
  if (k < 0) return Math.max(0, Math.min(255, 2 * read(0) - read(Math.min(n - 1, -k))));
  if (k >= n) return Math.max(0, Math.min(255, 2 * read(n - 1) - read(Math.max(0, 2 * (n - 1) - k))));
  return read(k);
}

/** One pass of a filter along the rows (`across`) or the columns of a grid. */
function pass(
  grid: Float32Array,
  gw: number,
  gh: number,
  radius: number,
  across: boolean,
  combine: (values: number[]) => number,
): Float32Array {
  const out = new Float32Array(grid.length);
  const values: number[] = [];
  const lines = across ? gh : gw;
  const n = across ? gw : gh;
  const step = across ? 1 : gw;
  for (let line = 0; line < lines; line += 1) {
    const at = across ? line * gw : line;
    for (let k = 0; k < n; k += 1) {
      values.length = 0;
      for (let j = k - radius; j <= k + radius; j += 1) values.push(cell(grid, at, step, n, j));
      out[at + k * step] = combine(values);
    }
  }
  return out;
}

const largest = (values: number[]) => Math.max(...values);
const smallest = (values: number[]) => Math.min(...values);
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** The largest (or smallest) value within `radius` cells, over a grid (separable). */
function extremeFilter(
  grid: Float32Array,
  gw: number,
  gh: number,
  radius: number,
  pick: 'max' | 'min',
): Float32Array {
  const combine = pick === 'max' ? largest : smallest;
  return pass(pass(grid, gw, gh, radius, true, combine), gw, gh, radius, false, combine);
}

/** The mean within `radius` cells, over a grid (separable). */
function boxBlur(grid: Float32Array, gw: number, gh: number, radius: number): Float32Array {
  return pass(pass(grid, gw, gh, radius, true, mean), gw, gh, radius, false, mean);
}

/**
 * Stretches the levels (in place): the darkest 0.5 % of the page becomes
 * black and the paper — the level most of the page is at or above — white.
 * A page with too little range to tell ink from paper is left alone.
 */
export function stretchContrast(grey: Grey): void {
  const { data } = grey;
  const n = data.length;
  if (n === 0) return;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < n; i += 1) histogram[data[i]!]! += 1;
  const level = (share: number) => {
    const want = n * share;
    let seen = 0;
    for (let v = 0; v < 256; v += 1) {
      seen += histogram[v]!;
      if (seen >= want) return v;
    }
    return 255;
  };
  const ink = level(0.005);
  // A page is mostly paper: the level half of it is at or above.
  const paper = level(0.5);
  if (paper - ink < 32) return;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v += 1) lut[v] = Math.max(0, Math.min(255, Math.round(((v - ink) * 255) / (paper - ink))));
  for (let i = 0; i < n; i += 1) data[i] = lut[data[i]!]!;
}

/**
 * Sauvola's threshold: a pixel is ink when it is darker than
 * `mean · (1 + k · (deviation / 128 − 1))` of the square around it, about
 * 2.5 mm across. Where the neighbourhood is flat paper the threshold drops
 * well below it, so noise stays paper; across a letter's edge it sits between
 * the two. The sums are kept per column over a moving band of rows, so memory
 * is a few rows whatever the page size. Returns the ink as 1, paper as 0.
 */
export function sauvola(grey: Grey, dpi: number, k = 0.2): Uint8Array {
  const { width, height, data } = grey;
  const ink = new Uint8Array(width * height);
  if (width === 0 || height === 0) return ink;
  const radius = Math.max(3, Math.round(15 * at300(dpi)));
  const columnSum = new Float64Array(width);
  const columnSquares = new Float64Array(width);
  const add = (y: number, sign: number) => {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const v = data[row + x]!;
      columnSum[x]! += sign * v;
      columnSquares[x]! += sign * v * v;
    }
  };
  // Rows [0, radius) first; each step then brings in the row `radius` below.
  for (let y = 0; y < Math.min(height, radius); y += 1) add(y, 1);
  for (let y = 0; y < height; y += 1) {
    if (y + radius < height) add(y + radius, 1);
    if (y - radius - 1 >= 0) add(y - radius - 1, -1);
    const rows = Math.min(height - 1, y + radius) - Math.max(0, y - radius) + 1;
    let sum = 0;
    let squares = 0;
    for (let x = 0; x < Math.min(width, radius); x += 1) {
      sum += columnSum[x]!;
      squares += columnSquares[x]!;
    }
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (x + radius < width) {
        sum += columnSum[x + radius]!;
        squares += columnSquares[x + radius]!;
      }
      if (x - radius - 1 >= 0) {
        sum -= columnSum[x - radius - 1]!;
        squares -= columnSquares[x - radius - 1]!;
      }
      const columns = Math.min(width - 1, x + radius) - Math.max(0, x - radius) + 1;
      const count = rows * columns;
      const mean = sum / count;
      const deviation = Math.sqrt(Math.max(0, squares / count - mean * mean));
      const threshold = mean * (1 + k * (deviation / 128 - 1));
      ink[row + x] = data[row + x]! < threshold ? 1 : 0;
    }
  }
  return ink;
}

/** Otsu's level over the page: the ink is at or below it. */
export function otsuLevel(grey: Grey): number {
  const histogram = new Uint32Array(256);
  for (const v of grey.data) histogram[v]! += 1;
  const total = grey.data.length;
  let sum = 0;
  for (let v = 0; v < 256; v += 1) sum += v * histogram[v]!;
  let below = 0;
  let sumBelow = 0;
  let best = 127;
  let bestSpread = -1;
  for (let v = 0; v < 256; v += 1) {
    below += histogram[v]!;
    if (below === 0 || below === total) continue;
    sumBelow += v * histogram[v]!;
    const above = total - below;
    const spread = below * above * (sumBelow / below - (sum - sumBelow) / above) ** 2;
    if (spread > bestSpread) {
      bestSpread = spread;
      best = v;
    }
  }
  return best;
}

/** The ink of a grey page by one threshold (Otsu's), as 1; paper as 0. */
export function inkByOtsu(grey: Grey): Uint8Array {
  const level = otsuLevel(grey);
  const ink = new Uint8Array(grey.data.length);
  for (let i = 0; i < ink.length; i += 1) ink[i] = grey.data[i]! <= level ? 1 : 0;
  return ink;
}

/** One connected piece of ink: its size and its box. */
export interface Blob {
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A run of ink on one row, `[start, end)`. */
interface Run {
  y: number;
  start: number;
  end: number;
}

/**
 * The connected pieces of `ink` (8-connected), found as runs along the rows
 * joined where they touch the row above — memory by runs, not by pixels.
 * Returns the pieces and, for each run, which piece it is in.
 */
export function blobs(ink: Uint8Array, width: number, height: number): { blobs: Blob[]; runs: Run[]; blobOf: Int32Array } {
  const runs: Run[] = [];
  const parent: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  let previousStart = 0;
  let previousEnd = 0;
  for (let y = 0; y < height; y += 1) {
    const rowStart = runs.length;
    const row = y * width;
    // The runs of the row above, in order: those ending before this run
    // starts can touch no later run of this row either.
    let above = previousStart;
    let x = 0;
    while (x < width) {
      if (!ink[row + x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < width && ink[row + x]) x += 1;
      const id = runs.length;
      runs.push({ y, start, end: x });
      parent.push(id);
      while (above < previousEnd && runs[above]!.end < start) above += 1;
      // Touching a run of the row above, diagonals included.
      for (let k = above; k < previousEnd && runs[k]!.start <= x; k += 1) {
        const a = find(k);
        const b = find(id);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
    previousStart = rowStart;
    previousEnd = runs.length;
  }
  const blobOf = new Int32Array(runs.length);
  const index = new Map<number, number>();
  const found: Blob[] = [];
  runs.forEach((run, k) => {
    const root = find(k);
    let at = index.get(root);
    if (at === undefined) {
      at = found.length;
      index.set(root, at);
      found.push({ area: 0, x0: run.start, y0: run.y, x1: run.end, y1: run.y + 1 });
    }
    const blob = found[at]!;
    blob.area += run.end - run.start;
    blob.x0 = Math.min(blob.x0, run.start);
    blob.x1 = Math.max(blob.x1, run.end);
    blob.y0 = Math.min(blob.y0, run.y);
    blob.y1 = Math.max(blob.y1, run.y + 1);
    blobOf[k] = at;
  });
  return { blobs: found, runs, blobOf };
}

/** The largest speck taken away, in pixels at 300 dpi: an Arabic letter's dot is about 30. */
const SPECK_AREA = 6;

/** Which pieces are specks: a few pixels, at most two across either way. */
export function isSpeck(blob: Blob, dpi: number): boolean {
  const scale = at300(dpi);
  const most = Math.max(2, Math.round(SPECK_AREA * scale * scale));
  const across = Math.max(2, Math.round(3 * scale));
  return blob.area <= most && blob.x1 - blob.x0 <= across && blob.y1 - blob.y0 <= across;
}

/**
 * Whether a piece is a scanner's border: it touches an edge of the page, runs
 * along it for a tenth of its length or more, and reaches no further in than
 * an eighth of the page — or is solid ink (most of its box) a twentieth of
 * the edge long, as a corner of a crooked scan's border is. A shadow
 * that covers a corner and the words in it reaches too far in, and is left.
 */
export function isBorder(blob: Blob, width: number, height: number): boolean {
  const deepest = (side: number) => side * 0.125;
  const along = (length: number, side: number) => length >= side * 0.1;
  const solid = blob.area >= (blob.x1 - blob.x0) * (blob.y1 - blob.y0) * 0.6;
  const band = (touches: boolean, depth: number, side: number, length: number, run: number) =>
    touches && depth <= deepest(side) && (along(length, run) || (solid && length >= run * 0.05));
  const w = blob.x1 - blob.x0;
  const h = blob.y1 - blob.y0;
  return (
    band(blob.x0 === 0, w, width, h, height) ||
    band(blob.x1 === width, w, width, h, height) ||
    band(blob.y0 === 0, h, height, w, width) ||
    band(blob.y1 === height, h, height, w, width)
  );
}

/** Paints the runs of the chosen pieces white in `grey` and clears them in `ink`; returns how many pieces. */
function erase(
  grey: Grey,
  ink: Uint8Array,
  found: ReturnType<typeof blobs>,
  chosen: (blob: Blob) => boolean,
): number {
  const gone = found.blobs.map(chosen);
  found.runs.forEach((run, k) => {
    if (!gone[found.blobOf[k]!]) return;
    const row = run.y * grey.width;
    for (let x = run.start; x < run.end; x += 1) {
      grey.data[row + x] = 255;
      ink[row + x] = 0;
    }
  });
  return gone.filter(Boolean).length;
}

/** What `cleanUp` did to a page. */
export interface CleanupReport {
  specks: number;
  borders: number;
}

/**
 * Cleans `page` in place with the chosen steps, in the order that makes each
 * work: the paper evened out first (a threshold then has something to find),
 * the contrast stretched, and the specks and borders found in the ink the
 * threshold leaves. Without `binarize` the page stays in grey — only what
 * was taken away turns white.
 */
export function cleanUp(page: Pixels, options: CleanupOptions, dpi: number): CleanupReport {
  const report: CleanupReport = { specks: 0, borders: 0 };
  if (!anyCleanup(options)) return report;
  const grey = greyOf(page);
  if (options.background) flattenBackground(grey, dpi);
  if (options.contrast) stretchContrast(grey);
  let ink: Uint8Array | null = null;
  if (options.binarize) {
    ink = sauvola(grey, dpi);
    for (let i = 0; i < ink.length; i += 1) grey.data[i] = ink[i] ? 0 : 255;
  }
  if (options.despeckle || options.borders) {
    ink ??= inkByOtsu(grey);
    const found = blobs(ink, grey.width, grey.height);
    if (options.borders) report.borders = erase(grey, ink, found, (blob) => isBorder(blob, grey.width, grey.height));
    if (options.despeckle) report.specks = erase(grey, ink, found, (blob) => isSpeck(blob, dpi));
  }
  writeGrey(grey, page);
  return report;
}
