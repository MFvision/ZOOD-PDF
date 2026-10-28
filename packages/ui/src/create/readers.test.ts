import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGE_COUNT, PAGE_NUMBER, blockText } from './blocks';
import type { Block, FrameBlock, TableBlock, TextBlock } from './blocks';
import { parseCsv, readCsv } from './csv';
import { readDocx } from './docx';
import { parseHtml, readHtml } from './html';
import { inlineRuns, readMarkdown } from './markdown';
import { readPptx } from './pptx';
import { decodeText, readText } from './text';
import { cellRef, excelDate, readXlsx, shapeOf, showNumber } from './xlsx';

/** A file of `tests/fixtures/create` (made by its `make_fixtures.py`). */
const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../../tests/fixtures/create/${name}`, import.meta.url))));

const texts = (blocks: readonly Block[]) => blocks.filter((b): b is TextBlock => b.type === 'text');
const find = (blocks: readonly Block[], text: string) => texts(blocks).find((b) => blockText(b).includes(text));
const tables = (blocks: readonly Block[]) => blocks.filter((b): b is TableBlock => b.type === 'table');

describe('a Word document', () => {
  const doc = readDocx(fixture('report-ar.docx'));

  it('keeps its title, headings and their weight, and its right-to-left paragraphs', () => {
    expect(doc.title).toBe('التقرير السنوي');
    const title = find(doc.blocks, 'التقرير السنوي لمكتبة ورّاق')!;
    expect(title).toMatchObject({ size: 20, align: 'center', dir: 'rtl' });
    expect(title.runs?.[0]?.bold ?? title.bold).toBe(true);
    const heading = find(doc.blocks, 'مقدمة')!;
    expect(heading).toMatchObject({ size: 16, keepWithNext: true });
    expect(heading.runs?.every((r) => r.bold && r.color === '#2f5496')).toBe(true);
    expect(find(doc.blocks, 'English paragraph')!.dir).toBeUndefined();
  });

  it('keeps bold, italic, underline, colour and links inside a paragraph', () => {
    const p = find(doc.blocks, 'هذا تقرير')!;
    expect(blockText(p)).toBe('هذا تقرير عريض ومائل وتحته خط وملوّن مع رابط إلى الموقع.');
    expect(p.align).toBe('justify');
    const run = (text: string) => p.runs!.find((r) => r.text === text);
    expect(run('عريض')?.bold).toBe(true);
    expect(run('مائل')?.italic).toBe(true);
    expect(run('تحته خط')?.underline).toBe(true);
    expect(run('ملوّن')?.color).toBe('#c00000');
    expect(run('رابط إلى الموقع')?.link).toBe('https://example.sa/warraq');
    expect(find(doc.blocks, 'فقرة مظللة')!.shade).toBe('#fff2cc');
  });

  it('numbers its lists as Word does', () => {
    expect(find(doc.blocks, 'البند الأول')!.marker).toBe('1.');
    expect(find(doc.blocks, 'البند الثاني')!.marker).toBe('2.');
    expect(find(doc.blocks, 'نقطة أولى')!.marker).toBe('•');
  });

  it('keeps its table: header row, shading, the merged total, right to left', () => {
    const [table] = tables(doc.blocks);
    expect(table).toMatchObject({ headerRows: 1, dir: 'rtl', widths: [3000, 2000, 2000] });
    expect(table!.rows[0]![0]).toMatchObject({ text: 'الصنف', fill: '#d9e2f3', bold: true });
    expect(table!.rows[1]!.map((c) => c.text)).toEqual(['ورق', '١٢', '3.50']);
    expect(table!.rows[2]![0]).toMatchObject({ text: 'المجموع', span: 2 });
  });

  it('carries its picture at its size, its landscape section, and its numbered footer', () => {
    const image = doc.blocks.find((b) => b.type === 'image');
    expect(image).toMatchObject({ index: 0, width: 144, height: 72 });
    expect(doc.pictures[0]!.mime).toBe('image/png');
    const page = doc.blocks.find((b) => b.type === 'page');
    expect(page).toMatchObject({ width: 16838 / 20, height: 11906 / 20 });
    expect(doc.page).toMatchObject({ width: 11906 / 20, height: 16838 / 20 });
    expect(doc.page!.header).toBeCloseTo(567 / 20);
    expect(blockText(texts(doc.header!)[0]!)).toBe('مكتبة ورّاق — تقرير داخلي');
    expect(blockText(texts(doc.footer!)[0]!)).toBe(`صفحة ${PAGE_NUMBER} من ${PAGE_COUNT}`);
  });
});

describe('an Excel workbook', () => {
  const book = readXlsx(fixture('budget-ar.xlsx'));

  it('makes each visible sheet a heading and a table, right to left as the sheet is', () => {
    expect(texts(book.blocks).map(blockText)).toEqual(['الميزانية', 'Summary']);
    const [budget, summary] = tables(book.blocks);
    expect(budget!.dir).toBe('rtl');
    expect(budget!.rows[0]![0]).toMatchObject({ text: 'الميزانية السنوية', span: 4, bold: true });
    expect(budget!.rows[2]!.map((c) => c.text)).toEqual(['الرواتب', '125,000.50', '62.5%', '2026-09-19']);
    // A formula shows the value saved with it.
    expect(budget!.rows[4]!.map((c) => c.text)).toEqual(['المجموع', '200,000.50', '100.0%', '']);
    expect(budget!.rows[2]![1]!.align).toBe('end');
    expect(summary!.rows.map((r) => r.map((c) => c.text))).toEqual([['Quarter', 'Sales'], ['Q1', '1500'], ['Q2', 'TRUE']]);
    expect(JSON.stringify(book.blocks)).not.toContain('SECRET-HIDDEN');
  });

  it('shows numbers as their formats say', () => {
    expect(showNumber(1234.5, shapeOf('#,##0.00'))).toBe('1,234.50');
    expect(showNumber(0.25, shapeOf('0%'))).toBe('25%');
    expect(showNumber(46284, shapeOf('yyyy-mm-dd'))).toBe('2026-09-19');
    expect(showNumber(0.5, shapeOf('h:mm'))).toBe('12:00');
    expect(showNumber(1 / 3, shapeOf('General'))).toBe('0.33333333333');
    // The currency or unit the format writes around the number, as Excel shows it.
    expect(showNumber(5, shapeOf('"SAR" #,##0'))).toBe('SAR 5');
    expect(showNumber(12500, shapeOf('#,##0.00 "SR"'))).toBe('12,500.00 SR');
    expect(showNumber(52.17, shapeOf('[$€-x-euro2] #,##0.00'))).toBe('€ 52.17');
    expect(excelDate(0, true)).toBe('1904-01-01');
    expect(cellRef('AB12')).toEqual([11, 27]);
    expect(cellRef('nonsense')).toBeNull();
  });
});

describe('a PowerPoint presentation', () => {
  const deck = readPptx(fixture('slides-ar.pptx'));
  const pages = deck.blocks.filter((b) => b.type === 'page');
  const frames = deck.blocks.filter((b): b is FrameBlock => b.type === 'frame');
  const frameWith = (text: string) => frames.find((f) => f.blocks.some((b) => b.type === 'text' && blockText(b).includes(text)));

  it('makes each slide a page of its size and background', () => {
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ width: 720, height: 405, background: '#f4f7fb' });
    // The master's background: bg1, the theme's light colour.
    expect(pages[1]).toMatchObject({ background: '#ffffff' });
  });

  it('places a title where its layout does, in the master’s style and theme colour', () => {
    const title = frameWith('عرض مكتبة ورّاق')!;
    expect(title).toMatchObject({ x: 36, y: 24, width: 648, height: 64, anchor: 'middle' });
    const text = title.blocks[0] as TextBlock;
    expect(text).toMatchObject({ size: 36, align: 'center', dir: 'rtl' });
    expect(text.runs![0]).toMatchObject({ bold: true, color: '#1f3864' });
    const subtitle = frameWith('تقرير الربع الثالث')!.blocks[0] as TextBlock;
    expect(subtitle.runs![0]).toMatchObject({ italic: true, color: '#4472c4' });
  });

  it('keeps bullets by level, shapes’ fills, the picture and the table', () => {
    const body = frameWith('ارتفعت المبيعات')!;
    const [first, second, third] = body.blocks as TextBlock[];
    expect(first).toMatchObject({ marker: '•', align: 'start', dir: 'rtl', size: 24 });
    expect(second!.runs![0]!.bold).toBe(true);
    expect(third).toMatchObject({ marker: '–', size: 20 });
    expect(frameWith('ملاحظة مهمة')).toMatchObject({ fill: '#ed7d31', anchor: 'middle' });
    const picture = frames.find((f) => f.blocks[0]?.type === 'image');
    expect(picture).toMatchObject({ x: 36, y: 110, width: 160, height: 80 });
    expect(deck.pictures).toHaveLength(1);
    const table = frames.find((f) => f.blocks[0]?.type === 'table')!.blocks[0] as TableBlock;
    expect(table).toMatchObject({ headerRows: 1, dir: 'rtl', size: 14 });
    expect(table.rows.map((r) => r.map((c) => c.text))).toEqual([['المدينة', 'القراء'], ['الرياض', '1,250']]);
    expect(table.rows[0]![0]!.fill).toBe('#d9e2f3');
  });
});

describe('a web page', () => {
  const page = readHtml(fixture('page-ar.html'));

  it('reads its text, never its scripts, and takes only the pictures it carries', () => {
    expect(page.title).toBe('صفحة ورّاق');
    const all = JSON.stringify(page.blocks);
    expect(all).not.toContain('this never runs');
    expect(all).not.toContain('font-family');
    expect(all).not.toContain('نص مخفي');
    expect(page.pictures).toHaveLength(1);
    expect(page.picturesLeftOut).toBe(1);
  });

  it('keeps headings, runs, lists, tables and preformatted text', () => {
    expect(find(page.blocks, 'دليل ورّاق')).toMatchObject({ size: 24, bold: true, dir: 'rtl' });
    const p = find(page.blocks, 'عربي أولًا')!;
    expect(p.runs!.find((r) => r.text === 'عربي أولًا')?.bold).toBe(true);
    expect(p.runs!.find((r) => r.text === 'موقعه هنا')?.link).toBe('https://example.sa/ar');
    expect(find(page.blocks, 'تحرير النص العربي')!.marker).toBe('•');
    expect(find(page.blocks, 'مع الجداول')!.marker).toBe('◦');
    expect(find(page.blocks, 'تصدير إلى Excel')!.marker).toBe('•');
    expect(find(page.blocks, 'اختر الأداة')!.marker).toBe('2.');
    const [table] = tables(page.blocks);
    expect(table).toMatchObject({ headerRows: 1 });
    expect(table!.rows[2]![0]).toMatchObject({ text: 'كل الأدوات تعمل محليًا', span: 2 });
    expect(find(page.blocks, 'warraq --version')).toMatchObject({ preserve: true, text: 'warraq --version\n0.1.0', dir: 'ltr' });
    expect(find(page.blocks, 'An English paragraph')!.dir).toBe('ltr');
  });

  it('reads a page in Windows-1256 by its meta charset', () => {
    expect(blockText(texts(readHtml(fixture('legacy-1256.html')).blocks)[0]!)).toBe('مرحبا بكم في ورّاق');
  });

  it('never throws on broken markup, and bounds how deep it goes', () => {
    for (const source of ['<', '<<>>', '<p <b>', '</x></y>', '<table><td>a<tr>b', '<!-- unclosed', '<script>', '<a href="x']) {
      expect(() => parseHtml(source)).not.toThrow();
    }
    const deep = '<div>'.repeat(50_000) + 'x';
    expect(() => readHtml(new TextEncoder().encode(deep))).not.toThrow();
  });
});

describe('Markdown, text and CSV', () => {
  it('reads Markdown’s blocks and emphasis', () => {
    const md = readMarkdown(fixture('notes-ar.md'));
    expect(md.title).toBe('ملاحظات ورّاق');
    const p = find(md.blocks, 'كلمة عريضة')!;
    const run = (text: string) => p.runs!.find((r) => r.text === text);
    expect(run('كلمة عريضة')?.bold).toBe(true);
    expect(run('مائلة')?.italic).toBe(true);
    expect(run('محذوفة')?.strike).toBe(true);
    expect(run('رابط')?.link).toBe('https://example.sa');
    expect(find(md.blocks, 'البند الأول')!.marker).toBe('•');
    expect(find(md.blocks, 'بند فرعي')!.marker).toBe('◦');
    expect(find(md.blocks, 'خطوة ثانية')!.marker).toBe('2.');
    const [table] = tables(md.blocks);
    expect(table!.rows.map((r) => r.map((c) => c.text))).toEqual([['المدينة', 'القراء'], ['الرياض', '1,250'], ['جدة', '٩٨٠']]);
    // `--:` is the right of the page: in this Arabic table, the start of a line.
    expect(table!.rows[1]![1]!.align).toBe('start');
    expect(table!.rows[1]![0]!.align).toBe('end');
    expect(find(md.blocks, 'code block')).toMatchObject({ preserve: true });
    expect(find(md.blocks, 'اقتباس')!.indent).toBeGreaterThan(0);
    expect(md.blocks.some((b) => b.type === 'rule')).toBe(true);
    expect(inlineRuns('snake_case_name').map((r) => r.text).join('')).toBe('snake_case_name');
  });

  it('reads text in paragraphs, and older Arabic files in Windows-1256', () => {
    const text = readText(fixture('notes-ar.txt'));
    expect(texts(text.blocks).map((b) => b.text)).toEqual(['رسالة من ورّاق', 'هذا نص عادي بالعربية.\nوسطر ثانٍ في الفقرة نفسها.', 'This is a plain English paragraph.']);
    // An Arabic line under an English one, no blank line between: its own block, so it starts on the right.
    const mixed = readText(new TextEncoder().encode('\uFEFFPlain text test line 1\r\nسطر عربي للاختبار\r\n'));
    expect(texts(mixed.blocks).map((b) => [b.text, b.spaceAfter])).toEqual([['Plain text test line 1', 0], ['سطر عربي للاختبار', 8]]);
    const legacy = new Uint8Array([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]);
    expect(decodeText(legacy)).toBe('مرحبا');
  });

  it('reads CSV with quoted separators and Arabic digits', () => {
    expect(parseCsv('a;"b;c";d\n1;2;3')).toEqual([['a', 'b;c', 'd'], ['1', '2', '3']]);
    const [table] = tables(readCsv(fixture('cities-ar.csv')).blocks);
    expect(table!.rows[2]![0]!.text).toBe('جدة، الساحل');
    expect(table!.rows[3]![1]).toMatchObject({ text: '٥٦٠', align: 'end' });
  });
});
