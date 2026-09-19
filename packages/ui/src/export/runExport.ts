import type { RemoteDocument } from '../core/client';
import { documentStem, exportFileName, pageImageName, pagesArchiveName } from '../state/saveFile';
import type { FileKind } from '../state/saveFile';
import { buildDocx } from './docx';
import { FILE_KINDS } from './formats';
import type { ExportFormat } from './formats';
import { paragraphsOf } from './paragraphs';
import { encodePng, zipImages } from './png';
import { buildPptx } from './pptx';
import type { Slide, SlideText } from './pptx';
import { pageSheet, sheetHasText, tableSheets } from './tables';
import type { PageItem, Sheet, SheetMode } from './tables';
import { buildHtml, buildMarkdown, buildText, cleanText } from './text';
import type { ExportPage } from './text';
import { buildXlsx } from './xlsx';

/**
 * The most pixels one page image may have. A3 at 300 dpi (17 million) fits; a
 * poster at 300 dpi would need gigabytes in the core's memory, so it is drawn
 * at the resolution that does fit, and the panel says so.
 */
export const MAX_PAGE_PIXELS = 25_000_000;

export interface ExportRequest {
  format: ExportFormat;
  /** Page images only: dots per inch. */
  dpi: number;
  /** Excel only: a sheet for each page, or for each table found. */
  sheets?: SheetMode;
  /** PowerPoint only: each page's picture behind its text, or its text alone. */
  slides?: SlideMode;
  /** The open file's name; the export is named after it. */
  name: string;
  /** The page headings of Markdown and HTML, and Excel's sheets: "Page 3", "الصفحة 3". */
  pageLabel: (page: number) => string;
  /** Excel's sheets of tables: "Table 2", "الجدول 2". */
  tableLabel?: (table: number) => string;
  /** The word in the name of the page images' zip: "report (pages).zip". */
  pagesWord: string;
  /** After each page: how many are done, of how many. */
  onProgress?: (done: number, total: number) => void;
}

export interface ExportResult {
  bytes: Uint8Array<ArrayBuffer>;
  fileName: string;
  kind: FileKind;
  /** Some page images were too large for the chosen resolution and were drawn at a lower one. */
  reduced: boolean;
}

/** The reading side of a document, as `RemoteDocument` offers it. */
export type ExportableDocument = Pick<
  RemoteDocument,
  'pageCount' | 'pageSizes' | 'extract_text' | 'text_lines' | 'paragraphs' | 'render_page' | 'call'
>;

/** What export needs from the app: the file as it stands, and a core to read it with. */
export interface ExportSource {
  client: { open(bytes: ArrayBuffer, password?: string): Promise<ExportableDocument & { free(): Promise<void> }> };
  currentFileBytes: () => Promise<ArrayBuffer | null>;
  documentPassword: string | undefined;
}

/**
 * Exports the file as it is now, never the copy Warraq opened.
 *
 * Comments, filled fields and above all redactions are made in EmbedPDF after
 * the file was opened, and Warraq's own copy (`services.document`) does not
 * see them while EmbedPDF is on screen: exporting from it would hand back the
 * very text the person redacted. So the current bytes are opened as a
 * temporary document, read, and freed again whatever happens.
 *
 * Null when a text format finds no text at all — a scan, most likely.
 */
export async function exportCurrentFile(
  source: ExportSource,
  request: ExportRequest,
  password: string | undefined = source.documentPassword,
): Promise<ExportResult | null> {
  const bytes = await source.currentFileBytes();
  if (!bytes) throw new Error('E_NO_FILE: there is no file to export');
  const doc = await source.client.open(bytes, password);
  try {
    return await exportDocument(doc, request);
  } finally {
    await doc.free().catch(() => undefined);
  }
}

/** One export of an open document; `exportCurrentFile` is the one to call. */
export async function exportDocument(doc: ExportableDocument, request: ExportRequest): Promise<ExportResult | null> {
  if (doc.pageCount < 1) return null;
  switch (request.format) {
    case 'png':
      return exportImages(doc, request);
    case 'xlsx':
      return exportSheets(doc, request);
    case 'pptx':
      return exportSlides(doc, request);
    default:
      return exportText(doc, request.format, request);
  }
}

/** PowerPoint: each page's picture behind its text boxes, or only the text boxes. */
export type SlideMode = 'picture' | 'text';

/**
 * Excel: what the core finds on each page (`export.tables`) — tables drawn
 * with rules or lined up in columns, and the lines around them — as a
 * sheet for each page, or a sheet for each table. A document with no
 * tables at all still gets its pages.
 */
async function exportSheets(doc: ExportableDocument, request: ExportRequest): Promise<ExportResult | null> {
  const pages: PageItem[][] = [];
  for (let index = 0; index < doc.pageCount; index += 1) {
    const { result } = await doc.call<{ items: PageItem[] }>('export.tables', { page: index });
    pages.push(result.items);
    request.onProgress?.(index + 1, doc.pageCount);
  }
  let sheets: Sheet[] = request.sheets === 'table' ? tableSheets(pages, (k) => request.tableLabel?.(k) ?? `Table ${k}`) : [];
  if (sheets.length === 0) sheets = pages.map((items, index) => pageSheet(items, request.pageLabel(index + 1)));
  if (!sheets.some(sheetHasText)) return null;
  return { bytes: buildXlsx(sheets), fileName: exportFileName(request.name, 'xlsx'), kind: FILE_KINDS.xlsx, reduced: false };
}

/** PowerPoint's page pictures: sharp enough to read at 144 dpi, within the pixel budget. */
const SLIDE_SCALE = 2;

/**
 * The colour a paragraph's text is drawn in: the page drawn with its text
 * and without it differ exactly where the letters are, and those pixels of
 * the first are the ink. Black when nothing tells.
 */
export function inkColour(
  full: Uint8Array | Uint8ClampedArray,
  bare: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number },
): string {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width));
  const y1 = Math.min(height, Math.ceil(box.y + box.height));
  const strongest: [number, number, number][] = [];
  const faint: [number, number, number][] = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = (y * width + x) * 4;
      const difference = Math.abs(full[p]! - bare[p]!) + Math.abs(full[p + 1]! - bare[p + 1]!) + Math.abs(full[p + 2]! - bare[p + 2]!);
      if (difference > 300) strongest.push([full[p]!, full[p + 1]!, full[p + 2]!]);
      else if (difference > 60) faint.push([full[p]!, full[p + 1]!, full[p + 2]!]);
    }
  }
  const ink = strongest.length >= 4 ? strongest : faint;
  if (ink.length === 0) return '000000';
  const mean = [0, 1, 2].map((c) => Math.round(ink.reduce((sum, px) => sum + px[c]!, 0) / ink.length));
  return mean.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** PowerPoint: each page a slide, its picture without text behind its paragraphs as text boxes. */
async function exportSlides(doc: ExportableDocument, request: ExportRequest): Promise<ExportResult> {
  const slides: Slide[] = [];
  let reduced = false;
  for (let index = 0; index < doc.pageCount; index += 1) {
    const [width, height] = doc.pageSizes[index] ?? [612, 792];
    const fits = Math.sqrt(MAX_PAGE_PIXELS / Math.max(1, width * SLIDE_SCALE * height * SLIDE_SCALE));
    const scale = fits < 1 ? SLIDE_SCALE * fits : SLIDE_SCALE;
    if (fits < 1) reduced = true;
    const textOnly = request.slides === 'text';
    const [lines, blocks, picture] = await Promise.all([
      doc.text_lines(index),
      doc.paragraphs(index),
      textOnly
        ? Promise.resolve({ result: { width: 0, height: 0, textHidden: false }, blobs: [] as ArrayBuffer[] })
        : doc.call<{ width: number; height: number; textHidden: boolean }>('export.picture', { page: index, scale }),
    ]);
    const bare = new Uint8Array(picture.blobs[0] ?? new ArrayBuffer(0));
    const { width: w, height: h, textHidden } = picture.result;
    const paragraphs = paragraphsOf(lines, blocks).filter((p) => (p.lines?.length ?? 0) > 0);
    // Only for the text's colour; a scan's text is invisible anyway, and
    // text alone is black.
    const full = !textOnly && !textHidden && paragraphs.length > 0 ? await doc.render_page(index, scale) : null;
    const texts: SlideText[] = paragraphs.map((p) => {
      const own = p.lines!;
      const x = Math.min(...own.map((l) => l.x));
      const y = Math.min(...own.map((l) => l.y));
      const box = {
        x,
        y,
        width: Math.max(...own.map((l) => l.x + l.width)) - x,
        height: Math.max(...own.map((l) => l.y + l.height)) - y,
      };
      // Text set up the page has boxes far taller than wide: its size is its thickness.
      const vertical = own.every((l) => l.height > l.width * 2.5) && own.some((l) => l.text.trim().length > 2);
      const size = vertical
        ? Math.max(4, Math.min(96, Math.min(...own.map((l) => l.width)) / 1.2))
        : (p.fontSize ?? Math.max(4, Math.min(96, own[0]!.height / 1.2)));
      const steps = own.slice(1).map((l, k) => l.y - own[k]!.y);
      const pitch = steps.length > 0 ? steps.reduce((a, b) => a + b, 0) / steps.length : null;
      const colour =
        full && full.width === w && full.height === h
          ? inkColour(full.rgba, bare, w, h, { x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale })
          : '000000';
      return {
        ...box,
        lines: own.map((l) => l.text.trim()),
        direction: p.direction,
        alignment: p.alignment,
        size,
        pitch,
        color: colour,
        vertical,
      };
    });
    slides.push({
      width,
      height,
      picture: w > 0 && h > 0 && bare.length >= w * h * 4 ? encodePng(w, h, bare, scale * 72) : null,
      texts,
      hiddenText: textHidden,
    });
    request.onProgress?.(index + 1, doc.pageCount);
  }
  return { bytes: buildPptx(slides), fileName: exportFileName(request.name, 'pptx'), kind: FILE_KINDS.pptx, reduced };
}

/** Every page as Warraq's core reads it: the text in reading order, and as paragraphs. */
async function readPages(doc: ExportableDocument, onProgress: ExportRequest['onProgress']): Promise<ExportPage[]> {
  const pages: ExportPage[] = [];
  for (let index = 0; index < doc.pageCount; index += 1) {
    const text = await doc.extract_text(index);
    const [lines, blocks] = await Promise.all([doc.text_lines(index), doc.paragraphs(index)]);
    pages.push({ number: index + 1, text, paragraphs: paragraphsOf(lines, blocks) });
    onProgress?.(index + 1, doc.pageCount);
  }
  return pages;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

async function exportText(
  doc: ExportableDocument,
  format: Exclude<ExportFormat, 'png' | 'xlsx' | 'pptx'>,
  request: ExportRequest,
): Promise<ExportResult | null> {
  const pages = await readPages(doc, request.onProgress);
  if (pages.every((page) => cleanText(page.text).trim().length === 0)) return null;
  const options = { title: documentStem(request.name), pageLabel: request.pageLabel };
  const bytes =
    format === 'docx'
      ? buildDocx(pages, doc.pageSizes[0])
      : format === 'md'
        ? utf8(buildMarkdown(pages, options))
        : format === 'html'
          ? utf8(buildHtml(pages, options))
          : // A byte-order mark, so Word and older Windows editors read the text as UTF-8, not as a code page.
            utf8(`\uFEFF${buildText(pages)}`);
  return { bytes, fileName: exportFileName(request.name, format), kind: FILE_KINDS[format], reduced: false };
}

/** Every page drawn by the core and written as a PNG; one page is one image, more are a zip. */
async function exportImages(doc: ExportableDocument, request: ExportRequest): Promise<ExportResult> {
  const total = doc.pageCount;
  const wanted = request.dpi / 72;
  const images: Uint8Array<ArrayBuffer>[] = [];
  let reduced = false;
  for (let index = 0; index < total; index += 1) {
    const [width, height] = doc.pageSizes[index] ?? [0, 0];
    const fits = Math.sqrt(MAX_PAGE_PIXELS / Math.max(1, width * wanted * height * wanted));
    const scale = fits < 1 ? wanted * fits : wanted;
    if (fits < 1) reduced = true;
    const page = await doc.render_page(index, scale);
    images.push(encodePng(page.width, page.height, page.rgba, scale * 72));
    request.onProgress?.(index + 1, total);
  }
  if (images.length === 1) {
    return { bytes: images[0]!, fileName: exportFileName(request.name, 'png'), kind: FILE_KINDS.png, reduced };
  }
  const bytes = zipImages(images.map((png, index) => ({ name: pageImageName(request.name, index + 1, total), bytes: png })));
  return { bytes, fileName: pagesArchiveName(request.name, request.pagesWord), kind: FILE_KINDS.zip, reduced };
}
