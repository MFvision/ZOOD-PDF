import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PRESENTATION, SPREADSHEET, validate } from './ooxml.testing';
import { buildPptx } from './pptx';
import type { Slide } from './pptx';
import { pageSheet, parseNumber, tableSheets } from './tables';
import type { PageItem, TableItem } from './tables';
import { buildXlsx, columnName, formatCode, sheetNames, xlsxParts } from './xlsx';

const table = (rows: TableItem['rows'], direction: 'rtl' | 'ltr' = 'rtl', widths = rows[0]!.map(() => 80)): TableItem => ({
  kind: 'table',
  ruled: true,
  direction,
  widths,
  rows,
});
const cell = (text: string, rows = 1, columns = 1) => ({ text, rows, columns });

describe('numbers as numbers', () => {
  it('reads Western, Arabic-Indic and Persian digits and Arabic separators', () => {
    expect(parseNumber('1,200.00')).toEqual({ value: 1200, format: { decimals: 2, grouped: true, percent: false } });
    expect(parseNumber('١٢')?.value).toBe(12);
    expect(parseNumber('۱۲۳')?.value).toBe(123);
    expect(parseNumber('٣٫٥')?.value).toBe(3.5);
    expect(parseNumber('١٬٢٠٠٫٥٠')).toEqual({ value: 1200.5, format: { decimals: 2, grouped: true, percent: false } });
  });

  it('reads signs, losses in parentheses and percentages written either side', () => {
    expect(parseNumber('-42')?.value).toBe(-42);
    expect(parseNumber('− 42')?.value).toBe(-42);
    expect(parseNumber('(1,234.50)')?.value).toBe(-1234.5);
    expect(parseNumber('15%')).toEqual({ value: 0.15, format: { decimals: 0, grouped: false, percent: true } });
    // Right-to-left text is often read with its percent sign first.
    expect(parseNumber('%15')?.value).toBe(0.15);
    expect(parseNumber('٪١٢٫٥')?.value).toBeCloseTo(0.125);
    expect(parseNumber('\u200F1,250\u200F')?.value).toBe(1250);
  });

  it('reads amounts of money, and shows them with their sign where it was', () => {
    expect(parseNumber('$12,000')).toEqual({ value: 12000, format: { decimals: 0, grouped: true, percent: false, currency: { symbol: '$', before: true } } });
    expect(parseNumber('3.50 ر.س')).toEqual({ value: 3.5, format: { decimals: 2, grouped: false, percent: false, currency: { symbol: 'ر.س', before: false } } });
    expect(parseNumber('-$5')?.value).toBe(-5);
    expect(parseNumber('($1,234.50)')?.value).toBe(-1234.5);
    expect(formatCode(parseNumber('$48,500.75')!.format)).toBe('"$"#,##0.00');
    expect(formatCode(parseNumber('١٬٢٥٠ ر.س')!.format)).toBe('#,##0 "ر.س"');
  });

  it('keeps the decimal a percentage was written with', () => {
    expect(parseNumber('4.1%')?.value).toBe(0.041);
    expect(parseNumber('-6.1%')?.value).toBe(-0.061);
  });

  it('keeps codes, dates, phone numbers and words as text', () => {
    for (const text of ['007', 'INV-2026-0042', '12/09/2026', '+966 50 123 4567', '1,20', '١٢ كتابًا', '', '1234567890123456', '$', 'ر.س']) {
      expect(parseNumber(text), text).toBeNull();
    }
  });
});

describe('sheets from what the core found', () => {
  it('puts a right-to-left table in a right-to-left sheet, its first column as A, merges mirrored', () => {
    // As drawn, left to right: السعر | الكمية | الصنف, then a total over the two right-hand columns.
    const items: PageItem[] = [
      { kind: 'line', text: 'فاتورة', direction: 'rtl', cells: [] },
      table([
        [cell('السعر'), cell('الكمية'), cell('الصنف')],
        [cell('3.50'), cell('١٢'), cell('ورق')],
        [cell('42.00'), cell('المجموع', 1, 2), null],
      ]),
    ];
    const sheet = pageSheet(items, 'Page 1');
    expect(sheet.rtl).toBe(true);
    const texts = sheet.rows.map((row) => row.map((c) => (c ? c.value.text : null)));
    expect(texts).toEqual([['فاتورة'], [], ['الصنف', 'الكمية', 'السعر'], ['ورق', '١٢', '3.50'], ['المجموع', null, '42.00']]);
    expect(sheet.rows[4]![0]!.columns).toBe(2);
    expect(sheet.rows[3]![1]!.value).toMatchObject({ kind: 'number', value: 12 });
  });

  it('cuts a line with wide gaps into columns, from the right on a right-to-left page', () => {
    const items: PageItem[] = [
      {
        kind: 'line',
        text: 'التاريخ ١٦ سبتمبر',
        direction: 'rtl',
        cells: [
          { text: '١٦ سبتمبر', x0: 100, x1: 160, direction: 'rtl' },
          { text: 'التاريخ', x0: 400, x1: 450, direction: 'rtl' },
        ],
      },
    ];
    expect(pageSheet(items, 'p').rows[0]!.map((c) => c?.value.text)).toEqual(['التاريخ', '١٦ سبتمبر']);
  });

  it('gives each table a sheet of its own when asked, and none when there are none', () => {
    const pages: PageItem[][] = [[table([[cell('a'), cell('b')]], 'ltr')], [], [table([[cell('c'), cell('d')]], 'ltr')]];
    const sheets = tableSheets(pages, (k) => `Table ${k}`);
    expect(sheets.map((s) => s.name)).toEqual(['Table 1', 'Table 2']);
    expect(sheets[1]!.rows[0]!.map((c) => c?.value.text)).toEqual(['c', 'd']);
    expect(tableSheets([[{ kind: 'line', text: 'x', direction: 'ltr', cells: [] }]], String)).toEqual([]);
  });
});

describe('the Excel workbook', () => {
  const sheets = [
    pageSheet(
      [
        table([
          [cell('النسبة'), cell('المبلغ'), cell('البند')],
          [cell('62.5%'), cell('1,200.50'), cell('الرواتب')],
          [cell('%37.5'), cell('٧٥٠'), cell('الإيجار')],
        ]),
      ],
      'الصفحة 1',
    ),
    pageSheet([{ kind: 'line', text: 'Plain page & <text>', direction: 'ltr', cells: [] }], 'الصفحة 1'),
  ];

  it('writes every part in the order SpreadsheetML sets', () => {
    const parts = xlsxParts(sheets);
    expect(Object.keys(parts).sort()).toEqual(
      ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].sort(),
    );
    for (const [path, xml] of Object.entries(parts)) expect(validate(xml, SPREADSHEET), path).toEqual([]);
  });

  it('keeps numbers as numbers in their own format, text as text, and the sheet right to left', () => {
    const files = unzipSync(buildXlsx(sheets));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toMatch(/<c r="A1" t="inlineStr"><is><t xml:space="preserve">البند<\/t>/);
    expect(sheet).toMatch(/<c r="B2" s="\d+"><v>1200.5<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="B3"><v>750<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="C2" s="\d+"><v>0.625<\/v><\/c>/);
    const styles = strFromU8(files['xl/styles.xml']!);
    // #,##0.00 is built in (4); 0.0% is the workbook's own.
    expect(styles).toContain('numFmtId="4"');
    expect(styles).toContain('formatCode="0.0%"');
    // Two sheets asked to have one name have two names.
    const workbook = strFromU8(files['xl/workbook.xml']!);
    expect(workbook).toContain('name="الصفحة 1"');
    expect(workbook).toContain('name="الصفحة 1 (2)"');
    expect(strFromU8(files['xl/worksheets/sheet2.xml']!)).toContain('Plain page &amp; &lt;text&gt;');
  });

  it('merges what the table merged', () => {
    const merged = pageSheet([table([[cell('المجموع', 1, 2), null], [cell('a'), cell('b')]])], 's');
    const sheet = strFromU8(unzipSync(buildXlsx([merged]))['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>');
  });

  it('names columns and sheets as Excel does', () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
    expect(sheetNames(['a/b:c', '', "'quoted'", 'x'.repeat(40)])).toEqual(['a b c', 'Sheet2', 'quoted', 'x'.repeat(31)]);
    expect(formatCode({ decimals: 2, grouped: true, percent: false })).toBe('#,##0.00');
    expect(formatCode({ decimals: 0, grouped: false, percent: true })).toBe('0%');
  });
});

describe('the PowerPoint presentation', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const slides: Slide[] = [
    {
      width: 595,
      height: 842,
      picture: png,
      hiddenText: false,
      texts: [
        { x: 56, y: 60, width: 480, height: 40, lines: ['التقرير السنوي'], direction: 'rtl', alignment: 'start', size: 24, pitch: null, color: '1f3864' },
        { x: 56, y: 120, width: 480, height: 60, lines: ['First line & more', 'second <line>'], direction: 'ltr', alignment: 'center', size: 11, pitch: 14, color: '000000' },
      ],
    },
    { width: 595, height: 842, picture: null, hiddenText: true, texts: [{ x: 1, y: 1, width: 10, height: 10, lines: ['نص'], direction: 'rtl', alignment: 'end', size: 10, pitch: null, color: 'zzzzzz' }] },
  ];
  const files = unzipSync(buildPptx(slides));

  it('writes every part in the order PresentationML sets', () => {
    const xml = Object.entries(files).filter(([path]) => /\.(xml|rels)$/.test(path));
    expect(xml.length).toBeGreaterThan(10);
    for (const [path, bytes] of xml) expect(validate(strFromU8(bytes), PRESENTATION), path).toEqual([]);
    expect(files['ppt/media/page1.png']).toEqual(png);
    expect(files['ppt/media/page2.png']).toBeUndefined();
  });

  it('puts Arabic text right to left, where it was, and hidden text stays hidden', () => {
    const first = strFromU8(files['ppt/slides/slide1.xml']!);
    expect(first).toMatch(/<a:pPr algn="r" rtl="1">/);
    expect(first).toContain('<a:t>التقرير السنوي</a:t>');
    expect(first).toContain('lang="ar-SA"');
    // 56 points from the left: 711200 EMU.
    expect(first).toContain('<a:off x="711200"');
    expect(first).toContain('First line &amp; more');
    const second = strFromU8(files['ppt/slides/slide2.xml']!);
    expect(second).toContain('<a:alpha val="0"/>');
    expect(second).toMatch(/<a:pPr algn="l" rtl="1">/);
    // Text up the margin stands where it stood, turned, not as a giant box.
    const turned = strFromU8(unzipSync(buildPptx([{ ...slides[1]!, texts: [{ x: 6, y: 18, width: 20, height: 650, lines: ['Public Disclosure Authorized'], direction: 'ltr', alignment: 'start', size: 16, pitch: null, color: '000000', vertical: true }] }]))['ppt/slides/slide1.xml']!);
    expect(turned).toContain('<a:xfrm rot="16200000"><a:off x="-3924300" y="4229100"/><a:ext cx="8255000" cy="254000"/>');
    const presentation = strFromU8(files['ppt/presentation.xml']!);
    expect(presentation).toContain('<p:sldSz cx="7556500" cy="10693400"/>');
  });
});
