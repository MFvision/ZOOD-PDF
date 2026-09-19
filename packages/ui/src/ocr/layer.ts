import type { CoreClient } from '../core/client';
import { loadEditFont } from '../edit/editFont';

/**
 * The text layer in the file, through Warraq's core (`ocr.add_text_layer`,
 * `ocr.layer_words`): written after a reading, rewritten after a correction,
 * and read back — the words and boxes the core keeps with each page — for a
 * correction to start from. Scan & OCR, the batch and the AI tool share it.
 */

/** A word and its box, in points from the page's top-left as shown. */
export interface LayerWord {
  text: string;
  bbox: [number, number, number, number];
}

export interface LayerPage {
  /** Zero-based. */
  index: number;
  words: LayerWord[];
  /** Degrees counter-clockwise the scan is turned (its words are in the page straightened by it). */
  angle: number;
  /** Take out the page's earlier layer and write this one instead. */
  replace?: boolean;
  /** The cleaned-up page, straightened, to put in place of its scan. */
  image?: Uint8Array;
}

export interface LayerReport {
  pages: number;
  words: number;
  skipped: number;
  images: number;
  imagesKept: number;
}

/** Now as a PDF date, `D:YYYYMMDDHHmmSSZ`, in UTC: the core has no clock. */
export function pdfDate(now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `D:${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}Z`;
}

/**
 * Writes `pages` as the text layer of the file `bytes` (an incremental
 * update; `bytes` itself is not kept by the core, a copy goes). Returns the
 * new file, or null when nothing was written.
 */
export async function writeTextLayer(
  client: Pick<CoreClient, 'callStatic'>,
  bytes: ArrayBuffer,
  password: string | undefined,
  pages: readonly LayerPage[],
): Promise<{ report: LayerReport; bytes: ArrayBuffer | null }> {
  const font = await loadEditFont('amiri');
  const images: ArrayBuffer[] = [];
  const args = pages.map(({ index, words, angle, replace, image }) => {
    const entry: Record<string, unknown> = { index, words, angle };
    if (replace) entry.replace = true;
    if (image) {
      entry.image = images.length;
      images.push(image.slice().buffer);
    }
    return entry;
  });
  const { result, blobs } = await client.callStatic<Partial<LayerReport>>(
    'ocr.add_text_layer',
    { password: password ?? null, pages: args, modified: pdfDate() },
    [bytes.slice(0), font.slice().buffer, ...images],
  );
  const report: LayerReport = {
    pages: result.pages ?? 0,
    words: result.words ?? 0,
    skipped: result.skipped ?? 0,
    images: result.images ?? 0,
    imagesKept: result.imagesKept ?? 0,
  };
  return { report, bytes: report.pages > 0 ? (blobs[0] ?? null) : null };
}

/** The words of the layers Warraq wrote in `bytes`, page by page (zero-based `pages`; all when absent). */
export async function layerWords(
  client: Pick<CoreClient, 'callStatic'>,
  bytes: ArrayBuffer,
  password: string | undefined,
  pages?: readonly number[],
): Promise<LayerPage[]> {
  const { result } = await client.callStatic<{ pages: LayerPage[] }>(
    'ocr.layer_words',
    { password: password ?? null, ...(pages ? { pages } : {}) },
    [bytes.slice(0)],
  );
  return result.pages ?? [];
}
