/**
 * Scan & OCR image preprocessing (ADR 0016). Pure functions on 8-bit grayscale images; they run in
 * `preprocess.worker.ts`, never on the UI thread. Every loop is bounded by the pixel count, and
 * images above {@link MAX_PIXELS} are refused before any allocation.
 *
 * Conventions: y grows downwards; a positive angle is a COUNTER-CLOCKWISE rotation of the content
 * as seen on screen (Pillow's `rotate(8)` makes a page "crooked 8°", which `detectSkew` reports as 8).
 */

export interface Gray {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Point {
  x: number;
  y: number;
}

/** Largest side accepted anywhere in the pipeline (pixels). */
export const MAX_SIDE = 16_000;
/** Largest image accepted (pixels): 64 MP — an A3 page at 400 dpi. */
export const MAX_PIXELS = 64_000_000;

export class ImageTooLargeError extends Error {
  constructor(width: number, height: number) {
    super(`image too large (${width}×${height})`);
    this.name = 'ImageTooLargeError';
  }
}

export function checkSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new ImageTooLargeError(width, height);
  }
}

export function gray(width: number, height: number, fill = 0): Gray {
  checkSize(width, height);
  const data = new Uint8Array(width * height);
  if (fill) data.fill(fill);
  return { width, height, data };
}

/** RGBA → gray with Rec. 601 luma weights (alpha ignored: scans are opaque). */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const out = gray(width, height);
  const n = width * height;
  if (rgba.length < n * 4) throw new Error('RGBA buffer too short');
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out.data[i] = (rgba[j]! * 299 + rgba[j + 1]! * 587 + rgba[j + 2]! * 114 + 500) / 1000;
  }
  return out;
}

/** Gray → RGBA (for canvas previews). */
export function toRgba(g: Gray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0, j = 0; i < g.data.length; i++, j += 4) {
    const v = g.data[i]!;
    out[j] = v;
    out[j + 1] = v;
    out[j + 2] = v;
    out[j + 3] = 255;
  }
  return out;
}

function bilinear(src: Gray, x: number, y: number, fill: number): number {
  const { width: w, height: h, data } = src;
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) return fill;
  const cx = Math.min(Math.max(x, 0), w - 1);
  const cy = Math.min(Math.max(y, 0), h - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = data[y0 * w + x0]!;
  const b = data[y0 * w + x1]!;
  const c = data[y1 * w + x0]!;
  const d = data[y1 * w + x1]!;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Rotates the content counter-clockwise by `degrees` about the centre (same canvas, bilinear). */
export function rotate(src: Gray, degrees: number, fill = 255): Gray {
  const { width: w, height: h } = src;
  const out = gray(w, h);
  const t = (degrees * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  let i = 0;
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < w; x++, i++) {
      const dx = x - cx;
      // inverse of the forward map x' = cx + dx·cos + dy·sin, y' = cy − dx·sin + dy·cos
      const sx = cx + dx * cos - dy * sin;
      const sy = cy + dx * sin + dy * cos;
      out.data[i] = Math.round(bilinear(src, sx, sy, fill));
    }
  }
  return out;
}

export interface SkewOptions {
  /** Search range in degrees (±). */
  maxAngle?: number;
}

/**
 * Skew of the text lines by projection profile: for each candidate angle the dark pixels are
 * projected onto the line normal and the angle whose histogram has the largest variance (sharpest
 * line/gap alternation) wins. Coarse-to-fine: 0.5° → 0.05° → 0.01°.
 */
export function detectSkew(bin: Gray, opts: SkewOptions = {}): number {
  const maxAngle = Math.min(Math.abs(opts.maxAngle ?? 15), 45);
  const { width: w, height: h, data } = bin;
  const step = Math.max(1, Math.round(Math.max(w, h) / 1600));
  const xs: number[] = [];
  const ys: number[] = [];
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (data[y * w + x]! < 128) {
        xs.push(x - cx);
        ys.push(y - cy);
      }
    }
  }
  // Bound the work: keep at most ~400k points (evenly thinned).
  const n0 = xs.length;
  if (n0 < 30) return 0;
  const thin = Math.max(1, Math.ceil(n0 / 400_000));
  const px = new Float64Array(Math.ceil(n0 / thin));
  const py = new Float64Array(px.length);
  for (let i = 0, k = 0; i < n0 && k < px.length; i += thin, k++) {
    px[k] = xs[i]!;
    py[k] = ys[i]!;
  }
  const half = Math.hypot(w, h) / 2 / step + 2;
  const bins = new Int32Array(Math.ceil(half * 2) + 2);
  const score = (deg: number): number => {
    const t = (deg * Math.PI) / 180;
    const s = Math.sin(t) / step;
    const c = Math.cos(t) / step;
    bins.fill(0);
    for (let k = 0; k < px.length; k++) {
      const r = Math.floor(px[k]! * s + py[k]! * c + half);
      if (r >= 0 && r < bins.length) bins[r]!++;
    }
    let sum = 0;
    for (let b = 0; b < bins.length; b++) sum += bins[b]! * bins[b]!;
    return sum;
  };
  const search = (from: number, to: number, inc: number, best: number): number => {
    let bestScore = -1;
    const n = Math.round((to - from) / inc);
    for (let i = 0; i <= n; i++) {
      const a = Math.max(-maxAngle, Math.min(maxAngle, from + i * inc));
      const v = score(a);
      if (v > bestScore) {
        bestScore = v;
        best = a;
      }
    }
    return best;
  };
  let best = search(-maxAngle, maxAngle, 0.5, 0);
  best = search(best - 0.6, best + 0.6, 0.05, best);
  best = search(best - 0.06, best + 0.06, 0.01, best);
  const rounded = Math.round(best * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Sliding-window max (dilation) or min (erosion) with radius r along rows then columns. */
function morph(src: Gray, r: number, max: boolean): Gray {
  const { width: w, height: h } = src;
  const tmp = new Uint8Array(w * h);
  const out = gray(w, h);
  const pick = max ? Math.max : Math.min;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = src.data[y * w + x]!;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src.data[y * w + k]!);
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x]!;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]!);
      out.data[y * w + x] = v;
    }
  }
  return out;
}

function boxBlur(src: Gray, r: number): Gray {
  const { width: w, height: h } = src;
  const tmp = new Float64Array(w * h);
  const out = gray(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++, n++) s += src.data[y * w + k]!;
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++, n++) s += tmp[k * w + x]!;
      out.data[y * w + x] = Math.round(s / n);
    }
  }
  return out;
}

export interface DpiOptions {
  dpi?: number;
}

/**
 * Shadow flattening: estimates the paper (background) brightness with a large-kernel grayscale
 * closing on a block-max reduced image, blurs it, and divides the page by it.
 */
export function flattenShadow(src: Gray, opts: DpiOptions = {}): Gray {
  const dpi = opts.dpi ?? 300;
  const { width: w, height: h } = src;
  const b = Math.max(2, Math.round((8 * dpi) / 300));
  const sw = Math.ceil(w / b);
  const sh = Math.ceil(h / b);
  const small = gray(sw, sh);
  for (let by = 0; by < sh; by++) {
    for (let bx = 0; bx < sw; bx++) {
      let v = 0;
      for (let y = by * b; y < Math.min(h, by * b + b); y++)
        for (let x = bx * b; x < Math.min(w, bx * b + b); x++) v = Math.max(v, src.data[y * w + x]!);
      small.data[by * sw + bx] = v;
    }
  }
  const r = Math.max(1, Math.round((4 * dpi) / 300));
  const closed = morph(morph(small, r, true), r, false);
  const bg = boxBlur(boxBlur(closed, 2), 2);
  const out = gray(w, h);
  let i = 0;
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) / b - 0.5;
    for (let x = 0; x < w; x++, i++) {
      const back = Math.max(1, bilinear(bg, (x + 0.5) / b - 0.5, sy, 255));
      const v = (src.data[i]! * 255) / back;
      out.data[i] = v >= 255 ? 255 : Math.round(v);
    }
  }
  return out;
}

export interface SauvolaOptions extends DpiOptions {
  /** Odd window size in pixels (default 31 at 300 dpi, scaled with dpi). */
  window?: number;
  /** Sensitivity k (default 0.3). */
  k?: number;
  /** Dynamic range of the standard deviation (default 128). */
  r?: number;
}

/**
 * Sauvola binarisation: T = m·(1 + k·(s/R − 1)) over a window, with windowed sums kept as running
 * column/row sums (the integral-image method with O(width) memory instead of two full-page tables).
 * Returns a 0/255 image.
 */
export function sauvola(src: Gray, opts: SauvolaOptions = {}): Gray {
  const dpi = opts.dpi ?? 300;
  let win = opts.window ?? Math.round((31 * dpi) / 300);
  win = Math.max(11, Math.min(101, win | 1));
  const rad = win >> 1;
  const k = opts.k ?? 0.3;
  const R = opts.r ?? 128;
  const { width: w, height: h, data } = src;
  const out = gray(w, h);
  const colSum = new Float64Array(w);
  const colSq = new Float64Array(w);
  // rows [top, bottom] currently summed into the column sums
  let top = 0;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    const wantTop = Math.max(0, y - rad);
    const wantBottom = Math.min(h - 1, y + rad);
    while (bottom < wantBottom) {
      bottom++;
      const o = bottom * w;
      for (let x = 0; x < w; x++) {
        const v = data[o + x]!;
        colSum[x] = colSum[x]! + v;
        colSq[x] = colSq[x]! + v * v;
      }
    }
    while (top < wantTop) {
      const o = top * w;
      for (let x = 0; x < w; x++) {
        const v = data[o + x]!;
        colSum[x] = colSum[x]! - v;
        colSq[x] = colSq[x]! - v * v;
      }
      top++;
    }
    const rows = bottom - top + 1;
    let s = 0;
    let q = 0;
    let left = 0;
    let right = -1;
    for (let x = 0; x < w; x++) {
      const wantLeft = Math.max(0, x - rad);
      const wantRight = Math.min(w - 1, x + rad);
      while (right < wantRight) {
        right++;
        s += colSum[right]!;
        q += colSq[right]!;
      }
      while (left < wantLeft) {
        s -= colSum[left]!;
        q -= colSq[left]!;
        left++;
      }
      const n = rows * (right - left + 1);
      const m = s / n;
      const sd = Math.sqrt(Math.max(0, q / n - m * m));
      const t = m * (1 + k * (sd / R - 1));
      out.data[y * w + x] = data[y * w + x]! <= t ? 0 : 255;
    }
  }
  return out;
}

/** Removes 8-connected dark components smaller than `minArea` pixels (bounded: one pass). */
export function despeckle(bin: Gray, minArea: number): { image: Gray; removed: number } {
  const { width: w, height: h } = bin;
  const out: Gray = { width: w, height: h, data: bin.data.slice() };
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const comp: number[] = [];
  let removed = 0;
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || out.data[start]! >= 128) continue;
    seen[start] = 1;
    stack.push(start);
    comp.length = 0;
    while (stack.length) {
      const p = stack.pop()!;
      if (comp.length < minArea) comp.push(p);
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue;
          const q = ny * w + nx;
          if (!seen[q] && out.data[q]! < 128) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
      if (comp.length >= minArea && stack.length === 0) break;
    }
    if (comp.length < minArea) {
      for (const p of comp) out.data[p] = 255;
      removed++;
    }
  }
  return { image: out, removed };
}

/**
 * Homography mapping the output rectangle (0,0)–(w,0)–(w,h)–(0,h) onto `quad` (clockwise from
 * top-left). Returns h0…h7 with h8 = 1.
 */
export function homography(w: number, h: number, quad: readonly Point[]): Float64Array {
  if (quad.length !== 4) throw new Error('need 4 corners');
  const src: [number, number][] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]!;
    const { x: u, y: v } = quad[i]!;
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  // Gaussian elimination with partial pivoting (8×8).
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    if (Math.abs(A[p]![c]!) < 1e-12) throw new Error('degenerate corners');
    [A[c], A[p]] = [A[p]!, A[c]!];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let k = c; k < 9; k++) A[r]![k]! -= f * A[c]![k]!;
    }
  }
  const out = new Float64Array(8);
  for (let i = 0; i < 8; i++) out[i] = A[i]![8]! / A[i]![i]!;
  return out;
}

/** Output size for a quad: the longer of each pair of opposite edges. */
export function quadSize(quad: readonly Point[]): { width: number; height: number } {
  const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const [a, b, c, e] = quad as [Point, Point, Point, Point];
  let width = Math.max(1, Math.round(Math.max(d(a, b), d(e, c))));
  let height = Math.max(1, Math.round(Math.max(d(a, e), d(b, c))));
  const scale = Math.min(1, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
  width = Math.max(1, Math.floor(width * scale));
  height = Math.max(1, Math.floor(height * scale));
  return { width, height };
}

/** Perspective correction: the quad (clockwise from top-left) becomes an upright rectangle. */
export function warpPerspective(src: Gray, quad: readonly Point[], size = quadSize(quad)): Gray {
  const { width: W, height: H } = size;
  const out = gray(W, H);
  const m = homography(W, H, quad);
  let i = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const d = m[6]! * x + m[7]! * y + 1;
      const u = (m[0]! * x + m[1]! * y + m[2]!) / d;
      const v = (m[3]! * x + m[4]! * y + m[5]!) / d;
      out.data[i] = Math.round(bilinear(src, u, v, 255));
    }
  }
  return out;
}

/** Box-filter downscale by an integer factor (camera photos larger than needed). */
export function downscale(src: Gray, factor: number): Gray {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return src;
  const w = Math.max(1, Math.floor(src.width / f));
  const h = Math.max(1, Math.floor(src.height / f));
  const out = gray(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) s += src.data[(y * f + yy) * src.width + x * f + xx]!;
      out.data[y * w + x] = Math.round(s / (f * f));
    }
  return out;
}

export interface PreprocessOptions {
  dpi: number;
  deskew: boolean;
  flatten: boolean;
  binarise: boolean;
  despeckle: boolean;
}

export interface Preprocessed {
  image: Gray;
  /** Detected skew of the input (degrees, counter-clockwise), measured even when not corrected. */
  angle: number;
  /** Whether `image` was rotated by −angle. */
  deskewed: boolean;
  specks: number;
}

export function preprocess(src: Gray, o: PreprocessOptions): Preprocessed {
  let work = src;
  if (o.flatten) work = flattenShadow(work, { dpi: o.dpi });
  const angle = detectSkew(sauvola(work, { dpi: o.dpi }));
  const deskewed = o.deskew && Math.abs(angle) >= 0.05;
  if (deskewed) work = rotate(work, -angle);
  let specks = 0;
  if (o.binarise) {
    work = sauvola(work, { dpi: o.dpi });
    if (o.despeckle) {
      const min = Math.max(2, Math.round(4 * (o.dpi / 300) ** 2));
      const r = despeckle(work, min);
      work = r.image;
      specks = r.removed;
    }
  }
  return { image: work, angle, deskewed, specks };
}

export type ImageType = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp';

/** Reads image dimensions from the header (so oversized images are refused before decoding). */
export function imageSize(b: Uint8Array): { type: ImageType; width: number; height: number } | null {
  const u16be = (i: number) => (i + 2 <= b.length ? (b[i]! << 8) | b[i + 1]! : -1);
  const u32be = (i: number) => (i + 4 <= b.length ? ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]! : -1);
  const u16le = (i: number) => (i + 2 <= b.length ? b[i]! | (b[i + 1]! << 8) : -1);
  const i32le = (i: number) => (i + 4 <= b.length ? b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24) : NaN);
  const ok = (type: ImageType, width: number, height: number) => (width > 0 && height > 0 ? { type, width, height } : null);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ok('png', u32be(16), u32be(20));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    for (let n = 0; n < 4096 && i + 4 <= b.length; n++) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      i += 2;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9 || marker === 0xda) return null;
      const len = u16be(i);
      if (len < 2) return null;
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return i + 7 <= b.length ? ok('jpeg', u16be(i + 5), u16be(i + 3)) : null;
      i += len;
    }
    return null;
  }
  const ascii = (i: number, s: string) => s.split('').every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8 ')) return ok('webp', u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (ascii(12, 'VP8L')) {
      const v = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
      return ok('webp', (v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1);
    }
    if (ascii(12, 'VP8X')) return ok('webp', 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)));
    return null;
  }
  if (b.length >= 10 && ascii(0, 'GIF8')) return ok('gif', u16le(6), u16le(8));
  if (b.length >= 26 && ascii(0, 'BM')) return ok('bmp', Math.abs(i32le(18)), Math.abs(i32le(22)));
  return null;
}

/** Binary PGM (P5), which the recogniser (Leptonica) reads without a decoder round trip. */
export function toPgm(g: Gray): Uint8Array {
  const head = new TextEncoder().encode(`P5\n${g.width} ${g.height}\n255\n`);
  const out = new Uint8Array(head.length + g.data.length);
  out.set(head, 0);
  out.set(g.data, head.length);
  return out;
}
