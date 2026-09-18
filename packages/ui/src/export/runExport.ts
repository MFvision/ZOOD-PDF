import type { RemoteDocument } from '../core/client';
import { documentStem, exportFileName, pageImageName, pagesArchiveName } from '../state/saveFile';
import type { FileKind } from '../state/saveFile';
import { buildDocx } from './docx';
import { FILE_KINDS } from './formats';
import type { ExportFormat } from './formats';
import { paragraphsOf } from './paragraphs';
import { encodePng, zipImages } from './png';
import { buildHtml, buildMarkdown, buildText, cleanText } from './text';
import type { ExportPage } from './text';

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
  /** The open file's name; the export is named after it. */
  name: string;
  /** The page headings of Markdown and HTML: "Page 3", "الصفحة 3". */
  pageLabel: (page: number) => string;
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
  'pageCount' | 'pageSizes' | 'extract_text' | 'text_lines' | 'paragraphs' | 'render_page'
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
  return request.format === 'png' ? exportImages(doc, request) : exportText(doc, request.format, request);
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
  format: Exclude<ExportFormat, 'png'>,
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
