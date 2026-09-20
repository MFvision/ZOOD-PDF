import type { LibraryKind } from './ops';

/**
 * What kind of document a file is, from its name. The core tells a PDF with
 * no text from one with text (`guessedKind`), so `scan` is never guessed
 * here: a file named `.pdf` goes in as `pdf` and the core may answer `scan`.
 */
const BY_EXTENSION: Record<string, LibraryKind> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  tif: 'image',
  tiff: 'image',
  webp: 'image',
  heic: 'image',
  heif: 'image',
  bmp: 'image',
  gif: 'image',
  doc: 'word',
  docx: 'word',
  rtf: 'word',
  odt: 'word',
  xls: 'excel',
  xlsx: 'excel',
  csv: 'excel',
  ods: 'excel',
  ppt: 'powerpoint',
  pptx: 'powerpoint',
  odp: 'powerpoint',
  htm: 'html',
  html: 'html',
  xhtml: 'html',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  text: 'text',
  log: 'text',
  xml: 'text',
  json: 'text',
};

/** The extensions the Library offers to read, for the file picker's `accept`. */
export const LIBRARY_ACCEPT = Object.keys(BY_EXTENSION)
  .map((extension) => `.${extension}`)
  .join(',');

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The kind of a file by its name, or null for one the Library does not read. */
export function kindOfName(name: string): LibraryKind | null {
  return BY_EXTENSION[extensionOf(name)] ?? null;
}

/** Files the Library will not try to read at all are left out of a folder's list. */
export function readableFile(name: string): boolean {
  return kindOfName(name) !== null;
}

/**
 * The folder a key belongs to: everything before its last separator, or the
 * empty string for a file chosen on its own. Keys are the host's — a full
 * path on the desktop, `folder id/relative path` in a browser — and both use
 * `/` or `\`, so both are cut.
 */
export function folderOfKey(key: string): string {
  const cut = Math.max(key.lastIndexOf('/'), key.lastIndexOf('\\'));
  return cut > 0 ? key.slice(0, cut) : '';
}
