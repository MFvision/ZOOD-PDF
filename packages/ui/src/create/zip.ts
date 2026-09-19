import { strFromU8, unzipSync } from 'fflate';

/**
 * The parts of an Office file (a zip), read with limits: a part larger than
 * this once inflated is not read at all, so a hostile file cannot fill the
 * memory, and parts the caller did not ask for are never inflated.
 */
const MAX_PART = 96 * 1024 * 1024;

export type Parts = Record<string, Uint8Array>;

export function readParts(bytes: Uint8Array, wanted: (name: string) => boolean): Parts {
  return unzipSync(bytes, {
    filter: (file) => file.originalSize <= MAX_PART && wanted(file.name),
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
