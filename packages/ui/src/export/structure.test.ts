import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { TextLineData } from '../core/types';
import { buildDocx } from './docx';
import { buildLayoutDocx, wordFamily } from './docxLayout';
import { PRESENTATION, SPREADSHEET, WORDPROCESSING, validate } from './ooxml.testing';
import type { ExportParagraph } from './paragraphs';
import { trimLine } from './paragraphs';
import { buildPptx } from './pptx';
import type { Slide, SlideText } from './pptx';
import { cellBoxes, cellPlace, linkedPieces, outsideTables, pageBlocks, pageTables } from './structure';
import type { ExportTable, LayoutTable } from './structure';
import { compactTable, linkSheets, tableSheets } from './tables';
import type { TableItem } from './tables';
import { buildHtml, buildMarkdown, buildText, cleanText } from './text';
import type { ExportPage } from './text';
import { buildXlsx } from './xlsx';

const line = (text: string, y: number, extra: Partial<TextLineData> = {}): TextLineData =>
  ({ text, x: 100, y, width: 200, height: 12, direction: 'rtl', ...extra }) as TextLineData;

const para = (text: string, y: number, extra: Partial<ExportParagraph> = {}): ExportParagraph => ({
  text,
  direction: 'rtl',
  alignment: 'start',
  fontSize: 12,
  lines: [line(text, y)],
  ...extra,
});

const cell = (text: string, rows = 1, columns = 1) => ({ text, rows, columns });

/** A right-to-left timetable as the core places it: two columns, three rows, the first drawn right. */
const TIMETABLE: ExportTable = {
  direction: 'rtl',
  ruled: true,
  left: 100,
  top: 200,
  widths: [120, 80],
  heights: [20, 20, 20],
  rows: [
    [cell('اليوم'), cell('المادة')],
    [cell('الأحد'), { ...cell('رياضيات'), links: [{ from: 0, to: 7, uri: 'https://example.org/math' }] }],
    [cell('الاثنين'), cell('علوم')],
  ],
};

const LINKED = 'زوروا موقعنا للمزيد';
const PAGE: ExportPage = {
  number: 1,
  text: '',
  paragraphs: [
    para('جدول الحصص', 150),
    para(LINKED, 300, { links: [{ from: 6, to: 12, uri: 'https://zood.sa/' }] }),
  ],
  tables: [TIMETABLE],
};
const options = { title: 'الجدول', pageLabel: (page: number) => `Page ${page}` };

describe('links and tables in text, Markdown and HTML', () => {
  it('puts each table between the paragraphs it was drawn between', () => {
    expect(pageBlocks(PAGE.paragraphs, PAGE.tables!).map((b) => b.kind)).toEqual(['paragraph', 'table', 'paragraph']);
  });

  it('writes a table as rows of tab-parted cells in plain text', () => {
    const text = buildText([PAGE]);
    expect(text).toContain('اليوم\tالمادة\nالأحد\tرياضيات\nالاثنين\tعلوم');
    expect(text.indexOf('جدول الحصص')).toBeLessThan(text.indexOf('اليوم'));
    expect(text.indexOf('علوم')).toBeLessThan(text.indexOf(LINKED));
  });

  it('writes Markdown pipe tables and links', () => {
    const md = buildMarkdown([PAGE], options);
    expect(md).toContain('| اليوم | المادة |\n| --- | --- |\n| الأحد | [رياضيات](https://example.org/math) |');
    expect(md).toContain('زوروا [موقعنا](https://zood.sa/) للمزيد');
  });

  it('writes an HTML table in its direction and links as links', () => {
    const html = buildHtml([PAGE], options);
    expect(html).toContain('<table dir="rtl">');
    expect(html).toContain('<tr><th>اليوم</th><th>المادة</th></tr>');
    expect(html).toContain('<td><a href="https://example.org/math">رياضيات</a></td>');
    expect(html).toContain('زوروا <a href="https://zood.sa/">موقعنا</a> للمزيد');
  });

  it('merges cells in HTML', () => {
    const merged: ExportTable = { ...TIMETABLE, rows: [[cell('عنوان', 1, 2), null], ...TIMETABLE.rows.slice(1)] };
    expect(buildHtml([{ ...PAGE, tables: [merged] }], options)).toContain('<th colspan="2">عنوان</th>');
  });
});

describe('Word, text kept', () => {
  const parts = unzipSync(buildDocx([PAGE]));
  const xml = strFromU8(parts['word/document.xml']!);

  it('writes a real right-to-left table, and every part as Word wants it', () => {
    for (const [name, data] of Object.entries(parts)) {
      if (/\.(xml|rels)$/.test(name)) expect(validate(strFromU8(data), WORDPROCESSING), name).toEqual([]);
    }
    expect(xml.match(/<w:tbl>/g)).toHaveLength(1);
    expect(xml).toContain('<w:bidiVisual/>');
    expect(xml.match(/<w:tr>/g)).toHaveLength(3);
  });

  it('links text in paragraphs and cells to their addresses', () => {
    const rels = strFromU8(parts['word/_rels/document.xml.rels']!);
    expect(rels).toContain('Target="https://zood.sa/" TargetMode="External"');
    expect(rels).toContain('Target="https://example.org/math" TargetMode="External"');
    expect(xml.match(/<w:hyperlink r:id="/g)).toHaveLength(2);
    expect(strFromU8(parts['word/styles.xml']!)).toContain('w:styleId="Hyperlink"');
  });

  it('merges cells across and down', () => {
    const merged: ExportTable = { ...TIMETABLE, rows: [[cell('عنوان', 1, 2), null], [cell('يومان', 2, 1), cell('أ')], [null, cell('ب')]] };
    const out = strFromU8(unzipSync(buildDocx([{ ...PAGE, tables: [merged] }]))['word/document.xml']!);
    expect(out).toContain('<w:gridSpan w:val="2"/>');
    expect(out).toContain('<w:vMerge w:val="restart"/>');
    expect(out).toContain('<w:vMerge/>');
  });
});

const slideText = (extra: Partial<SlideText> = {}): SlideText => ({
  x: 100,
  y: 300,
  width: 200,
  height: 14,
  lines: [LINKED],
  direction: 'rtl',
  alignment: 'start',
  size: 12,
  pitch: null,
  color: '000000',
  links: [[{ from: 6, to: 12, uri: 'https://zood.sa/' }]],
  ...extra,
});

describe('Word with the layout kept: tables and links', () => {
  const table: LayoutTable = {
    ...TIMETABLE,
    size: 11,
    margin: 4,
    looks: TIMETABLE.rows.map((row) => row.map(() => ({ color: '1a4f8b', place: { align: 'start', valign: 'center', inset: 4 } }))),
  };
  const slides: Slide[] = [{ width: 595, height: 842, picture: null, texts: [slideText()], hiddenText: false, tables: [table] }];
  const parts = unzipSync(buildLayoutDocx(slides));
  const xml = strFromU8(parts['word/document.xml']!);

  it('sets the table where it was, as an editable table, its colours kept', () => {
    for (const [name, data] of Object.entries(parts)) {
      if (/\.(xml|rels)$/.test(name)) expect(validate(strFromU8(data), WORDPROCESSING), name).toEqual([]);
    }
    expect(xml).toContain('<w:tblpPr');
    expect(xml).toContain('<w:bidiVisual/>');
    expect(xml).toContain('رياضيات');
    expect(xml).toContain('<w:color w:val="1A4F8B"/>');
  });

  it('links the linked words of text boxes and cells', () => {
    const rels = strFromU8(parts['word/_rels/document.xml.rels']!);
    expect(rels).toContain('Target="https://zood.sa/"');
    expect(rels).toContain('Target="https://example.org/math"');
  });
});

describe('PowerPoint links', () => {
  const parts = unzipSync(buildPptx([{ width: 595, height: 842, picture: null, texts: [slideText()], hiddenText: false }]));

  it('makes linked words clickable, each slide with its own relationships', () => {
    for (const [name, data] of Object.entries(parts)) {
      if (/\.(xml|rels)$/.test(name)) expect(validate(strFromU8(data), PRESENTATION), name).toEqual([]);
    }
    const slide = strFromU8(parts['ppt/slides/slide1.xml']!);
    expect(slide).toMatch(/<a:hlinkClick r:id="rId\w+"\/>/);
    expect(slide).toContain('>موقعنا<');
    expect(strFromU8(parts['ppt/slides/_rels/slide1.xml.rels']!)).toContain('Target="https://zood.sa/" TargetMode="External"');
  });
});

describe('Excel links', () => {
  const item: TableItem = { kind: 'table', ruled: true, direction: 'ltr', widths: [80, 80], rows: [[cell('Site'), cell('Visit zood.sa today')]] };
  const sheets = tableSheets([[item]], (k) => `Table ${k}`);
  linkSheets(sheets, [{ text: 'zood.sa', uri: 'https://zood.sa/' }]);
  const parts = unzipSync(buildXlsx(sheets));

  it('links the cell that holds a link, in its own blue', () => {
    for (const [name, data] of Object.entries(parts)) {
      if (/\.(xml|rels)$/.test(name)) expect(validate(strFromU8(data), SPREADSHEET), name).toEqual([]);
    }
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']!);
    expect(sheet).toMatch(/<hyperlink ref="B1" r:id="rId\w+"\/>/);
    expect(strFromU8(parts['xl/worksheets/_rels/sheet1.xml.rels']!)).toContain('Target="https://zood.sa/" TargetMode="External"');
    expect(strFromU8(parts['xl/styles.xml']!)).toContain('<u/>');
  });
});

describe('tables from the core', () => {
  it('drops the columns and rows nothing starts in, the table keeping its size', () => {
    const compact = compactTable({
      kind: 'table',
      ruled: true,
      direction: 'ltr',
      widths: [5, 100, 100],
      heights: [20, 3, 20],
      rows: [
        [null, cell('a'), cell('b')],
        [null, null, null],
        [null, cell('c', 1, 2), null],
      ],
    });
    expect(compact.widths).toEqual([105, 100]);
    expect(compact.heights).toEqual([23, 20]);
    expect(compact.rows).toEqual([[cell('a'), cell('b')], [cell('c', 1, 2), null]]);
  });

  it('keeps one-column boxes as paragraphs, and gives tables the links of their lines', () => {
    const lines = [line('اذهب إلى الرابط', 205, { x: 110, width: 60, links: [{ from: 9, to: 15, uri: 'https://zood.sa/' }] })];
    const items = [
      { kind: 'table' as const, ruled: true, direction: 'rtl' as const, left: 100, top: 200, widths: [100, 100], heights: [20], rows: [[cell('أ'), cell('اذهب إلى الرابط')]] },
      { kind: 'table' as const, ruled: true, direction: 'rtl' as const, left: 100, top: 400, widths: [300], heights: [40], rows: [[cell('نص في إطار')]] },
    ];
    const tables = pageTables(items, lines);
    expect(tables).toHaveLength(1);
    // Read right to left, the right cell first.
    expect(tables[0]!.rows[0]!.map((c) => c?.text)).toEqual(['اذهب إلى الرابط', 'أ']);
    expect(tables[0]!.rows[0]![0]!.links).toEqual([{ from: 9, to: 15, uri: 'https://zood.sa/' }]);
    expect(outsideTables([...lines, line('بعد', 500)], tables).map((l) => l.text)).toEqual(['بعد']);
  });

  it('keeps a line inside a table that none of its cells holds, so nothing is lost', () => {
    const table: ExportTable = { direction: 'ltr', ruled: true, left: 0, top: 0, widths: [100, 100], heights: [20, 20], rows: [[{ text: 'Seller', rows: 1, columns: 1 }, { text: 'Buyer', rows: 1, columns: 1 }], [{ text: 'Riyadh', rows: 1, columns: 1 }, null]] };
    const inBox = (text: string, y: number) => line(text, y, { x: 10, width: 40, height: 10 });
    const kept = outsideTables([inBox('Seller Buyer', 5), inBox('Riyadh', 25), inBox('King Fahd Road 1234', 30)], [table]);
    expect(kept.map((l) => l.text)).toEqual(['King Fahd Road 1234']);
  });

  it("knows each cell's box, merges and right to left included, and how its text sits", () => {
    const boxes = cellBoxes({ ...TIMETABLE, rows: [[cell('x', 1, 2), null], ...TIMETABLE.rows.slice(1)] });
    expect(boxes[0]![0]).toEqual({ x: 100, y: 200, width: 200, height: 20 });
    // The first cell of a right-to-left row is the rightmost.
    expect(boxes[1]![0]).toEqual({ x: 220, y: 220, width: 80, height: 20 });
    const box = { x: 0, y: 0, width: 100, height: 20 };
    expect(cellPlace(box, [{ x: 70, y: 4, width: 26, height: 12, direction: 'rtl' }]).align).toBe('start');
    expect(cellPlace(box, [{ x: 30, y: 4, width: 40, height: 12, direction: 'rtl' }]).align).toBe('center');
    expect(cellPlace(box, [{ x: 4, y: 4, width: 26, height: 12, direction: 'ltr' }])).toEqual({ align: 'start', valign: 'center', inset: 4 });
  });
});

describe('what the text holds', () => {
  it('keeps links in place when a line is trimmed, and cuts text where they start and end', () => {
    const own = trimLine({ text: '  see zood.sa ', links: [{ from: 6, to: 13, uri: 'https://zood.sa/' }] });
    expect(own).toEqual({ text: 'see zood.sa', links: [{ from: 4, to: 11, uri: 'https://zood.sa/' }] });
    expect(linkedPieces(own.text, own.links)).toEqual([{ text: 'see ' }, { text: 'zood.sa', uri: 'https://zood.sa/' }]);
  });

  it('turns symbol-font bullets into bullets', () => {
    expect(cleanText(' أولاً\n ثانياً')).toBe('• أولاً\n▪ ثانياً');
  });

  it('names fonts as installed, not as a file name spells them apart', () => {
    expect(wordFamily('Deja Vu Sans')).toBe('DejaVu Sans');
    expect(wordFamily('Open Symbol')).toBe('OpenSymbol');
    expect(wordFamily('Noto Naskh Arabic')).toBe('Noto Naskh Arabic');
  });
});
