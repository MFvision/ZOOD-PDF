// Which page of the sample PDFs is on screen, read from a screenshot: each
// page is filled with its own colour (pdfs.mjs), so the colour that covers
// most of the document view is the page a person sees.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PAGE_COLORS } from './pdfs.mjs';

/** An 8-bit, non-interlaced RGB or RGBA PNG (what screencapture and System.Drawing write), as pixels. */
export function readPng(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let at = 8;
  let header = null;
  const data = [];
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const kind = buffer.toString('latin1', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], type: body[9], interlace: body[12] };
    else if (kind === 'IDAT') data.push(body);
    else if (kind === 'IEND') break;
    at += 12 + length;
  }
  if (!header || header.depth !== 8 || header.interlace !== 0 || (header.type !== 2 && header.type !== 6)) {
    throw new Error(`a PNG this check does not read (${JSON.stringify(header)})`);
  }
  const { width, height } = header;
  const channels = header.type === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length < height * (stride + 1)) throw new Error('the PNG is cut short');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const row = y * stride;
    const above = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels] : 0;
      const b = y > 0 ? pixels[above + x] : 0;
      const c = y > 0 && x >= channels ? pixels[above + x - channels] : 0;
      let value = raw[line + x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`PNG filter ${filter}`);
      pixels[row + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** How far a colour may drift (screen colour handling) and still be that page's. */
const NEAR = 40;

/**
 * The page whose colour covers most of `area` (fractions of the screen:
 * left, top, right, bottom), with its share of the area; null when no page
 * colour covers at least a fifth of it (nothing drawn yet, or a window over it).
 */
export function pageOnScreen(file, area = [0.12, 0.25, 0.7, 0.88]) {
  const { width, height, channels, pixels } = readPng(readFileSync(file));
  const counts = new Array(PAGE_COLORS.length).fill(0);
  let sampled = 0;
  const [left, top, right, bottom] = [area[0] * width, area[1] * height, area[2] * width, area[3] * height].map(Math.round);
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      const at = (y * width + x) * channels;
      const r = pixels[at];
      const g = pixels[at + 1];
      const b = pixels[at + 2];
      sampled++;
      for (let n = 0; n < PAGE_COLORS.length; n++) {
        const [pr, pg, pb] = PAGE_COLORS[n];
        if (Math.abs(r - pr) <= NEAR && Math.abs(g - pg) <= NEAR && Math.abs(b - pb) <= NEAR) {
          counts[n]++;
          break;
        }
      }
    }
  }
  const ranked = counts.map((count, n) => ({ page: n + 1, share: sampled ? count / sampled : 0 })).sort((x, y) => y.share - x.share);
  const best = ranked[0];
  const seen = ranked.filter((one) => one.share >= 0.01).map((one) => `page ${one.page} ${Math.round(one.share * 100)}%`).join(', ') || 'no page colour';
  return { page: best.share >= 0.2 ? best.page : null, share: best.share, seen, size: `${width}x${height}` };
}
