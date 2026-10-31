/**
 * A picture's width and height as its header says, read without decoding
 * it: PNG, JPEG, GIF, BMP, WebP, TIFF, and the ISO formats (HEIC, HEIF,
 * AVIF). A browser decodes the whole picture before anyone can ask how large
 * it is, so a file of a few kilobytes whose header says 65,535 × 65,535 asks
 * it for 17 gigabytes; this is asked first. Null where the header cannot
 * tell (the picture is then decoded as before).
 */

export interface PictureSize {
  width: number;
  height: number;
}

/** The most pixels a picture is decoded with here: as for pictures the core reads. */
export const MAX_DECODED_PIXELS = 40_000_000;

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

export function pictureSize(bytes: Uint8Array): PictureSize | null {
  try {
    return readSize(bytes);
  } catch {
    // A header cut short: it says nothing.
    return null;
  }
}

function readSize(bytes: Uint8Array): PictureSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (at: number, length: number) => at >= 0 && at + length <= bytes.length;
  // PNG: IHDR is the first chunk.
  if (has(0, 24) && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && ascii(bytes, 12, 4) === 'IHDR') {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (has(0, 10) && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (has(0, 26) && ascii(bytes, 0, 2) === 'BM') {
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  if (has(0, 30) && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const kind = ascii(bytes, 12, 4);
    const u24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
    if (kind === 'VP8X') return { width: 1 + u24(24), height: 1 + u24(27) };
    if (kind === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (kind === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    return null;
  }
  if (has(0, 4) && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes, view);
  if (has(0, 8) && ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d))) return tiffSize(bytes, view);
  if (has(4, 8) && ascii(bytes, 4, 4) === 'ftyp') return isoSize(bytes, view);
  return null;
}

/** JPEG: the first start-of-frame marker, walking the segments by their lengths. */
function jpegSize(bytes: Uint8Array, view: DataView): PictureSize | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = view.getUint16(at + 2);
    // Every start of frame but DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/** TIFF: the largest page among the first few, by their width and length tags. */
function tiffSize(bytes: Uint8Array, view: DataView): PictureSize | null {
  const little = bytes[0] === 0x49;
  if (view.getUint16(2, little) !== 42) return null;
  let offset = view.getUint32(4, little);
  let best: PictureSize | null = null;
  for (let page = 0; page < 64 && offset > 0 && offset + 2 <= bytes.length; page += 1) {
    const count = view.getUint16(offset, little);
    let width = 0;
    let height = 0;
    for (let k = 0; k < count; k += 1) {
      const entry = offset + 2 + k * 12;
      if (entry + 12 > bytes.length) break;
      const tag = view.getUint16(entry, little);
      const type = view.getUint16(entry + 2, little);
      const value = type === 3 ? view.getUint16(entry + 8, little) : view.getUint32(entry + 8, little);
      if (tag === 256) width = value;
      else if (tag === 257) height = value;
    }
    if (!best || width * height > best.width * best.height) best = { width, height };
    const next = offset + 2 + count * 12;
    offset = next + 4 <= bytes.length ? view.getUint32(next, little) : 0;
  }
  return best;
}

/** HEIC, HEIF, AVIF: the largest `ispe` (image spatial extent) property in the first megabyte. */
function isoSize(bytes: Uint8Array, view: DataView): PictureSize | null {
  let best: PictureSize | null = null;
  // 'ispe', its version and flags, then the width and height.
  const end = Math.min(bytes.length - 16, 1 << 20);
  for (let at = 4; at <= end; at += 1) {
    if (bytes[at] !== 0x69 || bytes[at + 1] !== 0x73 || bytes[at + 2] !== 0x70 || bytes[at + 3] !== 0x65) continue;
    const size = { width: view.getUint32(at + 8), height: view.getUint32(at + 12) };
    if (!best || size.width * size.height > best.width * best.height) best = size;
  }
  return best;
}

/** Whether a picture's header says it is too large to decode here. */
export function tooManyPixels(bytes: Uint8Array, max = MAX_DECODED_PIXELS): boolean {
  const size = pictureSize(bytes);
  return size !== null && size.width * size.height > max;
}
