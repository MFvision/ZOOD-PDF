import type { CoreClient, RemoteDocument } from '../core/client';
import { loadEditFont } from '../edit/editFont';
import { drawRgba } from '../viewer/useRenderedCanvas';
import { skewAngle, straighten } from './deskew';
import { startRecognizer } from './engine';
import type { OcrLanguage, ReadWord } from './engine';

/** Which pages to read: those with no text of their own, or every page. */
export type OcrScope = 'blank' | 'all';

export interface OcrProgress {
  /** One-based, of `of`. */
  page: number;
  of: number;
}

/** A page's words, boxes in points from the page's top-left as shown — straightened, when it was crooked. */
export interface OcrPageWords {
  index: number;
  words: { text: string; bbox: [number, number, number, number] }[];
  confidence: number;
  /** Degrees counter-clockwise the scan was turned: it was read straightened by this. */
  angle: number;
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
 * Reads the chosen pages of `doc`: each is drawn at about 300 dpi by
 * Warraq's core and read by Tesseract. Pages that already carry text are
 * skipped unless `scope` is `all`. `signal` stops it between pages.
 */
export async function readPages(
  doc: RemoteDocument,
  languages: readonly OcrLanguage[],
  scope: OcrScope,
  onProgress: (progress: OcrProgress) => void,
  signal?: AbortSignal,
): Promise<OcrPageWords[]> {
  const targets: number[] = [];
  for (let index = 0; index < doc.pageCount; index += 1) {
    if (scope === 'all' || (await doc.extract_text(index)).trim().length === 0) targets.push(index);
  }
  if (targets.length === 0) return [];
  const recognizer = await startRecognizer(languages);
  const canvas = document.createElement('canvas');
  const pages: OcrPageWords[] = [];
  try {
    for (const [k, index] of targets.entries()) {
      if (signal?.aborted) break;
      onProgress({ page: k + 1, of: targets.length });
      const scale = renderScale(doc.pageSizes[index] ?? [612, 792]);
      const render = await doc.render_page(index, scale);
      drawRgba(canvas, render);
      // A crooked scan is read straightened; its words come back in the
      // straightened page, and the text layer is turned back over it.
      const angle = skewAngle(render);
      const straight = angle === 0 ? null : straighten(canvas, angle);
      const words = await recognizer.read(straight?.canvas ?? canvas);
      if (straight) straight.canvas.width = straight.canvas.height = 0;
      const confidence = words.length
        ? words.reduce((s, w) => s + w.confidence, 0) / words.length
        : 0;
      pages.push({ index, words: toPoints(words, scale, straight?.offset), confidence, angle });
    }
  } finally {
    await recognizer.stop();
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
}

/**
 * Scan & OCR on a file's bytes: its pages read with Tesseract, and what was
 * read written in by the core as an invisible text layer
 * (`ocr.add_text_layer`). The open document's `recognizeText` and Create
 * PDF's pictures both come here.
 */
export async function recognizeFile(
  client: Pick<CoreClient, 'open' | 'callStatic'>,
  bytes: ArrayBuffer,
  password: string | undefined,
  languages: readonly OcrLanguage[],
  scope: OcrScope,
  onProgress: (progress: OcrProgress) => void,
  signal?: AbortSignal,
): Promise<RecognizedFile> {
  const reading = await client.open(bytes.slice(0), password);
  let pages: OcrPageWords[];
  try {
    pages = await readPages(reading, languages, scope, onProgress, signal);
  } finally {
    void reading.free();
  }
  const read = pages.filter((page) => page.words.length > 0);
  const confidence = read.length ? read.reduce((sum, page) => sum + page.confidence, 0) / read.length : 0;
  if (read.length === 0 || signal?.aborted) return { bytes, pages: 0, words: 0, skipped: 0, confidence };
  const font = await loadEditFont('amiri');
  const { result, blobs } = await client.callStatic<{ pages: number; words: number; skipped: number }>(
    'ocr.add_text_layer',
    { password: password ?? null, pages: read.map(({ index, words, angle }) => ({ index, words, angle })) },
    // A copy: the core takes over what it is handed, and the file as it was is the answer when nothing was written.
    [bytes.slice(0), font.slice().buffer],
  );
  return { ...result, bytes: result.pages > 0 && blobs[0] ? blobs[0] : bytes, confidence };
}
