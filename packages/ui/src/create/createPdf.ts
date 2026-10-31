import { dominantDirection } from './blocks';
import type { Block, ReadDocument, SourcePicture } from './blocks';
import { readCsv } from './csv';
import { documentFaces } from './faces';
import { isDocx, readDocx } from './docx';
import { readHtml } from './html';
import { readMarkdown } from './markdown';
import { isPptx, readPptx } from './pptx';
import { readText } from './text';
import { isXlsx, readXlsx } from './xlsx';
import { TooLargeError } from './zip';

/**
 * Create PDF: files of other kinds made into one new PDF, entirely on this
 * device. Documents — Word, Excel, PowerPoint, web pages, Markdown, text,
 * CSV — are read here into blocks and typeset by the core
 * (`create.document`); pictures go to the core as they are
 * (`create.images`), one to a page; several files become one file in the
 * order given (`pages.combine`).
 */

export type CreateKind = 'docx' | 'xlsx' | 'pptx' | 'html' | 'markdown' | 'text' | 'csv' | 'image';

/** What the file choosers accept, by extension and type. */
export const CREATE_ACCEPT = [
  '.docx', '.xlsx', '.pptx', '.html', '.htm', '.xhtml', '.md', '.markdown', '.txt', '.text', '.csv', '.tsv',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.heic', '.heif', '.avif',
  'image/*', 'text/plain', 'text/html', 'text/markdown', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
].join(',');

/** The extensions the desktop's open panel offers. */
export const CREATE_EXTENSIONS = CREATE_ACCEPT.split(',')
  .filter((e) => e.startsWith('.'))
  .map((e) => e.slice(1));

const startsWith = (bytes: Uint8Array, ...sig: number[]) => sig.every((b, k) => bytes[k] === b);
const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

/** A picture's kind by its first bytes: the ones the core reads, and the ones only a browser may. */
export function pictureKind(bytes: Uint8Array): 'core' | 'browser' | null {
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47)) return 'core';
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return 'core';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'core';
  if (ascii(bytes, 0, 2) === 'BM' && bytes.length > 26) return 'core';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'core';
  if (startsWith(bytes, 0x49, 0x49, 0x2a, 0x00) || startsWith(bytes, 0x4d, 0x4d, 0x00, 0x2a)) return 'core';
  // ISO media (HEIC, HEIF, AVIF): a browser that can draw it may make it a PNG.
  if (ascii(bytes, 4, 4) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif|avis)$/.test(ascii(bytes, 8, 4))) return 'browser';
  return null;
}

/** What a file is: by its content first, and its name where the content cannot say. */
export function createKind(name: string, bytes: Uint8Array): CreateKind | null {
  const lower = name.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf('.') + 1);
  if (pictureKind(bytes)) return 'image';
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) {
    if (isDocx(bytes)) return 'docx';
    if (isXlsx(bytes)) return 'xlsx';
    if (isPptx(bytes)) return 'pptx';
    return null;
  }
  if (startsWith(bytes, 0x25, 0x50, 0x44, 0x46)) return null;
  // Binary is not text: a NUL in the first kilobyte (UTF-16 aside) says so.
  const head = bytes.subarray(0, 1024);
  const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
  if (!utf16 && head.includes(0)) return null;
  if (['html', 'htm', 'xhtml'].includes(extension)) return 'html';
  if (['md', 'markdown', 'mdown', 'mkd'].includes(extension)) return 'markdown';
  if (['csv', 'tsv'].includes(extension)) return 'csv';
  if (['txt', 'text', 'log'].includes(extension)) return 'text';
  const start = new TextDecoder('utf-8').decode(head).replace(/^\uFEFF/, '').trimStart().slice(0, 64).toLowerCase();
  if (start.startsWith('<!doctype html') || start.startsWith('<html')) return 'html';
  return null;
}

export function readSource(kind: Exclude<CreateKind, 'image'>, bytes: Uint8Array): ReadDocument {
  switch (kind) {
    case 'docx':
      return readDocx(bytes);
    case 'xlsx':
      return readXlsx(bytes);
    case 'pptx':
      return readPptx(bytes);
    case 'html':
      return readHtml(bytes);
    case 'markdown':
      return readMarkdown(bytes);
    case 'csv':
      return readCsv(bytes);
    case 'text':
      return readText(bytes);
  }
}

export interface CreateOptions {
  /** `auto`: a document's own page size (A4 when it has none), each picture's own size. */
  paper: 'auto' | 'a4' | 'letter';
  orientation: 'auto' | 'portrait' | 'landscape';
  /** Around pictures on paper. */
  margin: 'none' | 'small' | 'normal';
}

export const DEFAULT_CREATE_OPTIONS: CreateOptions = { paper: 'auto', orientation: 'auto', margin: 'small' };

const PAPER = { a4: [595.28, 841.89], letter: [612, 792] } as const;
const MARGIN = { none: 0, small: 18, normal: 36 } as const;
/** The margins of a page for text with none of its own: 2 cm. */
const TEXT_MARGIN = 56.7;

export interface CreateFile {
  name: string;
  bytes: ArrayBuffer;
}

export interface CreateReport {
  pages: number;
  /** Letters none of the bundled faces has: drawn as empty boxes. */
  missingGlyphs: number;
  /** Pictures left out: on the network, in a form nothing here draws, or broken. */
  picturesLeftOut: number;
  /** A sheet or presentation was too large to take whole. */
  truncated: boolean;
  /** Files that could not be read at all. */
  unreadable: string[];
  /** Files too large to read here once uncompressed (a zip bomb, or near enough). */
  tooLarge: string[];
}

type PartReport = Omit<CreateReport, 'unreadable' | 'tooLarge'>;

/** Nothing could be made: which files could not be read, and which were too large to. */
export class CreateError extends Error {
  readonly code = 'E_CREATE';
  constructor(
    message: string,
    readonly unreadable: string[] = [],
    readonly tooLarge: string[] = [],
  ) {
    super(`E_CREATE: ${message}`);
  }
}

export interface CreateResult {
  bytes: ArrayBuffer;
  name: string;
  report: CreateReport;
}

/** What creating needs from the app: the core, the bundled faces, and a browser's picture decoder. */
export interface CreateEnvironment {
  callStatic<T>(op: string, args: unknown, blobs: ArrayBuffer[]): Promise<{ result: T; blobs: ArrayBuffer[] }>;
  /** Amiri, then the faces for what it lacks, with their names. */
  fonts(): Promise<{ name: string; bytes: ArrayBuffer }[]>;
  /**
   * An installed face of `family` that has every letter of `text` and may be
   * embedded, as a font file; null where there is none (or no such thing to
   * ask, as in a browser).
   */
  installedFont?(family: string, text: string): Promise<ArrayBuffer | null>;
  /** A picture the core cannot read, as a PNG, if this browser can draw it. */
  decodePicture?(bytes: Uint8Array, mime: string): Promise<Uint8Array | null>;
  now?: Date;
}

/** A PDF date for now: `D:YYYYMMDDHHmmSSZ`. */
export function pdfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** The new file's name: the first file's, and how many more went into it. */
export function createdFileName(names: readonly string[]): string {
  const first = (names[0] ?? 'document').replace(/\.[^./\\]{1,8}$/, '').trim() || 'document';
  return names.length > 1 ? `${first} + ${names.length - 1}.pdf` : `${first}.pdf`;
}

function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/** Pictures in a form the core reads: as they are, or made PNGs by the browser, or left out. */
async function readablePictures(
  pictures: readonly SourcePicture[],
  env: CreateEnvironment,
): Promise<{ bytes: (Uint8Array | null)[]; leftOut: number }> {
  let leftOut = 0;
  const bytes: (Uint8Array | null)[] = [];
  for (const picture of pictures) {
    const kind = pictureKind(picture.bytes);
    if (kind === 'core') {
      bytes.push(picture.bytes);
      continue;
    }
    const png = picture.mime !== 'image/svg+xml' && env.decodePicture ? await env.decodePicture(picture.bytes, picture.mime) : null;
    if (!png) leftOut += 1;
    bytes.push(png);
  }
  return { bytes, leftOut };
}

/** Image blocks whose picture could not be made readable point at nothing. */
function dropMissing(blocks: Block[], missing: Set<number>): Block[] {
  return blocks.flatMap((block): Block[] => {
    if (block.type === 'image' && missing.has(block.index)) return [];
    if (block.type === 'frame') return [{ ...block, blocks: dropMissing(block.blocks, missing) }];
    return [block];
  });
}

async function createDocument(
  file: CreateFile,
  read: ReadDocument,
  kind: CreateKind,
  options: CreateOptions,
  env: CreateEnvironment,
): Promise<{ bytes: ArrayBuffer; report: PartReport }> {
  const { bytes: pictures, leftOut } = await readablePictures(read.pictures, env);
  const missing = new Set(pictures.flatMap((p, k) => (p ? [] : [k])));
  const faces = await documentFaces(env, dropMissing(read.blocks, missing), read.header ?? [], read.footer ?? []);
  const fonts = faces.fonts;
  // The document's own page, or the paper asked for, turned as asked.
  const own = read.page;
  let [width, height] = options.paper === 'auto' ? [own?.width ?? PAPER.a4[0], own?.height ?? PAPER.a4[1]] : PAPER[options.paper];
  if (options.paper !== 'auto' && own && own.width > own.height) [width, height] = [height, width];
  if (options.orientation !== 'auto' && kind !== 'pptx') {
    const landscape = options.orientation === 'landscape';
    if (landscape !== width > height) [width, height] = [height, width];
  }
  const margins = own?.margins ?? [TEXT_MARGIN, TEXT_MARGIN, TEXT_MARGIN, TEXT_MARGIN];
  const direction = dominantDirection(read.blocks);
  const stem = file.name.replace(/\.[^./\\]{1,8}$/, '');
  const blobs: ArrayBuffer[] = [...fonts.map((f) => f.bytes.slice(0)), ...pictures.map((p) => (p ? copy(p) : new ArrayBuffer(0)))];
  const { result, blobs: out } = await env.callStatic<{ pages: number; missingGlyphs: number; picturesLeftOut: number }>(
    'create.document',
    {
      page: { width, height, margins, header: own?.header ?? 36, footer: own?.footer ?? 36 },
      blocks: faces.blocks,
      header: faces.header,
      footer: faces.footer,
      fonts: fonts.map((_, k) => k),
      fontNames: fonts.map((f) => f.name),
      pictures: pictures.map((_, k) => fonts.length + k),
      title: read.title ?? stem,
      lang: direction === 'rtl' ? 'ar' : 'en',
      created: pdfDate(env.now ?? new Date()),
    },
    blobs,
  );
  const bytes = out[0];
  if (!bytes || result.pages < 1) throw new Error('E_CREATE: nothing was made');
  return {
    bytes,
    report: {
      pages: result.pages,
      missingGlyphs: result.missingGlyphs,
      picturesLeftOut: result.picturesLeftOut + leftOut + read.picturesLeftOut,
      truncated: read.truncated,
    },
  };
}

async function createFromPictures(
  files: readonly CreateFile[],
  options: CreateOptions,
  env: CreateEnvironment,
): Promise<{ bytes: ArrayBuffer; report: PartReport; unreadable: string[] } | null> {
  const unreadable: string[] = [];
  const blobs: ArrayBuffer[] = [];
  const kept: string[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(file.bytes);
    const { bytes: [ready] } = await readablePictures([{ bytes, mime: mimeOf(file.name) }], env);
    if (ready) {
      blobs.push(copy(ready));
      kept.push(file.name);
    } else unreadable.push(file.name);
  }
  if (blobs.length === 0) return null;
  const paper = options.paper === 'auto' ? 'own' : { width: PAPER[options.paper][0], height: PAPER[options.paper][1] };
  const { result, blobs: out } = await env.callStatic<{ pages: number; leftOut: number[] }>(
    'create.images',
    {
      paper,
      orientation: options.orientation,
      margin: MARGIN[options.margin],
      title: kept[0]?.replace(/\.[^./\\]{1,8}$/, ''),
      created: pdfDate(env.now ?? new Date()),
    },
    blobs,
  );
  for (const k of result.leftOut) if (kept[k]) unreadable.push(kept[k]);
  const bytes = out[0];
  if (!bytes) return null;
  return { bytes, report: { pages: result.pages, missingGlyphs: 0, picturesLeftOut: 0, truncated: false }, unreadable };
}

function mimeOf(name: string): string {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  return (
    { heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[
      extension
    ] ?? 'application/octet-stream'
  );
}

/**
 * One new PDF of `files`, in order: consecutive pictures together, each
 * document on its own, all joined. Throws when nothing at all could be made.
 */
export async function createPdf(files: readonly CreateFile[], options: CreateOptions, env: CreateEnvironment): Promise<CreateResult> {
  const parts: ArrayBuffer[] = [];
  const report: CreateReport = { pages: 0, missingGlyphs: 0, picturesLeftOut: 0, truncated: false, unreadable: [], tooLarge: [] };
  let pictures: CreateFile[] = [];
  const add = (made: { bytes: ArrayBuffer; report: PartReport }) => {
    parts.push(made.bytes);
    report.pages += made.report.pages;
    report.missingGlyphs += made.report.missingGlyphs;
    report.picturesLeftOut += made.report.picturesLeftOut;
    report.truncated ||= made.report.truncated;
  };
  const flushPictures = async () => {
    if (pictures.length === 0) return;
    const made = await createFromPictures(pictures, options, env);
    if (made) {
      add(made);
      report.unreadable.push(...made.unreadable);
    } else report.unreadable.push(...pictures.map((p) => p.name));
    pictures = [];
  };
  for (const file of files) {
    const bytes = new Uint8Array(file.bytes);
    const kind = createKind(file.name, bytes);
    if (kind === 'image') {
      pictures.push(file);
      continue;
    }
    await flushPictures();
    if (kind === null) {
      report.unreadable.push(file.name);
      continue;
    }
    try {
      const read = readSource(kind, bytes);
      if (read.blocks.length === 0) {
        report.unreadable.push(file.name);
        continue;
      }
      add(await createDocument(file, read, kind, options, env));
    } catch (error) {
      if (error instanceof TooLargeError) report.tooLarge.push(file.name);
      else report.unreadable.push(file.name);
    }
  }
  await flushPictures();
  if (parts.length === 0) throw new CreateError('none of the files could be made into a PDF', report.unreadable, report.tooLarge);
  let bytes = parts[0]!;
  if (parts.length > 1) {
    const { blobs } = await env.callStatic<{ pageCount: number }>('pages.combine', { passwords: parts.map(() => null) }, parts);
    if (!blobs[0]) throw new Error('E_CREATE: the parts could not be joined');
    bytes = blobs[0];
  }
  const named = files.filter((f) => !report.unreadable.includes(f.name) && !report.tooLarge.includes(f.name)).map((f) => f.name);
  return { bytes, name: createdFileName(named.length > 0 ? named : files.map((f) => f.name)), report };
}
