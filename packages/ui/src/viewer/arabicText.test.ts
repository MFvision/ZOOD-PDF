import { describe, expect, it } from 'vitest';
import { hookEngineText, selectionText, taskOf, type HookableEngine, type PageText } from './arabicText';

const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

// One RTL line «تقرير الربع الأول» (words in logical order, the first word right-most) and one below.
const page: PageText = {
  page: 0,
  blocks: [
    {
      paragraphs: [
        {
          lines: [
            {
              words: [
                { text: 'تقرير', bbox: box(300, 100, 340, 112), glyphs: [{ text: 'تقرير', bbox: box(300, 100, 340, 112) }] },
                { text: 'الربع', bbox: box(250, 100, 295, 112) },
                {
                  text: 'الأول',
                  bbox: box(200, 100, 245, 112),
                  glyphs: [
                    { text: 'ا', bbox: box(240, 100, 245, 112) },
                    { text: 'ل', bbox: box(233, 100, 240, 112) },
                    { text: 'أ', bbox: box(225, 100, 233, 112) },
                    { text: 'و', bbox: box(212, 100, 225, 112) },
                    { text: 'ل', bbox: box(200, 100, 212, 112) },
                  ],
                },
              ],
            },
            { words: [{ text: 'سطر', bbox: box(300, 130, 340, 142) }] },
          ],
        },
      ],
    },
  ],
};

describe('logical-order copy', () => {
  it('returns the words under the selected boxes in logical order, whatever order the boxes come in', () => {
    // PDFium hands the characters of the selection in its own (visual, left-to-right) order.
    const rects: [number, number, number, number][] = [
      [200, 100, 246, 112],
      [250, 100, 296, 112],
      [300, 100, 341, 112],
    ];
    expect(selectionText(page, rects)).toBe('تقرير الربع الأول');
  });

  it('keeps partial words as the selected glyphs and joins lines with a newline', () => {
    expect(selectionText(page, [[224, 100, 246, 112]])).toBe('الأ');
    expect(selectionText(page, [[296, 98, 342, 144]])).toBe('تقرير\nسطر');
    expect(selectionText(page, [[0, 0, 10, 10]])).toBe('');
  });
});

describe('EmbedPDF engine hooks', () => {
  function fakeEngine() {
    const calls: string[] = [];
    const engine: HookableEngine = {
      searchAllPages: (doc, kw) => {
        calls.push(`pdfium-search:${doc.id}:${kw}`);
        return taskOf(Promise.resolve({ results: [], total: 0 }));
      },
      getTextSlices: (doc) => {
        calls.push(`pdfium-slices:${doc.id}`);
        return taskOf(Promise.resolve(['لوألا'])); // PDFium's reversed reading
      },
      getPageGeometry: () =>
        taskOf(
          Promise.resolve({
            runs: [{ charStart: 0, glyphs: [{ x: 200, y: 100, width: 45, height: 12 }] }],
          }),
        ),
    };
    return { engine, calls };
  }
  const doc = (id: string, rotation = 0) => ({ id, pages: [{ index: 0, rotation, size: { width: 400, height: 600 } }] });

  it('answers search with the engine for the viewer document (hits in viewer page space)', async () => {
    const { engine, calls } = fakeEngine();
    const restore = hookEngineText(engine, 'd-r0', {
      search: async (q) => [{ page: 0, text: q === 'الاول' ? 'الأول' : '', rects: [[200, 100, 245, 112]] }],
      textIn: async () => '',
    });
    const r = (await engine.searchAllPages(doc('d-r0'), 'الاول').toPromise()) as { results: { pageIndex: number; rects: unknown[]; context: { match: string } }[]; total: number };
    expect(r.total).toBe(1);
    expect(r.results[0]).toMatchObject({ pageIndex: 0, rects: [{ origin: { x: 200, y: 100 }, size: { width: 45, height: 12 } }], context: { match: 'الأول' } });
    // Another document of the same engine (Compare's second file) keeps PDFium.
    await engine.searchAllPages(doc('other'), 'x').toPromise();
    expect(calls).toEqual(['pdfium-search:other:x']);
    restore();
    await engine.searchAllPages(doc('d-r0'), 'y').toPromise();
    expect(calls).toContain('pdfium-search:d-r0:y');
  });

  it('copies in logical order from the engine and falls back to PDFium on rotated pages or errors', async () => {
    const { engine, calls } = fakeEngine();
    let asked: unknown = null;
    hookEngineText(engine, 'd-r0', {
      search: async () => [],
      textIn: async (p, rects) => {
        asked = { p, rects };
        return 'الأول';
      },
    });
    expect(await engine.getTextSlices(doc('d-r0'), [{ pageIndex: 0, charIndex: 0, charCount: 1 }]).toPromise()).toEqual(['الأول']);
    expect(asked).toEqual({ p: 0, rects: [[200, 100, 245, 112]] });
    expect(calls).toEqual([]);
    expect(await engine.getTextSlices(doc('d-r0', 1), [{ pageIndex: 0, charIndex: 0, charCount: 1 }]).toPromise()).toEqual(['لوألا']);
    expect(calls).toEqual(['pdfium-slices:d-r0']);
  });

  it('keeps PDFium for match-case / whole-word searches', async () => {
    const { engine, calls } = fakeEngine();
    hookEngineText(engine, 'd-r0', { search: async () => [], textIn: async () => '' });
    await engine.searchAllPages(doc('d-r0'), 'Word', { flags: [1] }).toPromise();
    expect(calls).toEqual(['pdfium-search:d-r0:Word']);
  });
});
