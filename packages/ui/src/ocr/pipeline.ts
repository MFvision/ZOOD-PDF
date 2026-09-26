/**
 * Scan & OCR flows (ADR 0016):
 *  - makeSearchable: pages without text are rendered (PDFium, ~300 dpi), preprocessed, recognised
 *    and get an invisible text layer from the engine (`ocr.addTextLayer`), all in ONE incremental
 *    update on top of the document's bytes.
 *  - scanImages: photos / scanned images → perspective-corrected, cleaned pages → a new PDF with a
 *    text layer (`ocr.createPdf`).
 */
import type { EngineClient } from '../services/engine';
import type { Point } from './preprocess';
import type { PrepClient, PrepOptions } from './prep-client';
import type { OcrLang, Recognizer } from './recognizer';

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export type Stage = 'prepare' | 'render' | 'clean' | 'recognise' | 'write';

export interface Progress {
  /** 0-based position in the work list and its length. */
  index: number;
  total: number;
  /** 0-based page (make searchable) or image index (scan). */
  item: number;
  stage: Stage;
  /** 0–1 within the current item. */
  fraction: number;
}

export interface PageRenderer {
  /** PNG of a page, `width` pixels wide (page rotation applied). */
  renderPage(pageIndex: number, width: number): Promise<Blob>;
}

/** Target resolution for rendering pages to recognise. */
export const RENDER_DPI = 300;
/** Longest rendered side (bounded memory for huge pages). */
export const MAX_RENDER_SIDE = 6000;

function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new CancelledError();
}

interface PageInfo {
  width: number;
  height: number;
  rotation: number;
}

/** Pages whose extracted text is empty (scanned pages). */
export async function pagesWithoutText(engine: EngineClient, docId: string): Promise<number[]> {
  const r = await engine.call<{ pages: string[] }>(docId, 'text.plain', { hidden: true, artifacts: false });
  return r.json.pages.map((t, i) => (t.replace(/\s+/g, '') === '' ? i : -1)).filter((i) => i >= 0);
}

export interface MakeSearchableArgs {
  engine: EngineClient;
  renderer: PageRenderer;
  prep: PrepClient;
  recognizer: Recognizer;
  bytes: Uint8Array;
  langs: readonly OcrLang[];
  options: Pick<PrepOptions, 'flatten' | 'despeckle'>;
  /** Pages to recognise (default: the pages without text). */
  pages?: number[];
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

export interface MakeSearchableResult {
  bytes: Uint8Array;
  pages: number[];
  words: number;
  angles: number[];
}

let tmpCounter = 0;

export async function makeSearchable(a: MakeSearchableArgs): Promise<MakeSearchableResult> {
  const docId = `ocr-${Date.now().toString(36)}-${++tmpCounter}`;
  const info = (await a.engine.open(docId, a.bytes)).json as { pages: PageInfo[] };
  try {
    const targets = a.pages ?? (await pagesWithoutText(a.engine, docId));
    if (targets.length === 0) return { bytes: a.bytes, pages: [], words: 0, angles: [] };
    await a.recognizer.ensure(a.langs);
    let words = 0;
    const angles: number[] = [];
    for (let k = 0; k < targets.length; k++) {
      const page = targets[k]!;
      const at = (stage: Stage, fraction = 0) => a.onProgress?.({ index: k, total: targets.length, item: page, stage, fraction });
      check(a.signal);
      const p = info.pages[page];
      if (!p) continue;
      const turned = p.rotation === 90 || p.rotation === 270;
      const displayW = turned ? p.height : p.width;
      const displayH = turned ? p.width : p.height;
      const scale = Math.min(RENDER_DPI / 72, MAX_RENDER_SIDE / Math.max(displayW, displayH));
      at('render');
      const png = new Uint8Array(await (await a.renderer.renderPage(page, Math.round(displayW * scale))).arrayBuffer());
      check(a.signal);
      at('clean');
      const prepared = await a.prep.prepare(png, { options: { deskew: true, clean: true, ...a.options }, dpi: 72 * scale });
      check(a.signal);
      at('recognise');
      const rec = await a.recognizer.recognize(prepared.pgm, prepared.dpi, (f) => at('recognise', f));
      check(a.signal);
      at('write');
      // The rendered image shows the page as displayed; if the renderer ignored /Rotate, say so.
      const landscapeImage = prepared.width > prepared.height;
      const landscapeDisplay = displayW > displayH;
      const rotation = turned && landscapeImage !== landscapeDisplay ? 0 : p.rotation;
      const r = await a.engine.call<{ words: number }>(docId, 'ocr.addTextLayer', {
        page,
        words: rec.words.map((w) => ({ text: w.text, bbox: w.bbox, conf: w.conf, line: w.line })),
        imageWidth: prepared.width,
        imageHeight: prepared.height,
        angle: prepared.ocrRotation,
        rotation,
        commit: false,
      });
      words += r.json.words;
      angles.push(prepared.angle);
    }
    check(a.signal);
    const saved = await a.engine.call(docId, 'doc.save', {});
    const bytes = saved.blobs[0];
    if (!bytes) throw new Error('engine returned no document');
    return { bytes, pages: targets, words, angles };
  } finally {
    void a.engine.close(docId).catch(() => {});
  }
}

export interface ScanInput {
  bytes: Uint8Array;
  /** Perspective corners in image pixels (clockwise from top-left). */
  quad?: Point[];
}

export interface ScanArgs {
  engine: EngineClient;
  prep: PrepClient;
  recognizer: Recognizer;
  images: ScanInput[];
  langs: readonly OcrLang[];
  options: PrepOptions;
  title?: string;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

export interface ScanResult {
  bytes: Uint8Array;
  angles: number[];
  words: number;
}

/** BCP 47 tag for the catalog /Lang of a new scan. */
export function langTag(langs: readonly OcrLang[]): string {
  return langs[0] ?? 'en';
}

export async function scanImages(a: ScanArgs): Promise<ScanResult> {
  if (a.images.length === 0) throw new Error('no images');
  await a.recognizer.ensure(a.langs);
  const pages: unknown[] = [];
  const blobs: Uint8Array[] = [];
  const angles: number[] = [];
  let words = 0;
  for (let k = 0; k < a.images.length; k++) {
    const img = a.images[k]!;
    const at = (stage: Stage, fraction = 0) => a.onProgress?.({ index: k, total: a.images.length, item: k, stage, fraction });
    check(a.signal);
    at('clean');
    const prepared = await a.prep.prepare(img.bytes, { options: a.options, quad: img.quad, page: true });
    check(a.signal);
    at('recognise');
    const rec = await a.recognizer.recognize(prepared.pgm, prepared.dpi, (f) => at('recognise', f));
    const pi = prepared.pageImage;
    if (!pi) throw new Error('no page image');
    blobs.push(pi.data);
    pages.push({
      image: pi.format === 'gray' ? { format: 'gray', blob: k, pixelWidth: pi.width, pixelHeight: pi.height } : { format: 'jpeg', blob: k },
      imageDpi: prepared.dpi,
      words: rec.words.map((w) => ({ text: w.text, bbox: w.bbox, conf: w.conf, line: w.line })),
      // text recognised on the straightened copy, laid over the page image as it is kept
      angle: prepared.ocrRotation - (prepared.pageRotation ?? 0),
    });
    angles.push(prepared.angle);
    words += rec.words.length;
  }
  check(a.signal);
  a.onProgress?.({ index: a.images.length - 1, total: a.images.length, item: a.images.length - 1, stage: 'write', fraction: 0 });
  const r = await a.engine.callStatic('ocr.createPdf', { pages, title: a.title, lang: langTag(a.langs) }, blobs);
  const bytes = r.blobs[0];
  if (!bytes) throw new Error('engine returned no document');
  return { bytes, angles, words };
}
