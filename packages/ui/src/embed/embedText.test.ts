import { MatchFlag, PdfTaskHelper } from '@embedpdf/models';
import type { PageTextSlice, PdfPageGeometry, PdfTask, SearchAllPagesResult, SearchResult } from '@embedpdf/models';
import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';
import { describe, expect, it } from 'vitest';
import { installWarraqText, mergeResults, prefersWarraq, selectedBoxes, toSearchResults } from './embedText';
import type { TextReading, WarraqHit } from './embedText';

const hit = (page: number, text: string, x: number, y: number): WarraqHit => ({
  page,
  text,
  before: 'قبل ',
  after: ' بعد',
  truncatedLeft: false,
  truncatedRight: true,
  rects: [{ x, y, width: 30, height: 12 }],
});

const result = (page: number, x: number, y: number): SearchResult => ({
  pageIndex: page,
  charIndex: 0,
  charCount: 3,
  rects: [{ origin: { x, y }, size: { width: 30, height: 12 } }],
  context: { before: '', match: 'x', after: '', truncatedLeft: false, truncatedRight: false },
});

describe("EmbedPDF's search, answered by Warraq", () => {
  it('turns hits into search results with their boxes and context', () => {
    const results = toSearchResults([hit(0, 'العلم', 100, 50), hit(0, 'علم', 200, 80), hit(2, 'العلم', 10, 10)]);
    expect(results.map((r) => [r.pageIndex, r.charIndex])).toEqual([
      [0, 0],
      [0, 1],
      [2, 0],
    ]);
    expect(results[0]!.rects).toEqual([{ origin: { x: 100, y: 50 }, size: { width: 30, height: 12 } }]);
    expect(results[0]!.context).toEqual({ before: 'قبل ', match: 'العلم', after: ' بعد', truncatedLeft: false, truncatedRight: true });
    expect(toSearchResults([{ ...hit(0, 'x', 0, 0), rects: [] }])).toEqual([]);
  });

  it("keeps PDFium's hits only where Warraq found nothing", () => {
    const warraq = [result(0, 100, 500), result(1, 100, 100)];
    // One where Warraq has a hit already, one in a running head at the top of page 1.
    const pdfium = [result(0, 110, 502), result(1, 50, 20)];
    const merged = mergeResults(warraq, pdfium);
    expect(merged).toHaveLength(3);
    expect(merged.map((r) => [r.pageIndex, r.rects[0]!.origin.y])).toEqual([
      [0, 500],
      [1, 20],
      [1, 100],
    ]);
    expect(mergeResults(warraq, [])).toEqual(warraq);
  });
});

/** A line of five glyphs, 10 pt apart, and a second line below it. */
function geometry(): PdfPageGeometry {
  const glyph = (x: number, y: number, flags = 0) => ({ x, y, width: 8, height: 12, flags });
  return {
    runs: [
      { rect: { x: 0, y: 100, width: 50, height: 12 }, charStart: 0, glyphs: [0, 10, 20, 30, 40].map((x) => glyph(x, 100)) },
      // A space PDFium made up between two words, and an empty glyph.
      { rect: { x: 50, y: 100, width: 30, height: 12 }, charStart: 5, glyphs: [glyph(50, 100, 1), glyph(0, 0, 2), glyph(70, 100)] },
      { rect: { x: 0, y: 130, width: 30, height: 12 }, charStart: 8, glyphs: [0, 10, 20].map((x) => glyph(x, 130)) },
    ],
  };
}

describe('the boxes of a selection', () => {
  it('are one box a line, spaces between the selected words included', () => {
    const boxes = selectedBoxes(geometry(), 2, 9);
    expect(boxes).toEqual([
      { x: 20, y: 100, width: 58, height: 12 },
      { x: 0, y: 130, width: 28, height: 12 },
    ]);
  });

  it('are parted by a glyph that is not selected', () => {
    // Characters 0–1 and 3–4 only: the glyph at x 20 is not selected.
    const g = geometry();
    const first = selectedBoxes(g, 0, 2);
    const later = selectedBoxes(g, 3, 2);
    expect(first).toEqual([{ x: 0, y: 100, width: 18, height: 12 }]);
    expect(later).toEqual([{ x: 30, y: 100, width: 18, height: 12 }]);
    expect(selectedBoxes(g, 20, 5)).toEqual([]);
  });
});

describe("which reading a copy takes", () => {
  it("is Warraq's wherever there is Arabic, and PDFium's for Latin text", () => {
    expect(prefersWarraq('ﺔﻴﺑﺮﻌﻟا', 'العربية')).toBe(true);
    expect(prefersWarraq('', 'العربية')).toBe(true);
    expect(prefersWarraq('Page 3', 'Page 3')).toBe(false);
    // Warraq read nothing there (an artifact it leaves out): PDFium's stands.
    expect(prefersWarraq('ﺔﻴﺑﺮﻌﻟا', ' ')).toBe(false);
  });
});

/** An engine and a registry, as far as the replaced calls go. */
interface FakeEngine {
  searchAllPages(doc: unknown, keyword: string, options?: { flags?: MatchFlag[] }): PdfTask<SearchAllPagesResult>;
  getTextSlices(doc: unknown, slices: PageTextSlice[]): PdfTask<string[]>;
  getPageGeometry(doc: unknown, page: unknown): PdfTask<PdfPageGeometry>;
}

function fakeViewer(pdfiumHits: SearchResult[], pdfiumText: string[]) {
  const engine: FakeEngine = {
    searchAllPages: () => PdfTaskHelper.resolve<SearchAllPagesResult>({ results: pdfiumHits, total: pdfiumHits.length }),
    getTextSlices: () => PdfTaskHelper.resolve(pdfiumText),
    getPageGeometry: () => PdfTaskHelper.resolve(geometry()),
  };
  const registry = { getEngine: () => engine } as unknown as PluginRegistry;
  return { engine, registry };
}

const doc = { id: 'd', pageCount: 1, pages: [{ index: 0, size: { width: 600, height: 800 }, rotation: 0 }] } as never;

describe('the engine calls, replaced', () => {
  it('search asks Warraq, with the flags, and falls back to PDFium without a reading', async () => {
    const { engine, registry } = fakeViewer([result(0, 5, 5)], []);
    const asked: unknown[] = [];
    const reading: TextReading = {
      call: async <T,>(op: string, args?: unknown) => {
        asked.push([op, args]);
        return { result: { matches: [hit(0, 'العلم', 100, 50)], total: 1 } as T };
      },
    };
    let current: TextReading | null = reading;
    const undo = installWarraqText(registry, async () => current);
    const task = engine.searchAllPages(doc, 'العلم', { flags: [MatchFlag.MatchCase] });
    // Warraq's own hits are shown first, before PDFium's joins them.
    const progress: number[] = [];
    task.onProgress((step) => progress.push((step as { results: unknown[] }).results.length));
    const found = await task.toPromise();
    expect(progress).toEqual([1]);
    expect(asked).toEqual([['view.search', { query: 'العلم', matchCase: true, wholeWord: false }]]);
    // Warraq's hit, and PDFium's elsewhere on the page.
    expect(found.results.map((r) => r.rects[0]!.origin.x)).toEqual([5, 100]);
    expect(found.total).toBe(2);

    current = null;
    const pdfium = await engine.searchAllPages(doc, 'x').toPromise();
    expect(pdfium.results).toEqual([result(0, 5, 5)]);
    undo();
  });

  it('copy reads the selected boxes with Warraq where they hold Arabic', async () => {
    const { engine, registry } = fakeViewer([], ['ﺔﻴﺑﺮﻌﻟا']);
    const asked: unknown[] = [];
    installWarraqText(registry, async () => ({
      call: async <T,>(op: string, args?: unknown) => {
        asked.push([op, args]);
        return { result: { text: 'العربية' } as T };
      },
    }));
    const text = await engine.getTextSlices(doc, [{ pageIndex: 0, charIndex: 8, charCount: 3 }]).toPromise();
    expect(text).toEqual(['العربية']);
    expect(asked).toEqual([['view.text', { page: 0, boxes: [{ x: 0, y: 130, width: 28, height: 12 }] }]]);
  });

  it("copy keeps PDFium's text when Warraq's core fails", async () => {
    const { engine, registry } = fakeViewer([], ['ﺔﻴﺑﺮﻌﻟا']);
    installWarraqText(registry, async () => ({
      call: async () => {
        throw new Error('E_PARSE');
      },
    }));
    expect(await engine.getTextSlices(doc, [{ pageIndex: 0, charIndex: 0, charCount: 3 }]).toPromise()).toEqual(['ﺔﻴﺑﺮﻌﻟا']);
  });
});
