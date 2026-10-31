import { strFromU8, unzipSync } from 'fflate';

/**
 * The parts of an Office file (a zip), read with limits, so that a small
 * hostile file (a "zip bomb") cannot fill the memory: a part larger than
 * `MAX_PART` once inflated is not read, nor more than `MAX_TOTAL` of parts
 * in all, and parts the caller did not ask for are never inflated. The sizes
 * are the ones the zip declares; a part that lies about its size is cut to
 * it when inflated, never grown past it.
 */
const MAX_PART = 96 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;

export type Parts = Record<string, Uint8Array>;

/** A document too large to read here: its text parts alone are past the limits. */
export class TooLargeError extends Error {
  readonly code = 'E_TOO_LARGE';
  constructor() {
    super('E_TOO_LARGE: the file is too large to read once uncompressed');
  }
}

/** The names and declared sizes of a zip's entries, without inflating any of them. */
export function zipEntries(bytes: Uint8Array): { name: string; size: number }[] {
  const entries: { name: string; size: number }[] = [];
  unzipSync(bytes, {
    filter: (file) => {
      entries.push({ name: file.name, size: file.originalSize });
      return false;
    },
  });
  return entries;
}

/** Whether a zip has an entry called `name` (nothing is inflated); false for what is no zip. */
export function hasPart(bytes: Uint8Array, name: string): boolean {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  try {
    return zipEntries(bytes).some((entry) => entry.name === name);
  } catch {
    return false;
  }
}

/**
 * The parts `wanted` asks for. `optional` ones — pictures — are taken only
 * while there is room once the others are in, and simply left out past it
 * (the document then counts them as pictures left out). Throws
 * `TooLargeError` when the parts that are not optional do not fit.
 */
export function readParts(bytes: Uint8Array, wanted: (name: string) => boolean, optional: (name: string) => boolean = () => false): Parts {
  const entries = zipEntries(bytes).filter((entry) => wanted(entry.name));
  const take = new Set<string>();
  let total = 0;
  for (const pass of [false, true]) {
    for (const entry of entries) {
      if (optional(entry.name) !== pass || take.has(entry.name)) continue;
      const fits = entry.size <= MAX_PART && total + entry.size <= MAX_TOTAL;
      if (!fits) {
        if (pass) continue;
        throw new TooLargeError();
      }
      total += entry.size;
      take.add(entry.name);
    }
  }
  // A name the zip holds twice is inflated once: the first, as the sizes were counted.
  const seen = new Set<string>();
  return unzipSync(bytes, {
    filter: (file) => {
      if (!take.has(file.name) || seen.has(file.name)) return false;
      seen.add(file.name);
      return true;
    },
  });
}

/** A part as text: UTF-8, or UTF-16 when it starts with a byte-order mark. */
export function partText(parts: Parts, name: string): string | null {
  const bytes = parts[name];
  if (!bytes) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return strFromU8(bytes);
}

/** `word/_rels/document.xml.rels` for `word/document.xml`. */
export function relsPath(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** `media/image1.png` relative to `word/document.xml` is `word/media/image1.png`. */
export function resolvePart(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece !== '.' && piece !== '') parts.push(piece);
  }
  return parts.join('/');
}

/** The media type of a picture part, by its name. */
export function pictureMime(name: string): string {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jpe: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    emf: 'image/emf',
    wmf: 'image/wmf',
    svg: 'image/svg+xml',
  };
  return known[extension] ?? 'application/octet-stream';
}
