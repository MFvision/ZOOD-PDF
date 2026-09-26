/**
 * The viewer's own PDFium (the exact wasm EmbedPDF 2.15.1 ships, the engine of Chrome's PDF viewer)
 * loaded in Node, to measure what PDFium-based readers get from saved bytes: the page text that
 * search and copy work on (`FPDFText_GetText`) and PDFium's own search (`FPDFText_FindStart`).
 * `flatten` first draws annotation appearances (a visible signature) into the page, as printing or
 * flattening does, so their text is measured too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './helpers';

interface PdfiumModule {
  PDFiumExt_Init(): void;
  FPDF_LoadMemDocument(ptr: number, size: number, password: string): number;
  FPDF_CloseDocument(doc: number): void;
  FPDF_GetPageCount(doc: number): number;
  FPDF_LoadPage(doc: number, index: number): number;
  FPDF_ClosePage(page: number): void;
  FPDFPage_Flatten(page: number, flag: number): number;
  FPDFText_LoadPage(page: number): number;
  FPDFText_ClosePage(tp: number): void;
  FPDFText_CountChars(tp: number): number;
  FPDFText_GetText(tp: number, start: number, count: number, buf: number): number;
  FPDFText_FindStart(tp: number, query: number, flags: number, start: number): number;
  FPDFText_FindNext(h: number): number;
  FPDFText_FindClose(h: number): void;
  pdfium: {
    wasmExports: { malloc(n: number): number; free(p: number): void };
    HEAPU8: Uint8Array;
    UTF16ToString(ptr: number): string;
    stringToUTF16(s: string, ptr: number, max: number): void;
  };
}

let mod: Promise<PdfiumModule> | null = null;

function load(): Promise<PdfiumModule> {
  mod ??= (async () => {
    // Resolved next to @embedpdf/snippet, whose dist/pdfium.wasm the app serves (same file).
    const snippet = fs.realpathSync(path.join(ROOT, 'packages/ui/node_modules/@embedpdf/snippet/package.json'));
    const req = createRequire(snippet);
    const entry = req.resolve('@embedpdf/pdfium');
    const { init } = req(entry) as { init(o: { wasmBinary: Buffer }): Promise<PdfiumModule> };
    const m = await init({ wasmBinary: fs.readFileSync(path.join(path.dirname(snippet), 'dist/pdfium.wasm')) });
    m.PDFiumExt_Init();
    return m;
  })();
  return mod;
}

export interface PdfiumText {
  /** Page texts as PDFium extracts them (what copy returns), U+FFFE/U+0002 markers removed. */
  pages: string[];
  /** Matches of PDFium's own search (what EmbedPDF's search panel finds) over all pages. */
  count(query: string): number;
  close(): void;
}

/** PDFium's line-break markers (U+FFFE after a hyphen-like break, U+0002), as EmbedPDF strips them. */
const stripMarkers = (s: string) => [...s].filter((c) => c.charCodeAt(0) !== 0xfffe && c.charCodeAt(0) !== 2).join('');

/** Opens `bytes` in PDFium. `flatten`: draw annotation appearances into the page first. */
export async function pdfiumText(bytes: Uint8Array, opts: { flatten?: boolean } = {}): Promise<PdfiumText> {
  const m = await load();
  const heap = m.pdfium.wasmExports;
  const data = heap.malloc(bytes.length);
  m.pdfium.HEAPU8.set(bytes, data);
  const doc = m.FPDF_LoadMemDocument(data, bytes.length, '');
  if (!doc) throw new Error('PDFium could not open the document');
  const textPages: number[] = [];
  const pagePtrs: number[] = [];
  const pages: string[] = [];
  for (let i = 0; i < m.FPDF_GetPageCount(doc); i++) {
    let page = m.FPDF_LoadPage(doc, i);
    if (opts.flatten) {
      m.FPDFPage_Flatten(page, 0);
      // The flattened content is read on the next load of the page.
      m.FPDF_ClosePage(page);
      page = m.FPDF_LoadPage(doc, i);
    }
    const tp = m.FPDFText_LoadPage(page);
    const n = m.FPDFText_CountChars(tp);
    const buf = heap.malloc(2 * (n + 1));
    m.FPDFText_GetText(tp, 0, n, buf);
    pages.push(stripMarkers(m.pdfium.UTF16ToString(buf)));
    heap.free(buf);
    textPages.push(tp);
    pagePtrs.push(page);
  }
  return {
    pages,
    count(query: string) {
      let hits = 0;
      const size = 2 * (query.length + 1);
      const q = heap.malloc(size);
      m.pdfium.stringToUTF16(query, q, size);
      for (const tp of textPages) {
        const h = m.FPDFText_FindStart(tp, q, 0, 0);
        while (m.FPDFText_FindNext(h)) hits++;
        m.FPDFText_FindClose(h);
      }
      heap.free(q);
      return hits;
    },
    close() {
      for (const tp of textPages) m.FPDFText_ClosePage(tp);
      for (const p of pagePtrs) m.FPDF_ClosePage(p);
      m.FPDF_CloseDocument(doc);
      heap.free(data);
    },
  };
}
