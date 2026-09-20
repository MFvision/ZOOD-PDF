import type { CoreClient, RemoteDocument } from '../core/client';
import { encodePng } from '../export/png';
import { readJson, writeJson } from '../state/preferences';
import { drawRgba } from '../viewer/useRenderedCanvas';
import { NO_CLEANUP, anyCleanup, cleanUp, sanitizeCleanup } from './cleanup';
import type { CleanupOptions } from './cleanup';
import { skewAngle, straighten } from './deskew';
import { startRecognizer } from './engine';
import type { OcrLanguage, ReadWord, Recognizer } from './engine';
import { writeTextLayer } from './layer';

/** Which pages to read: those with no text of their own, or every page. */
export type OcrScope = 'blank' | 'all';

export interface OcrProgress {
  /** One-based, of `of`. */
  page: number;
  of: number;
}

/** How a page is prepared before it is read, and what is kept of it. */
export interface ReadOptions {
  cleanup: CleanupOptions;
  /** Put the cleaned-up (and straightened) page in place of the scan's own picture. */
  replaceImage: boolean;
}

export const PLAIN_READING: ReadOptions = { cleanup: NO_CLEANUP, replaceImage: false };

const OPTIONS_KEY = 'warraq.ocr.options';

/** The cleanup a person chose last time, checked; none the first time. */
export function readOcrOptions(): ReadOptions {
  const stored = readJson<unknown>(OPTIONS_KEY, {});
  const given = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  return { cleanup: sanitizeCleanup(given.cleanup), replaceImage: given.replaceImage === true };
}

export function writeOcrOptions(options: ReadOptions): void {
  writeJson(OPTIONS_KEY, options);
}

/** A page's words, boxes in points from the page's top-left as shown — straightened, when it was crooked. */
export interface OcrPageWords {
  index: number;
  words: { text: string; bbox: [number, number, number, number] }[];
  confidence: number;
  /** Degrees counter-clockwise the scan was turned: it was read straightened by this. */
  angle: number;
  /** The cleaned-up page, straightened, as PNG or JPEG, when it is to replace the scan. */
  image?: Uint8Array;
}

/** Tesseract reads best at about 300 dpi; a page is drawn at that, within reason. */
const DPI = 300;
const LONGEST_SIDE_PX = 4200;

/** Pixels per point for a page of `size`: 300 dpi, or less for a very large page. */
export function renderScale(size: readonly [number, number]): number {
  const scale = DPI / 72;
  const longest = Math.max(size[0], size[1]) * scale;
  return longest > LONGEST_SIDE_PX ? (scale * LONGEST_SIDE_PX) / longest : scale;
}

/**
 * Words read in pixels, as boxes in points; read off a straightened page,
 * less where the page begins in the larger image it was turned into.
 */
export function toPoints(
  words: readonly ReadWord[],
  scale: number,
  offset: readonly [number, number] = [0, 0],
): OcrPageWords['words'] {
  const [dx, dy] = offset;
  return words.map((word) => {
    const [x0, y0, x1, y1] = word.bbox;
    return {
      text: word.text,
      bbox: [(x0 - dx) / scale, (y0 - dy) / scale, (x1 - dx) / scale, (y1 - dy) / scale],
    };
  });
}

/**
 * Black and white again: a straightened page's letters have grey edges from
 * the turn, and a picture that is only black and white is kept at one bit a
 * pixel by the core. `rgba` is changed in place.
 */
export function rethreshold(rgba: Uint8ClampedArray | Uint8Array): void {
  for (let p = 0; p < rgba.length; p += 4) {
    const v = rgba[p]! < 128 ? 0 : 255;
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
  }
}

/**
 * The page as it was read — cleaned up and straightened — the size it was
 * drawn at, for the core to put in place of the scan: black and white as
 * PNG (one bit a pixel in the file), grey as JPEG.
 */
async function pageImage(
  read: HTMLCanvasElement,
  offset: readonly [number, number],
  width: number,
  height: number,
  bilevel: boolean,
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('E_CANVAS: no 2D context');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(read, -offset[0], -offset[1]);
    if (bilevel) {
      const pixels = context.getImageData(0, 0, width, height);
      rethreshold(pixels.data);
      return encodePng(width, height, pixels.data);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('E_CANVAS: the page could not be encoded');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Reads the chosen pages of `doc`: each is drawn at about 300 dpi by
 * Warraq's core, cleaned up as chosen (`cleanup.ts`), straightened when it
 * is crooked, and read by Tesseract. Pages that already carry text are
 * skipped unless `scope` is `all`. `signal` stops it between pages. A
 * `recognizer` already started (the batch reads many files with one) is
 * used and left running; otherwise one is started and stopped here.
 */
export async function readPages(
  doc: RemoteDocument,
  languages: readonly OcrLanguage[],
  scope: OcrScope,
  onProgress: (progress: OcrProgress) => void,
  signal?: AbortSignal,
  options: ReadOptions = PLAIN_READING,
  shared?: Recognizer,
): Promise<OcrPageWords[]> {
  const targets: number[] = [];
  for (let index = 0; index < doc.pageCount; index += 1) {
    if (scope === 'all' || (await doc.extract_text(index)).trim().length === 0) targets.push(index);
  }
  if (targets.length === 0) return [];
  const recognizer = shared ?? (await startRecognizer(languages));
  const canvas = document.createElement('canvas');
  const pages: OcrPageWords[] = [];
  const cleaning = anyCleanup(options.cleanup);
  try {
    for (const [k, index] of targets.entries()) {
      if (signal?.aborted) break;
      onProgress({ page: k + 1, of: targets.length });
      const scale = renderScale(doc.pageSizes[index] ?? [612, 792]);
      const render = await doc.render_page(index, scale);
      // Cleaned before the slant is measured: a shadow is not a line of text.
      if (cleaning) cleanUp(render, options.cleanup, scale * 72);
      drawRgba(canvas, render);
      // A crooked scan is read straightened; its words come back in the
      // straightened page, and the text layer is turned back over it.
      const angle = skewAngle(render);
      const straight = angle === 0 ? null : straighten(canvas, angle);
      const words = await recognizer.read(straight?.canvas ?? canvas);
      // Only a page that was changed is worth putting in the scan's place.
      const image =
        options.replaceImage && (cleaning || straight) && words.length > 0
          ? await pageImage(straight?.canvas ?? canvas, straight?.offset ?? [0, 0], render.width, render.height, options.cleanup.binarize)
          : undefined;
      if (straight) straight.canvas.width = straight.canvas.height = 0;
      const confidence = words.length
        ? words.reduce((s, w) => s + w.confidence, 0) / words.length
        : 0;
      pages.push({ index, words: toPoints(words, scale, straight?.offset), confidence, angle, ...(image ? { image } : {}) });
    }
  } finally {
    if (!shared) await recognizer.stop();
    canvas.width = 0;
    canvas.height = 0;
  }
  return pages;
}

/** What reading a file's scanned pages did. */
export interface RecognizedFile {
  /** The file with its text layer, or as it was when nothing was read. */
  bytes: ArrayBuffer;
  /** Pages given a text layer, words in it, pages that already had Warraq's, and Tesseract's mean confidence (0–100). */
  pages: number;
  words: number;
  skipped: number;
  confidence: number;
  /** Pages whose scan was replaced by the cleaned-up one, and pages that kept theirs. */
  images: number;
  imagesKept: number;
}

/**
 * Scan & OCR on a file's bytes: its pages read with Tesseract — cleaned up
 * first as `options` say — and what was read written in by the core as an
 * invisible text layer (`ocr.add_text_layer`). The open document's
 * `recognizeText`, Create PDF's pictures and the batch's OCR step all come
 * here; a batch hands its running `recognizer` over.
 */
export async function recognizeFile(
  client: Pick<CoreClient, 'open' | 'callStatic'>,
  bytes: ArrayBuffer,
  password: string | undefined,
  languages: readonly OcrLanguage[],
  scope: OcrScope,
  onProgress: (progress: OcrProgress) => void,
  signal?: AbortSignal,
  options: ReadOptions = PLAIN_READING,
  recognizer?: Recognizer,
): Promise<RecognizedFile> {
  const reading = await client.open(bytes.slice(0), password);
  let pages: OcrPageWords[];
  try {
    pages = await readPages(reading, languages, scope, onProgress, signal, options, recognizer);
  } finally {
    void reading.free();
  }
  const read = pages.filter((page) => page.words.length > 0);
  const confidence = read.length ? read.reduce((sum, page) => sum + page.confidence, 0) / read.length : 0;
  const nothing = { bytes, pages: 0, words: 0, skipped: 0, images: 0, imagesKept: 0, confidence };
  if (read.length === 0 || signal?.aborted) return nothing;
  // `writeTextLayer` hands the core a copy: the file as it was is the answer when nothing was written.
  const written = await writeTextLayer(client, bytes, password, read);
  return { ...written.report, bytes: written.bytes ?? bytes, confidence };
}
