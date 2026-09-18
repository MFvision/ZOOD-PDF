import { zipSync, zlibSync } from 'fflate';
import type { Zippable } from 'fflate';

/**
 * PNG, written here rather than by a canvas: the same code runs in every host
 * (browser, extension, desktop webview) and in the unit tests, and a page of
 * text takes about a tenth of a second at 300 dpi.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | null = null;

/** CRC-32 (ISO 3309), the checksum every PNG chunk ends with. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** True when every pixel is a shade of grey: a page of text, most often. */
function isGrey(rgba: Uint8Array | Uint8ClampedArray, pixels: number): boolean {
  for (let p = 0; p < pixels * 4; p += 4) {
    if (rgba[p] !== rgba[p + 1] || rgba[p] !== rgba[p + 2]) return false;
  }
  return true;
}

/**
 * A PNG of an RGBA bitmap as the core renders it (premultiplied, already over
 * white). Grey pages are written as greyscale, a third of the size; `dpi`, when
 * given, is recorded so image viewers print the page at its real size.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, dpi?: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`E_PNG: no image of ${width} by ${height}`);
  }
  if (rgba.length < width * height * 4) throw new Error('E_PNG: the bitmap is shorter than its size');
  const grey = isGrey(rgba, width * height);
  const channels = grey ? 1 : 3;
  const stride = width * channels + 1;
  // Filter type 0 on every row: for pages, as small as the adaptive filters and faster.
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    let o = y * stride + 1;
    let p = y * width * 4;
    for (let x = 0; x < width; x += 1, p += 4) {
      // Premultiplied over white: whatever alpha leaves uncovered is white.
      // The core's pages are opaque, so this is almost always a plain copy.
      const clear = 255 - rgba[p + 3]!;
      if (clear === 0) {
        raw[o++] = rgba[p]!;
        if (!grey) {
          raw[o++] = rgba[p + 1]!;
          raw[o++] = rgba[p + 2]!;
        }
      } else {
        raw[o++] = Math.min(255, rgba[p]! + clear);
        if (!grey) {
          raw[o++] = Math.min(255, rgba[p + 1]! + clear);
          raw[o++] = Math.min(255, rgba[p + 2]! + clear);
        }
      }
    }
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bits per channel
  header[9] = grey ? 0 : 2; // greyscale, or RGB
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', header)];
  if (dpi !== undefined && dpi > 0) {
    const physical = new Uint8Array(9);
    const perMetre = Math.round(dpi / 0.0254);
    const physicalView = new DataView(physical.buffer);
    physicalView.setUint32(0, perMetre);
    physicalView.setUint32(4, perMetre);
    physical[8] = 1; // the unit is the metre
    parts.push(chunk('pHYs', physical));
  }
  parts.push(chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Page images in one zip, in page order. PNGs are compressed already, so they are stored. */
export function zipImages(images: readonly { name: string; bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const files: Zippable = {};
  for (const image of images) files[image.name] = [image.bytes, { level: 0 }];
  return zipSync(files);
}
