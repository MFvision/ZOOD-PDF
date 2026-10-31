/**
 * Finding the lines of text on a page, for Tesseract to read one at a time.
 *
 * Tesseract finds the lines itself by splitting the page into ink and paper
 * with one threshold for the whole page. On a phone photo, a page with a
 * shadow or a stain, or an old print, that split fails and whole lines are
 * lost or merged (measured: 37 % of phone photos' words read, `models/README.md`). PaddleOCR's
 * text detector (PP-OCRv5 mobile, Apache-2.0) is a small network that marks
 * where text is regardless of the light; its map is turned into line boxes
 * here, and each line is evened out (`flattenLine`) before Tesseract reads it.
 *
 * Everything here is plain arithmetic on arrays, so it is tested without a
 * browser; `engine.ts` runs the network.
 */

/** A box in the page's pixels: `[x0, y0, x1, y1]`. */
export type Box = [number, number, number, number];

/** The detector's input: the page scaled so its longest side is at most this, in multiples of 32. */
export const DETECT_SIDE = 1600;

/** The size the page is given to the detector at, and the scale back. */
export function detectSize(width: number, height: number, side = DETECT_SIDE): { width: number; height: number } {
  const r = Math.min(1, side / Math.max(width, height, 1));
  return {
    width: Math.max(32, Math.round((width * r) / 32) * 32),
    height: Math.max(32, Math.round((height * r) / 32) * 32),
  };
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** RGBA pixels (already at `detectSize`) as the network's input: CHW, normalized. */
export function detectorInput(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Float32Array {
  const n = width * height;
  const out = new Float32Array(3 * n);
  for (let p = 0; p < n; p += 1) {
    for (let c = 0; c < 3; c += 1) out[c * n + p] = (rgba[p * 4 + c]! / 255 - MEAN[c]!) / STD[c]!;
  }
  return out;
}

export interface LineOptions {
  /** A pixel is text above this probability. */
  threshold?: number;
  /** A region is kept when its mean probability is above this. */
  boxThreshold?: number;
  /** How far a region is grown back out: the detector marks a shrunk core of each line. */
  unclip?: number;
}

/**
 * The text regions of the detector's probability map (`width` by `height`),
 * as boxes in the map's own pixels: each connected region of likely text,
 * grown by the share the detector was trained to shrink it by (DB's unclip,
 * area × ratio / perimeter). Bounded: at most 4000 regions.
 */
export function regionsOf(prob: Float32Array, width: number, height: number, options: LineOptions = {}): Box[] {
  const threshold = options.threshold ?? 0.3;
  const boxThreshold = options.boxThreshold ?? 0.5;
  const unclip = options.unclip ?? 1.6;
  const label = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  const boxes: Box[] = [];
  let next = 0;
  for (let start = 0; start < prob.length && boxes.length < 4000; start += 1) {
    if (label[start] !== 0 || prob[start]! <= threshold) continue;
    next += 1;
    let top = 0;
    stack[top++] = start;
    label[start] = next;
    let x0 = width, y0 = height, x1 = -1, y1 = -1, count = 0, sum = 0;
    while (top > 0) {
      const p = stack[--top]!;
      const x = p % width;
      const y = (p - x) / width;
      count += 1;
      sum += prob[p]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      // Four neighbours.
      if (x > 0 && label[p - 1] === 0 && prob[p - 1]! > threshold) { label[p - 1] = next; stack[top++] = p - 1; }
      if (x < width - 1 && label[p + 1] === 0 && prob[p + 1]! > threshold) { label[p + 1] = next; stack[top++] = p + 1; }
      if (y > 0 && label[p - width] === 0 && prob[p - width]! > threshold) { label[p - width] = next; stack[top++] = p - width; }
      if (y < height - 1 && label[p + width] === 0 && prob[p + width]! > threshold) { label[p + width] = next; stack[top++] = p + width; }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (count < 6 || Math.min(w, h) < 3 || sum / count < boxThreshold) continue;
    const grow = (count * unclip) / (2 * (w + h));
    boxes.push([
      Math.max(0, x0 - grow),
      Math.max(0, y0 - grow),
      Math.min(width, x1 + 1 + grow),
      Math.min(height, y1 + 1 + grow),
    ]);
  }
  return boxes;
}

/** `boxes` in the detector's pixels, in the page's. */
export function scaleBoxes(boxes: readonly Box[], sx: number, sy: number): Box[] {
  return boxes.map(([x0, y0, x1, y1]) => [x0 * sx, y0 * sy, x1 * sx, y1 * sy]);
}

/**
 * The boxes in reading order: lines from the top, boxes sharing a line (their
 * middles within half a line's height) from the right for Arabic, from the
 * left otherwise. A box taller than it is wide (a lone letter, a stroke of a
 * stamp) is left in: Tesseract says when it holds nothing.
 */
export function readingOrder(boxes: readonly Box[], rightToLeft = true): Box[] {
  const sorted = [...boxes].sort((a, b) => a[1] + a[3] - (b[1] + b[3]));
  const lines: { mid: number; boxes: Box[] }[] = [];
  for (const box of sorted) {
    const mid = (box[1] + box[3]) / 2;
    const line = lines[lines.length - 1];
    if (line && Math.abs(mid - line.mid) < 0.5 * (box[3] - box[1])) line.boxes.push(box);
    else lines.push({ mid, boxes: [box] });
  }
  return lines.flatMap((line) => line.boxes.sort((a, b) => (rightToLeft ? b[2] - a[2] : a[0] - b[0])));
}

/** A line, grey, row by row: 0 black, 255 white. */
export interface GreyLine {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * A line's light evened out: each pixel divided by the paper's brightness
 * around it — the brightest pixel within a line's height to either side,
 * taken across the line's whole height — so a shadow or a fold's darkening
 * becomes white paper and the ink stays dark. Changed in place.
 */
export function flattenLine(line: GreyLine): void {
  const { width, height, data } = line;
  if (width === 0 || height === 0) return;
  // The brightest pixel of each column.
  const column = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) {
    let max = 0;
    for (let y = 0; y < height; y += 1) max = Math.max(max, data[y * width + x]!);
    column[x] = max;
  }
  // The brightest column within `reach` either side (van Herk / Gil-Werman, linear).
  const reach = Math.max(4, height);
  const size = 2 * reach + 1;
  const left = new Uint8Array(width);
  const right = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) left[x] = x % size === 0 ? column[x]! : Math.max(left[x - 1]!, column[x]!);
  for (let x = width - 1; x >= 0; x -= 1)
    right[x] = x === width - 1 || (x + 1) % size === 0 ? column[x]! : Math.max(right[x + 1]!, column[x]!);
  const paper = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) {
    const a = Math.max(0, x - reach);
    const b = Math.min(width - 1, x + reach);
    paper[x] = Math.max(right[a]!, left[b]!);
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const bright = Math.max(paper[x]!, 1);
      data[p] = Math.min(255, Math.round((data[p]! * 255) / bright));
    }
  }
}

/** Each line's height on the sheet Tesseract reads, the white between lines, and the margin. */
export const SHEET_LINE = 64;
export const SHEET_GAP = 30;
export const SHEET_MARGIN = 20;
/** No line is drawn wider than this on the sheet; a longer one is drawn smaller. */
const SHEET_MAX_WIDTH = 6000;

/** Where a line of the page went on the sheet. */
export interface Placement {
  /** The line's box on the page. */
  box: Box;
  /** Its top-left on the sheet, and the scale from page pixels to sheet pixels. */
  x: number;
  y: number;
  scale: number;
  width: number;
}

/**
 * The lines of `page` (grey, in page pixels) cut out, each evened out
 * (`flattenLine`), scaled to one height and stacked right-aligned with white
 * between them: one picture Tesseract reads in one go, each line where its
 * own layout analysis cannot lose or merge it.
 */
export function buildSheet(page: GreyLine, boxes: readonly Box[]): { sheet: GreyLine; placements: Placement[] } {
  const cuts: { box: Box; line: GreyLine; scale: number; width: number }[] = [];
  for (const raw of boxes) {
    const x0 = Math.max(0, Math.floor(raw[0]));
    const y0 = Math.max(0, Math.floor(raw[1]));
    const x1 = Math.min(page.width, Math.ceil(raw[2]));
    const y1 = Math.min(page.height, Math.ceil(raw[3]));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 2 || h < 2) continue;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) data.set(page.data.subarray((y0 + y) * page.width + x0, (y0 + y) * page.width + x1), y * w);
    const line = { width: w, height: h, data };
    flattenLine(line);
    const scale = Math.min(SHEET_LINE / h, SHEET_MAX_WIDTH / w);
    cuts.push({ box: [x0, y0, x1, y1], line, scale, width: Math.max(1, Math.round(w * scale)) });
  }
  const width = Math.max(1, ...cuts.map((c) => c.width)) + 2 * SHEET_MARGIN;
  const height = SHEET_MARGIN * 2 + cuts.length * (SHEET_LINE + SHEET_GAP);
  const data = new Uint8Array(width * height).fill(255);
  const placements: Placement[] = [];
  cuts.forEach((cut, k) => {
    const lineHeight = Math.max(1, Math.round(cut.line.height * cut.scale));
    const x = width - SHEET_MARGIN - cut.width;
    const y = SHEET_MARGIN + k * (SHEET_LINE + SHEET_GAP) + Math.floor((SHEET_LINE - lineHeight) / 2);
    drawScaled(cut.line, data, width, x, y, cut.width, lineHeight);
    placements.push({ box: cut.box, x, y, scale: cut.scale, width: cut.width });
  });
  return { sheet: { width, height, data }, placements };
}

/** `line` drawn into `into` (row width `stride`) at `x, y`, `w` by `h`, bilinear. */
function drawScaled(line: GreyLine, into: Uint8Array, stride: number, x: number, y: number, w: number, h: number): void {
  const sx = line.width / w;
  const sy = line.height / h;
  for (let j = 0; j < h; j += 1) {
    const fy = Math.max(0, (j + 0.5) * sy - 0.5);
    const y0 = Math.min(line.height - 1, Math.floor(fy));
    const y1 = Math.min(line.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let i = 0; i < w; i += 1) {
      const fx = Math.max(0, (i + 0.5) * sx - 0.5);
      const x0 = Math.min(line.width - 1, Math.floor(fx));
      const x1 = Math.min(line.width - 1, x0 + 1);
      const tx = fx - x0;
      const at = (xx: number, yy: number) => line.data[yy * line.width + xx]!;
      into[(y + j) * stride + x + i] = Math.round(
        (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty,
      );
    }
  }
}

/**
 * A word read off the sheet, back on the page: the line it sits on is the
 * one whose band holds the word's middle; its box is turned back from the
 * sheet's scale to the page's pixels. `null` for a word between lines.
 */
export function toPage(bbox: Box, placements: readonly Placement[]): Box | null {
  const k = sheetLine(bbox);
  const place = placements[k];
  if (!place) return null;
  const [bx0, by0, bx1, by1] = place.box;
  const px = (v: number) => Math.min(bx1, Math.max(bx0, bx0 + (v - place.x) / place.scale));
  return [px(bbox[0]), by0, px(bbox[2]), by1];
}

/** The sheet line a box read off the sheet sits on, by its middle. */
export function sheetLine(bbox: Box): number {
  const mid = (bbox[1] + bbox[3]) / 2;
  return Math.floor((mid - SHEET_MARGIN + SHEET_GAP / 2) / (SHEET_LINE + SHEET_GAP));
}

/** A word as read, before the spaces are put in: its line on the page counts from 0. */
export interface LineWord {
  text: string;
  box: Box;
  confidence: number;
  line: number;
}

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN = /[A-Za-z]/;

/**
 * A word the Arabic model was unsure of — the shape of English it tried to
 * read as Arabic comes back with a confidence near nothing, while Arabic it
 * reads comes back at 85–96 (measured on the corpus's invoice and a report).
 */
export function doubtful(word: LineWord): boolean {
  return word.confidence < 50 && !(ARABIC.test(word.text) && word.confidence >= 30);
}

/**
 * The English model's reading put in place of the Arabic model's doubtful
 * words: an English word read with confidence (70 or more, with a Latin
 * letter in it) replaces the doubtful words it covers on its line. Reading
 * a page with Arabic and English together let English win on Arabic words
 * and filled Arabic pages with English nonsense ("gull", "LIA"); this way
 * English is only asked where Arabic failed.
 */
export function mergeEnglish(arabic: readonly LineWord[], english: readonly LineWord[]): LineWord[] {
  const out = [...arabic];
  for (const word of english) {
    if (word.confidence < 70 || !LATIN.test(word.text)) continue;
    const covered = out.filter(
      (w) => w.line === word.line && doubtful(w) && overlap(w.box, word.box) > 0.5 * Math.min(w.box[2] - w.box[0], word.box[2] - word.box[0]),
    );
    if (covered.length === 0) continue;
    const at = out.indexOf(covered[0]!);
    for (const w of covered) out.splice(out.indexOf(w), 1);
    out.splice(Math.min(at, out.length), 0, word);
  }
  return out;
}

function overlap(a: Box, b: Box): number {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
}

/** A grey picture as a binary PGM, which Tesseract's image library reads as it is. */
export function toPgm(grey: GreyLine): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${grey.width} ${grey.height}\n255\n`);
  const out = new Uint8Array(header.length + grey.data.length);
  out.set(header, 0);
  out.set(grey.data, header.length);
  return out;
}
