import type { RemoteDocument } from '../core/client';
import { drawRgba } from '../viewer/useRenderedCanvas';
import { startRecognizer } from './engine';
import type { OcrLanguage, ReadWord } from './engine';

/** Which pages to read: those with no text of their own, or every page. */
export type OcrScope = 'blank' | 'all';

export interface OcrProgress {
  /** One-based, of `of`. */
  page: number;
  of: number;
}

/** A page's words, boxes in points from the page's top-left as shown. */
export interface OcrPageWords {
  index: number;
  words: { text: string; bbox: [number, number, number, number] }[];
  confidence: number;
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

/** Words read in pixels, as boxes in points. */
export function toPoints(words: readonly ReadWord[], scale: number): OcrPageWords['words'] {
  return words.map((word) => ({
    text: word.text,
    bbox: word.bbox.map((v) => v / scale) as [number, number, number, number],
  }));
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
      drawRgba(canvas, await doc.render_page(index, scale));
      const words = await recognizer.read(canvas);
      const confidence = words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : 0;
      pages.push({ index, words: toPoints(words, scale), confidence });
    }
  } finally {
    await recognizer.stop();
    canvas.width = 0;
    canvas.height = 0;
  }
  return pages;
}
