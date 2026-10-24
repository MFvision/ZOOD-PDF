import type { RemoteDocument } from '../core/client';
import type { TextLineData } from '../core/types';
import { documentStem, exportFileName, pageImageName, pagesArchiveName } from '../state/saveFile';
import type { FileKind } from '../state/saveFile';
import { buildDocx, readsRtl } from './docx';
import { buildLayoutDocx } from './docxLayout';
import { FILE_KINDS } from './formats';
import type { ExportFormat, ImageFormat } from './formats';
import { paragraphsOf, trimLine } from './paragraphs';
import { encodePng, zipImages } from './png';
import { buildPptx } from './pptx';
import type { Slide, SlideText } from './pptx';
import { compactTable, linkSheets, pageSheet, sheetHasText, tableSheets } from './tables';
import type { PageItem, Sheet, SheetMode } from './tables';
import { cellBoxes, cellPlace, linesIn, outsideTables, pageTables, tableBox } from './structure';
import type { LayoutTable } from './structure';
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
  /** Word only: the layout kept (the default), or flowing text alone. */
  words?: WordMode;
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
    case 'jpg':
    case 'webp':
      return exportImages(doc, request);
    case 'xlsx':
      return exportSheets(doc, request);
    case 'pptx':
      return exportSlides(doc, request);
    case 'docx':
      return request.words === 'text' ? exportText(doc, 'docx', request) : exportWordLayout(doc, request);
    default:
      return exportText(doc, request.format, request);
  }
}

/** PowerPoint: each page's picture behind its text boxes, or only the text boxes. */
export type SlideMode = 'picture' | 'text';

/** Word: each page as it looks, or the text as flowing paragraphs. */
export type WordMode = 'layout' | 'text';

/**
 * Excel: what the core finds on each page (`export.tables`) — tables drawn
 * with rules or lined up in columns, and the lines around them — as a
 * sheet for each page, or a sheet for each table. A document with no
 * tables at all still gets its pages.
 */
async function exportSheets(doc: ExportableDocument, request: ExportRequest): Promise<ExportResult | null> {
  const pages: PageItem[][] = [];
  const linked: { text: string; uri: string }[] = [];
  for (let index = 0; index < doc.pageCount; index += 1) {
    const [{ result }, { result: read }] = await Promise.all([
      doc.call<{ items: PageItem[] }>('export.tables', { page: index }),
      doc.call<{ lines: TextLineData[] }>('export.lines', { page: index, reading: true }),
    ]);
    // Tables without their empty columns and rows; one with nothing in it is no table.
    pages.push(result.items.flatMap((item): PageItem[] => (item.kind !== 'table' ? [item] : [compactTable(item)].filter((table) => table.rows.length > 0))));
    for (const line of read.lines) {
      const own = trimLine(line);
      for (const link of own.links) linked.push({ text: own.text.slice(link.from, link.to), uri: link.uri });
    }
    request.onProgress?.(index + 1, doc.pageCount);
  }
  let sheets: Sheet[] = request.sheets === 'table' ? tableSheets(pages, (k) => request.tableLabel?.(k) ?? `Table ${k}`) : [];
  if (sheets.length === 0) sheets = pages.map((items, index) => pageSheet(items, request.pageLabel(index + 1)));
  if (!sheets.some(sheetHasText)) return null;
  linkSheets(sheets, linked);
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
  return inkOf(full, bare, width, height, box) ?? '000000';
}

/**
 * The ink of `inkColour`, or null where the two drawings do not differ: the
 * text is part of the picture itself (letters a picture is painted through).
 */
export function inkOf(
  full: Uint8Array | Uint8ClampedArray,
  bare: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number },
): string | null {
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
  if (ink.length === 0) return null;
  const mean = [0, 1, 2].map((c) => Math.round(ink.reduce((sum, px) => sum + px[c]!, 0) / ink.length));
  return mean.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Each page laid out as it is: its picture drawn without text (or, for a
 * scan, as it is) and its paragraphs as boxes where they were, in their
 * lines, size, colour and face. PowerPoint's slides and Word's layout pages.
 * `withPicture` false: the boxes alone, in black.
 */
async function layoutPages(
  doc: ExportableDocument,
  request: ExportRequest,
  withPicture: boolean,
  withTables = false,
): Promise<{ pages: Slide[]; reduced: boolean }> {
  const pages: Slide[] = [];
  let reduced = false;
  for (let index = 0; index < doc.pageCount; index += 1) {
    const [width, height] = doc.pageSizes[index] ?? [612, 792];
    const fits = Math.sqrt(MAX_PAGE_PIXELS / Math.max(1, width * SLIDE_SCALE * height * SLIDE_SCALE));
    const scale = fits < 1 ? SLIDE_SCALE * fits : SLIDE_SCALE;
    if (fits < 1 && withPicture) reduced = true;
    // The editor's lines: one crossing a table's columns is cut into a piece per column.
    const [{ result: { lines } }, blocks, picture, items] = await Promise.all([
      doc.call<{ lines: TextLineData[] }>('export.lines', { page: index }),
      doc.paragraphs(index),
      withPicture
        ? doc.call<{ width: number; height: number; textHidden: boolean }>('export.picture', { page: index, scale })
        : Promise.resolve({ result: { width: 0, height: 0, textHidden: false }, blobs: [] as ArrayBuffer[] }),
      withTables ? doc.call<{ items: PageItem[] }>('export.tables', { page: index }).then((reply) => reply.result.items) : Promise.resolve([] as PageItem[]),
    ]);
    const bare = new Uint8Array(picture.blobs[0] ?? new ArrayBuffer(0));
    const { width: w, height: h, textHidden } = picture.result;
    const found = pageTables(items, lines);
    const paragraphs = paragraphsOf(outsideTables(lines, found), blocks).filter((p) => (p.lines?.length ?? 0) > 0);
    // Only for the text's colour; a scan's text is invisible anyway, and
    // text alone is black.
    const full = withPicture && !textHidden && (paragraphs.length > 0 || found.length > 0) ? await doc.render_page(index, scale) : null;
    const inkAt = (box: { x: number; y: number; width: number; height: number }) =>
      full && full.width === w && full.height === h
        ? inkOf(full.rgba, bare, w, h, { x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale })
        : undefined;
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
      const ink = inkAt(box);
      const trimmed = own.map(trimLine);
      return {
        ...box,
        lines: trimmed.map((l) => l.text),
        direction: p.direction,
        alignment: p.alignment,
        size,
        pitch,
        color: ink ?? '000000',
        vertical,
        ...(p.font ? { font: p.font } : {}),
        // Drawn into the picture already: there to find and copy, not to see twice.
        ...(ink === null ? { hidden: true } : {}),
        ...(trimmed.some((l) => l.links.length > 0) ? { links: trimmed.map((l) => l.links) } : {}),
      };
    });
    const tables: LayoutTable[] = found.map((table) => {
      const inside = linesIn(lines, tableBox(table));
      // The table's type: the size and face most of its cells are set in.
      const sized = paragraphsOf(inside, blocks);
      const sizes = inside.map((l) => l.height / 1.2).sort((a, b) => a - b);
      const size = sized.find((p) => p.fontSize !== null)?.fontSize ?? Math.max(4, Math.min(96, sizes[Math.floor(sizes.length / 2)] ?? 10));
      const boxes = cellBoxes(table);
      const looks = table.rows.map((row, r) =>
        row.map((cell, c) => {
          const box = boxes[r]?.[c];
          if (!cell || !box) return null;
          // Where the core found its letters; failing that, the lines in it.
          const own: Pick<TextLineData, 'x' | 'y' | 'width' | 'height' | 'direction'>[] = cell.box
            ? [{ x: cell.box[0], y: cell.box[1], width: cell.box[2], height: cell.box[3], direction: readsRtl(cell.text) ? 'rtl' : 'ltr' }]
            : linesIn(inside, box);
          const ink = own.length > 0 ? inkAt(own.reduce((a, l) => union(a, l), { x: own[0]!.x, y: own[0]!.y, width: 0, height: 0 })) : undefined;
          return { color: ink ?? '000000', place: cellPlace(box, own), ...(ink === null ? { hidden: true } : {}) };
        }),
      );
      const font = sized.find((p) => p.font)?.font;
      const insets = looks.flat().flatMap((look) => (look && look.place.align !== 'center' ? [look.place.inset] : [])).sort((a, b) => a - b);
      // Half the usual inset: a cell's text a little nearer its side, rather
      // than wrapped when Word's face is a little wider than the page's.
      const margin = Math.min(6, (insets[Math.floor(insets.length / 2)] ?? 2) / 2);
      return { ...table, size, looks, margin, ...(font ? { font } : {}) };
    });
    const hasPicture = w > 0 && h > 0 && bare.length >= w * h * 4 && (textHidden || !blank(bare));
    pages.push({
      width,
      height,
      picture: hasPicture ? encodePng(w, h, bare, scale * 72) : null,
      texts,
      hiddenText: textHidden,
      ...(tables.length > 0 ? { tables } : {}),
    });
    request.onProgress?.(index + 1, doc.pageCount);
  }
  return { pages, reduced };
}

/** The smallest box round two. */
function union(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** A picture that is white paper and nothing else: no use behind the text. */
export function blank(rgba: Uint8Array | Uint8ClampedArray): boolean {
  for (let p = 0; p < rgba.length; p += 4) {
    if (rgba[p]! < 248 || rgba[p + 1]! < 248 || rgba[p + 2]! < 248) return false;
  }
  return true;
}

/** PowerPoint: each page a slide, its picture without text behind its paragraphs as text boxes. */
async function exportSlides(doc: ExportableDocument, request: ExportRequest): Promise<ExportResult> {
  const { pages, reduced } = await layoutPages(doc, request, request.slides !== 'text');
  return { bytes: buildPptx(pages), fileName: exportFileName(request.name, 'pptx'), kind: FILE_KINDS.pptx, reduced };
}

/** Word, the layout kept: each page a Word page, its picture behind its paragraphs as text boxes. */
async function exportWordLayout(doc: ExportableDocument, request: ExportRequest): Promise<ExportResult | null> {
  const { pages, reduced } = await layoutPages(doc, request, true, true);
  if (pages.every((page) => page.picture === null && page.texts.length === 0 && !page.tables)) return null;
  return { bytes: buildLayoutDocx(pages), fileName: exportFileName(request.name, 'docx'), kind: FILE_KINDS.docx, reduced };
}

/**
 * Every page as Warraq's core reads it: the text in reading order, its
 * tables, and the rest as paragraphs, links and all.
 */
async function readPages(doc: ExportableDocument, onProgress: ExportRequest['onProgress']): Promise<ExportPage[]> {
  const pages: ExportPage[] = [];
  for (let index = 0; index < doc.pageCount; index += 1) {
    const text = await doc.extract_text(index);
    const [
      {
        result: { lines },
      },
      {
        result: { items },
      },
      blocks,
    ] = await Promise.all([
      doc.call<{ lines: TextLineData[] }>('export.lines', { page: index, reading: true }),
      doc.call<{ items: PageItem[] }>('export.tables', { page: index }),
      doc.paragraphs(index),
    ]);
    const tables = pageTables(items, lines);
    pages.push({ number: index + 1, text, paragraphs: paragraphsOf(outsideTables(lines, tables), blocks), tables });
    onProgress?.(index + 1, doc.pageCount);
  }
  return pages;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

async function exportText(
  doc: ExportableDocument,
  format: Exclude<ExportFormat, ImageFormat | 'xlsx' | 'pptx'>,
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

/** JPG's quality: pages of text stay crisp, at about a third of a PNG's size. */
export const JPEG_QUALITY = 88;

/**
 * Every page drawn by the core and written as a picture; one page is one
 * image, more are a zip. PNG is written here; JPG and WebP by the core
 * (`export.image`), as a webview's canvas cannot write WebP everywhere.
 */
async function exportImages(doc: ExportableDocument, request: ExportRequest): Promise<ExportResult> {
  const format: ImageFormat = request.format === 'jpg' || request.format === 'webp' ? request.format : 'png';
  const total = doc.pageCount;
  const wanted = request.dpi / 72;
  const images: Uint8Array<ArrayBuffer>[] = [];
  let reduced = false;
  for (let index = 0; index < total; index += 1) {
    const [width, height] = doc.pageSizes[index] ?? [0, 0];
    const fits = Math.sqrt(MAX_PAGE_PIXELS / Math.max(1, width * wanted * height * wanted));
    const scale = fits < 1 ? wanted * fits : wanted;
    if (fits < 1) reduced = true;
    if (format === 'png') {
      const page = await doc.render_page(index, scale);
      images.push(encodePng(page.width, page.height, page.rgba, scale * 72));
    } else {
      const { blobs } = await doc.call('export.image', { page: index, scale, format: format === 'jpg' ? 'jpeg' : 'webp', quality: JPEG_QUALITY });
      if (!blobs[0]) throw new Error('E_IMAGE: the core wrote no picture');
      images.push(new Uint8Array(blobs[0]));
    }
    request.onProgress?.(index + 1, total);
  }
  if (images.length === 1) {
    return { bytes: images[0]!, fileName: exportFileName(request.name, format), kind: FILE_KINDS[format], reduced };
  }
  const bytes = zipImages(images.map((image, index) => ({ name: pageImageName(request.name, index + 1, total, format), bytes: image })));
  return { bytes, fileName: pagesArchiveName(request.name, request.pagesWord), kind: FILE_KINDS.zip, reduced };
}
