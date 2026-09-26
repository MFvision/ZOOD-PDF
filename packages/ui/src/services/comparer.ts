/**
 * Compare: text differences from the engine (`compare.text`: logical-order words, Arabic-aware
 * normalisation, bounded diff), visual differences from PDFium rasters diffed by the engine
 * (`compare.visual`), and a self-contained HTML report (`compare.report`).
 */
import type { EngineClient } from './engine';
import type { Translate } from '../i18n';

export interface CompareOptions {
  /** Ignore tashkeel and tatweel. */
  ignoreDiacritics: boolean;
  /** Treat alef/yaa/taa-marbuta/hamza forms and digit systems alike. */
  normalizeLetters: boolean;
}

export interface PageRect {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Change {
  kind: 'inserted' | 'deleted' | 'changed';
  old: string;
  new: string;
  pageA: number;
  pageB: number;
  rectsA: PageRect[];
  rectsB: PageRect[];
}

export interface TextDiff {
  summary: { inserted: number; deleted: number; changed: number; wordsA: number; wordsB: number; pagesA: number; pagesB: number; truncated: boolean };
  changes: Change[];
}

export interface Raster {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface VisualDiff {
  width: number;
  height: number;
  changedPixels: number;
  ratio: number;
  /** [x, y, w, h] in pixels of the rasters. */
  boxes: [number, number, number, number][];
  overlay: Uint8Array;
}

let seq = 0;

/** Text differences between A (the open document) and B. */
export async function compareText(engine: EngineClient, a: Uint8Array, b: Uint8Array, options: CompareOptions): Promise<TextDiff> {
  const docId = `compare-${Date.now().toString(36)}-${++seq}`;
  await engine.open(docId, a);
  try {
    const r = await engine.call<TextDiff>(docId, 'compare.text', { options }, [b.slice()]);
    return r.json;
  } finally {
    await engine.close(docId).catch(() => {});
  }
}

/** Decodes a PNG (from PDFium) into RGBA pixels. */
export async function pngToRaster(png: Blob): Promise<Raster> {
  const bmp = await createImageBitmap(png);
  try {
    const canvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('2d canvas unavailable');
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { width: bmp.width, height: bmp.height, rgba: new Uint8Array(data.buffer.slice(0)) };
  } finally {
    bmp.close();
  }
}

/** Pixel differences of two page rasters (threshold 0–255 per channel). */
export async function visualDiff(engine: EngineClient, a: Raster, b: Raster, threshold = 48): Promise<VisualDiff> {
  const r = await engine.callStatic<Omit<VisualDiff, 'overlay'>>(
    'compare.visual',
    { widthA: a.width, heightA: a.height, widthB: b.width, heightB: b.height, threshold },
    [a.rgba, b.rgba],
  );
  return { ...r.json, overlay: r.blobs[0]! };
}

export interface ReportLabels {
  title: string;
  original: string;
  revised: string;
  summary: string;
  inserted: string;
  deleted: string;
  changed: string;
  page: string;
  before: string;
  after: string;
  noChanges: string;
  textChanges: string;
  visualChanges: string;
  truncated: string;
}

export function reportLabels(t: Translate): ReportLabels {
  return {
    title: t('compare.report.title'),
    original: t('compare.original'),
    revised: t('compare.revised'),
    summary: t('compare.summary'),
    inserted: t('compare.kind.inserted'),
    deleted: t('compare.kind.deleted'),
    changed: t('compare.kind.changed'),
    page: t('compare.report.page'),
    before: t('compare.report.before'),
    after: t('compare.report.after'),
    noChanges: t('compare.noChanges'),
    textChanges: t('compare.report.textChanges'),
    visualChanges: t('compare.report.visualChanges'),
    truncated: t('compare.report.truncated'),
  };
}

export interface ReportRequest {
  locale: string;
  nameA: string;
  nameB: string;
  labels: ReportLabels;
  text: TextDiff;
  /** Pages with visual differences and their overlay PNGs. */
  visual: { page: number; regions: number; overlay: Uint8Array }[];
}

/** Self-contained HTML report (no scripts, inline CSS, overlays as data: URIs). */
export async function buildReport(engine: EngineClient, req: ReportRequest): Promise<Uint8Array> {
  const r = await engine.callStatic(
    'compare.report',
    {
      locale: req.locale,
      nameA: req.nameA,
      nameB: req.nameB,
      labels: req.labels,
      text: req.text,
      visual: req.visual.map((v, i) => ({ page: v.page, regions: v.regions, blob: i })),
    },
    req.visual.map((v) => v.overlay.slice()),
  );
  return r.blobs[0]!;
}

/** `contract.pdf` → `contract-comparison.html` (localised suffix). */
export function reportFileName(nameA: string, suffix: string): string {
  return `${nameA.replace(/\.pdf$/i, '') || 'document'}-${suffix}.html`;
}
