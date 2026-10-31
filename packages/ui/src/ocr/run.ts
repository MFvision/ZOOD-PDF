import type { CoreClient, RemoteDocument } from '../core/client';
import type { RenderedPageData } from '../core/types';
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
  /**
   * "Stop after this page" keeps the pages read before it (Scan & OCR on the
   * open file). Without it a stop leaves the file as it was (the batch).
   */
  keepOnStop?: boolean;
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
 * A page cleaned up (`cleanup.ts`) and the slant of its lines measured
 * (`deskew.ts`) — the two passes over its pixels, and the whole of the work
 * reading a page does outside the core and Tesseract. `page` is changed in
 * place and handed back, so a worker can take it and give it again.
 *
 * Scan & OCR does this work where it runs; the Library's reader hands it to
 * its own worker (`library/ingest.ts`), so indexing a folder never stops the
 * interface.
 */
export type PreparePixels = (
  page: RenderedPageData,
  cleanup: CleanupOptions,
  dpi: number,
) => Promise<{ page: RenderedPageData; angle: number }>;

/** The preparation done in the thread that asks for it. */
export const prepareHere: PreparePixels = async (page, cleanup, dpi) => {
  // Cleaned before the slant is measured: a shadow is not a line of text.
  if (anyCleanup(cleanup)) cleanUp(page, cleanup, dpi);
  return { page, angle: skewAngle(page) };
};

/** What `readPagesWith` needs; everything but the document has a sensible default. */
export interface ReadPagesOptions {
  languages: readonly OcrLanguage[];
  scope: OcrScope;
  onProgress?: (progress: OcrProgress) => void;
  signal?: AbortSignal;
  options?: ReadOptions;
  /** A recognizer already started (a batch reads many files with one): used and left running. */
  recognizer?: Recognizer;
  /** Where the pixel work is done; in this thread by default. */
  prepare?: PreparePixels;
  /**
   * The pages to read, zero-based, when the caller already knows which carry
   * no text of their own — the Library does, having just read them all — so
   * they are not extracted twice. `scope` chooses them otherwise.
   */
  pages?: readonly number[];
}

/**
 * Reads the chosen pages of `doc`: each is drawn at about 300 dpi by
 * Warraq's core, cleaned up as chosen (`cleanup.ts`), straightened when it
 * is crooked, and read by Tesseract. Pages that already carry text are
 * skipped unless `scope` is `all`. `signal` stops it between pages. A
 * `recognizer` already started (the batch reads many files with one) is
 * used and left running; otherwise one is started and stopped here.
 */
export async function readPagesWith(doc: RemoteDocument, how: ReadPagesOptions): Promise<OcrPageWords[]> {
  const { languages, scope, signal, recognizer: shared } = how;
  const options = how.options ?? PLAIN_READING;
  const onProgress = how.onProgress ?? (() => undefined);
  const prepare = how.prepare ?? prepareHere;
  const targets: number[] = [];
  if (how.pages) targets.push(...how.pages.filter((index) => index >= 0 && index < doc.pageCount));
  else
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
      const drawn = await doc.render_page(index, scale);
      const { page: render, angle } = await prepare(drawn, options.cleanup, scale * 72);
      if (signal?.aborted) break;
      drawRgba(canvas, render);
      // A crooked scan is read straightened; its words come back in the
      // straightened page, and the text layer is turned back over it.
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

/** `readPagesWith` as Scan & OCR and the batch have always called it. */
export function readPages(
  doc: RemoteDocument,
  languages: readonly OcrLanguage[],
  scope: OcrScope,
  onProgress: (progress: OcrProgress) => void,
  signal?: AbortSignal,
  options: ReadOptions = PLAIN_READING,
  shared?: Recognizer,
): Promise<OcrPageWords[]> {
  return readPagesWith(doc, { languages, scope, onProgress, signal, options, recognizer: shared });
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
  /** Pages it read, words found or not: 0 when no page needed it. */
  tried: number;
  /** It was stopped before the last page. */
  stopped: boolean;
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
  const stopped = signal?.aborted === true;
  const nothing = { bytes, pages: 0, words: 0, skipped: 0, images: 0, imagesKept: 0, confidence, tried: pages.length, stopped };
  // A stop used to throw away the pages already read and then say no page
  // needed reading (First Five, Rami): "Stop after this page" keeps them.
  if (read.length === 0 || (stopped && !options.keepOnStop)) return nothing;
  // `writeTextLayer` hands the core a copy: the file as it was is the answer when nothing was written.
  const written = await writeTextLayer(client, bytes, password, read);
  return { ...written.report, bytes: written.bytes ?? bytes, confidence, tried: pages.length, stopped };
}
