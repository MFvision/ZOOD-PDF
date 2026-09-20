import { readSource } from '../create/createPdf';
import { decodeInBrowser } from '../create/environment';
import { anyCleanup, cleanUp } from '../ocr/cleanup';
import type { CleanupOptions } from '../ocr/cleanup';
import { skewAngle } from '../ocr/deskew';
import type { SourceKind } from './kinds';
import { TEXT_LIMITS, documentPages } from './pageText';
import type { PageText, TextLimits } from './pageText';

/**
 * Everything reading a file for the Library costs, apart from the core and
 * Tesseract — which have workers of their own. It is all here so that
 * `ingest.worker.ts` can run it off the interface's thread, and so that the
 * tests can run exactly the same code without a worker.
 *
 * Nothing here touches the DOM: it works on bytes and on pixels, and draws
 * with `OffscreenCanvas` where there is one.
 */

/** A page's pixels as they travel between threads: the buffer is transferred, never copied. */
export interface PagePixels {
  width: number;
  height: number;
  rgba: ArrayBuffer;
}

export type WorkRequest =
  | { job: 'hash'; bytes: ArrayBuffer }
  | { job: 'read'; source: Exclude<SourceKind, 'pdf' | 'image'>; bytes: ArrayBuffer; limits?: TextLimits }
  | { job: 'prepare'; page: PagePixels; cleanup: CleanupOptions; dpi: number }
  | { job: 'thumbnail'; page: PagePixels; edge: number }
  | { job: 'decode'; bytes: ArrayBuffer; mime: string };

export type WorkReply =
  | { job: 'hash'; hash: string }
  | { job: 'read'; pages: PageText[]; truncated: boolean }
  | { job: 'prepare'; page: PagePixels; angle: number }
  | { job: 'thumbnail'; image: ArrayBuffer | null; mime: string }
  | { job: 'decode'; bytes: ArrayBuffer | null };

/** A reply and the buffers handed over with it. */
export interface Worked {
  reply: WorkReply;
  transfer: Transferable[];
}

/**
 * A file's content hash, hex. SHA-256 through the platform's own digest, so
 * a large file costs one pass in native code; without `crypto.subtle` —
 * an insecure origin — a file is simply always read again (`''`).
 */
export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = globalThis.crypto?.subtle;
  if (!digest) return '';
  try {
    const sum = new Uint8Array(await digest.digest('SHA-256', bytes));
    let hex = '';
    for (const byte of sum) hex += byte.toString(16).padStart(2, '0');
    return hex;
  } catch {
    return '';
  }
}

/** The size a thumbnail of a `width` by `height` page is drawn at: `edge` on its longer side. */
export function thumbnailSize(width: number, height: number, edge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, edge / longest);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * A small picture of a page, as a JPEG. Null where this environment has no
 * `OffscreenCanvas` (the unit tests, an old browser): a result without a
 * thumbnail is shown with its kind's icon instead.
 */
export async function thumbnailOf(page: PagePixels, edge: number): Promise<{ image: ArrayBuffer | null; mime: string }> {
  const mime = 'image/jpeg';
  if (typeof OffscreenCanvas !== 'function' || page.width <= 0 || page.height <= 0) return { image: null, mime };
  const size = thumbnailSize(page.width, page.height, edge);
  try {
    const full = new OffscreenCanvas(page.width, page.height);
    const drawn = full.getContext('2d');
    if (!drawn) return { image: null, mime };
    drawn.putImageData(new ImageData(new Uint8ClampedArray(page.rgba), page.width, page.height), 0, 0);
    const small = new OffscreenCanvas(size.width, size.height);
    const into = small.getContext('2d');
    if (!into) return { image: null, mime };
    into.imageSmoothingEnabled = true;
    into.imageSmoothingQuality = 'high';
    // White under it: a page drawn with transparency would go black as a JPEG.
    into.fillStyle = '#fff';
    into.fillRect(0, 0, size.width, size.height);
    into.drawImage(full, 0, 0, size.width, size.height);
    full.width = full.height = 0;
    const blob = await small.convertToBlob({ type: mime, quality: 0.7 });
    small.width = small.height = 0;
    return { image: await blob.arrayBuffer(), mime };
  } catch {
    return { image: null, mime };
  }
}

/** Runs one job. Every failure is the caller's to handle: a file that throws is skipped. */
export async function doWork(request: WorkRequest): Promise<Worked> {
  switch (request.job) {
    case 'hash':
      return { reply: { job: 'hash', hash: await hashBytes(request.bytes) }, transfer: [] };
    case 'read': {
      const read = readSource(request.source, new Uint8Array(request.bytes));
      const { pages, truncated } = documentPages(read, request.limits ?? TEXT_LIMITS);
      return { reply: { job: 'read', pages, truncated }, transfer: [] };
    }
    case 'prepare': {
      const page = { width: request.page.width, height: request.page.height, rgba: new Uint8ClampedArray(request.page.rgba) };
      // Cleaned before the slant is measured: a shadow is not a line of text.
      if (anyCleanup(request.cleanup)) cleanUp(page, request.cleanup, request.dpi);
      const angle = skewAngle(page);
      const back: PagePixels = { width: page.width, height: page.height, rgba: page.rgba.buffer as ArrayBuffer };
      return { reply: { job: 'prepare', page: back, angle }, transfer: [back.rgba] };
    }
    case 'thumbnail': {
      const made = await thumbnailOf(request.page, request.edge);
      return { reply: { job: 'thumbnail', ...made }, transfer: made.image ? [made.image] : [] };
    }
    case 'decode': {
      const png = await decodeInBrowser(new Uint8Array(request.bytes), request.mime);
      const bytes = png ? (png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer) : null;
      return { reply: { job: 'decode', bytes }, transfer: bytes ? [bytes] : [] };
    }
  }
}
