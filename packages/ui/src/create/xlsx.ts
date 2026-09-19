import type { Block, ReadDocument, SourcePage, TableCell } from './blocks';
import { attr, childElements, firstChild, parseXml, textOf } from './xml';
import type { XmlElement } from './xml';
import { partText, readParts, relsPath, resolvePart } from './zip';

/**
 * An Excel workbook (.xlsx) read into blocks: each visible sheet a heading
 * and a table, on pages of their own, turned landscape when the sheet is
 * wide. Cells show what Excel shows for them as far as their number format
 * says — grouping, decimals, percentages, dates — using the value saved
 * with a formula. Merged cells across a row stay merged; a right-to-left
 * sheet is a right-to-left table.
 *
 * Not read: charts, pictures, conditional formats, fonts and colours of
 * cells, and anything past the first 2,000 rows or 60 columns of a sheet
 * (the document says it was cut).
 */

const MAX_ROWS = 2_000;
const MAX_COLUMNS = 60;
/** Excel's column width is in characters of about this many points. */
const CHARACTER = 5.6;
const A4: [number, number] = [595.28, 841.89];
const MARGIN = 36;

/** `A1`-style column letters as a zero-based index. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const c of letters.toUpperCase()) {
    const v = c.charCodeAt(0) - 64;
    if (v < 1 || v > 26) return -1;
    n = n * 26 + v;
  }
  return n - 1;
}

/** `B3` as [row, column], zero-based. */
export function cellRef(ref: string): [number, number] | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!m) return null;
  const column = columnIndex(m[1]!);
  const row = Number(m[2]) - 1;
  return column >= 0 && row >= 0 ? [row, column] : null;
}

/** How a number format shows a value. */
interface NumberShape {
  kind: 'general' | 'number' | 'percent' | 'date' | 'text';
  decimals: number;
  grouped: boolean;
  /** Dates: with a time of day, or only one. */
  time?: 'with' | 'only';
}

const BUILT_IN: Record<number, string> = {
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  14: 'yyyy-mm-dd',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'yyyy-mm-dd h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  49: '@',
};

/** What a format code says about how numbers look, from its first section. */
export function shapeOf(code: string | undefined): NumberShape {
  if (!code || code === 'General') return { kind: 'general', decimals: 0, grouped: false };
  if (code === '@') return { kind: 'text', decimals: 0, grouped: false };
  const first = code.split(';')[0]!;
  // Quoted text, escapes and [colour] or [$-locale] brackets say nothing about the number.
  const bare = first
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '');
  if (/[ymdhs]/i.test(bare) && !/[0#?]/.test(bare.replace(/[ymdhs:./\- ]/gi, ''))) {
    const hasDate = /[yd]/i.test(bare) || /m{3,}/i.test(bare);
    const hasTime = /[hs]/i.test(bare);
    return { kind: 'date', decimals: 0, grouped: false, time: hasTime ? (hasDate ? 'with' : 'only') : undefined };
  }
  const decimals = (/\.([0#?]+)/.exec(bare)?.[1] ?? '').length;
  const grouped = /[0#?],[0#?]/.test(bare);
  return { kind: bare.includes('%') ? 'percent' : 'number', decimals, grouped };
}

/** A serial day number (Excel's, 1900 or 1904 based) as an ISO date and time. */
export function excelDate(serial: number, from1904: boolean, time?: 'with' | 'only'): string {
  // 1900's day 60 is Excel's own 29 February 1900, which never was.
  const days = from1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
  const ms = Math.round((days - 25569) * 86_400_000);
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return String(serial);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const clock = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds())}` : ''}`;
  if (time === 'only') return clock;
  return time === 'with' ? `${date} ${clock}` : date;
}

/** A number as its format shows it. */
export function showNumber(value: number, shape: NumberShape, from1904 = false): string {
  if (!Number.isFinite(value)) return String(value);
  switch (shape.kind) {
    case 'date':
      return excelDate(value, from1904, shape.time);
    case 'percent':
      return `${showNumber(value * 100, { ...shape, kind: 'number' })}%`;
    case 'number':
      return value.toLocaleString('en-US', {
        minimumFractionDigits: shape.decimals,
        maximumFractionDigits: shape.decimals,
        useGrouping: shape.grouped,
      });
    default: {
      // General: at most eleven significant digits, as Excel shows in a cell.
      if (Number.isInteger(value) && Math.abs(value) < 1e11) return String(value);
      const text = Number(value.toPrecision(11)).toString();
      return text.includes('e') ? value.toExponential(5).toUpperCase() : text;
    }
  }
}

interface Styles {
  /** Per cell style index: its number format's shape, and its horizontal alignment. */
  cells: { shape: NumberShape; align?: string; bold: boolean }[];
}

function readStyles(xml: string | null): Styles {
  const root = xml ? parseXml(xml) : null;
  const codes = new Map<number, string>();
  for (const f of childElements(firstChild(root, 'numFmts'), 'numFmt')) {
    const id = Number(attr(f, 'numFmtId'));
    const code = attr(f, 'formatCode');
    if (Number.isFinite(id) && code !== undefined) codes.set(id, code);
  }
  const fonts = childElements(firstChild(root, 'fonts'), 'font').map((font) => {
    const b = firstChild(font, 'b');
    return b !== null && attr(b, 'val') !== '0' && attr(b, 'val') !== 'false';
  });
  const cells = childElements(firstChild(root, 'cellXfs'), 'xf').map((xf) => {
    const id = Number(attr(xf, 'numFmtId') ?? 0);
    const code = codes.get(id) ?? BUILT_IN[id];
    return {
      shape: shapeOf(code),
      align: attr(firstChild(xf, 'alignment'), 'horizontal'),
      bold: fonts[Number(attr(xf, 'fontId') ?? 0)] ?? false,
    };
  });
  return { cells };
}

/** The text of a shared or inline string: its runs, one after another. */
function stringOf(si: XmlElement): string {
  const t = firstChild(si, 't');
  if (t) return textOf(t);
  return childElements(si, 'r')
    .map((r) => textOf(firstChild(r, 't')))
    .join('');
}

interface SheetCell {
  text: string;
  numeric: boolean;
  bold: boolean;
  align?: string;
}

/** One sheet as blocks: its name, then its used cells as a table. */
function sheetBlocks(
  name: string,
  xml: string,
  strings: string[],
  styles: Styles,
  from1904: boolean,
): { blocks: Block[]; rtl: boolean; width: number; truncated: boolean } | null {
  const root = parseXml(xml);
  if (!root) return null;
  const view = firstChild(firstChild(root, 'sheetViews'), 'sheetView');
  const rtl = ['1', 'true'].includes(attr(view, 'rightToLeft') ?? '');
  let truncated = false;
  const cells = new Map<number, SheetCell>();
  let lastRow = -1;
  let lastColumn = -1;
  const hiddenRows = new Set<number>();
  // `r` is optional on rows and cells: without it, each follows the one before.
  let previousRow = -1;
  for (const row of childElements(firstChild(root, 'sheetData'), 'row')) {
    const given = Number(attr(row, 'r'));
    const r = Number.isInteger(given) && given > 0 ? given - 1 : previousRow + 1;
    previousRow = r;
    if (['1', 'true'].includes(attr(row, 'hidden') ?? '')) hiddenRows.add(r);
    let previousColumn = -1;
    for (const c of childElements(row, 'c')) {
      const [ri, ci] = cellRef(attr(c, 'r') ?? '') ?? [r, previousColumn + 1];
      previousColumn = ci;
      if (ri >= MAX_ROWS || ci >= MAX_COLUMNS) {
        truncated = true;
        continue;
      }
      const type = attr(c, 't') ?? 'n';
      const style = styles.cells[Number(attr(c, 's') ?? 0)];
      const v = textOf(firstChild(c, 'v'));
      let text = '';
      let numeric = false;
      if (type === 's') text = strings[Number(v)] ?? '';
      else if (type === 'inlineStr') text = stringOf(firstChild(c, 'is') ?? c);
      else if (type === 'str' || type === 'e' || type === 'd') text = v;
      else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== '') {
        const value = Number(v);
        numeric = style?.shape.kind !== 'date' && style?.shape.kind !== 'text';
        text = Number.isFinite(value) ? showNumber(value, style?.shape ?? shapeOf(undefined), from1904) : v;
      }
      if (text === '') continue;
      cells.set(ri * MAX_COLUMNS + ci, { text, numeric, bold: style?.bold ?? false, align: style?.align });
      lastRow = Math.max(lastRow, ri);
      lastColumn = Math.max(lastColumn, ci);
    }
  }
  if (lastRow < 0) return null;
  const hiddenColumns = new Set<number>();
  const widths: number[] = [];
  for (const col of childElements(firstChild(root, 'cols'), 'col')) {
    const min = Number(attr(col, 'min') ?? 0) - 1;
    const max = Math.min(Number(attr(col, 'max') ?? 0) - 1, MAX_COLUMNS - 1);
    const width = Number(attr(col, 'width') ?? 0);
    const hidden = ['1', 'true'].includes(attr(col, 'hidden') ?? '');
    for (let k = Math.max(0, min); k <= max; k += 1) {
      if (hidden) hiddenColumns.add(k);
      if (Number.isFinite(width) && width > 0) widths[k] = width;
    }
  }
  // Merged ranges: each row of one is a single cell as wide as the range,
  // its text in the first row only.
  const regions = new Map<number, { r0: number; c0: number; c1: number }>();
  for (const mergeCell of childElements(firstChild(root, 'mergeCells'), 'mergeCell')) {
    const [from, to] = (attr(mergeCell, 'ref') ?? '').split(':');
    const a = cellRef(from ?? '');
    const b = cellRef(to ?? from ?? '');
    if (!a || !b) continue;
    const [r0, c0] = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
    const [r1, c1] = [Math.min(Math.max(a[0], b[0]), MAX_ROWS - 1), Math.min(Math.max(a[1], b[1]), MAX_COLUMNS - 1)];
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > 100_000) continue;
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) regions.set(r * MAX_COLUMNS + c, { r0, c0, c1 });
    }
  }
  const columns = Array.from({ length: lastColumn + 1 }, (_, k) => k).filter((k) => !hiddenColumns.has(k));
  const rows: TableCell[][] = [];
  for (let r = 0; r <= lastRow; r += 1) {
    if (hiddenRows.has(r)) continue;
    const row: TableCell[] = [];
    for (let i = 0; i < columns.length; i += 1) {
      const c = columns[i]!;
      const key = r * MAX_COLUMNS + c;
      const region = regions.get(key);
      const cell = cells.get(region ? region.r0 * MAX_COLUMNS + region.c0 : key);
      const out: TableCell = { text: region && region.r0 !== r ? '' : (cell?.text ?? '') };
      if (region) {
        // Hidden columns inside the range take no room.
        const span = columns.filter((k) => k >= c && k <= region.c1).length;
        if (span > 1) out.span = span;
        i += span - 1;
      }
      if (cell?.bold) out.bold = true;
      if (cell?.align === 'center' || cell?.align === 'centerContinuous') out.align = 'center';
      else if (cell?.numeric || cell?.align === 'right') out.align = 'end';
      if (cell && !cell.numeric && /[\u0600-\u06FF]/.test(cell.text)) out.dir = 'rtl';
      row.push(out);
    }
    rows.push(row);
  }
  const relative = columns.map((k) => widths[k] ?? 8.43);
  const natural = relative.reduce((sum, w) => sum + w * CHARACTER, 0);
  return {
    blocks: [
      { type: 'text', text: name, size: 14, bold: true, keepWithNext: true, spaceAfter: 8, dir: rtl ? 'rtl' : 'auto' },
      { type: 'table', rows, widths: relative, dir: rtl ? 'rtl' : 'ltr', size: 9 },
    ],
    rtl,
    width: natural,
    truncated,
  };
}

/** Whether `bytes` is an Excel workbook: a zip with `xl/workbook.xml`. */
export function isXlsx(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  try {
    return 'xl/workbook.xml' in readParts(bytes, (name) => name === 'xl/workbook.xml');
  } catch {
    return false;
  }
}

export function readXlsx(bytes: Uint8Array): ReadDocument {
  const parts = readParts(
    bytes,
    (name) =>
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml' ||
      name === 'xl/styles.xml' ||
      name === 'docProps/core.xml' ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(name),
  );
  const workbook = parseXml(partText(parts, 'xl/workbook.xml') ?? '');
  if (!workbook || workbook.local !== 'workbook') throw new Error('E_CREATE: not an Excel workbook');
  const from1904 = ['1', 'true'].includes(attr(firstChild(workbook, 'workbookPr'), 'date1904') ?? '');
  const rels = new Map<string, string>();
  for (const rel of childElements(parseXml(partText(parts, relsPath('xl/workbook.xml')) ?? ''), 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id && target) rels.set(id, resolvePart('xl/workbook.xml', target));
  }
  const strings = childElements(parseXml(partText(parts, 'xl/sharedStrings.xml') ?? ''), 'si').map(stringOf);
  const styles = readStyles(partText(parts, 'xl/styles.xml'));
  const blocks: Block[] = [];
  let page: SourcePage | undefined;
  let truncated = false;
  for (const sheet of childElements(firstChild(workbook, 'sheets'), 'sheet')) {
    if ((attr(sheet, 'state') ?? 'visible') !== 'visible') continue;
    const id = attr(sheet, 'id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships') ?? attr(sheet, 'id');
    const part = id ? rels.get(id) : undefined;
    const xml = part ? partText(parts, part) : null;
    if (!xml) continue;
    const read = sheetBlocks(attr(sheet, 'name') ?? '', xml, strings, styles, from1904);
    if (!read) continue;
    truncated ||= read.truncated;
    // A sheet wider than a portrait page goes on landscape pages.
    const landscape = read.width > A4[0] - 2 * MARGIN;
    const [width, height] = landscape ? [A4[1], A4[0]] : A4;
    const setup: SourcePage = { width, height, margins: [MARGIN, MARGIN, MARGIN, MARGIN] };
    if (!page) page = setup;
    else blocks.push({ type: 'page', width, height, margins: setup.margins });
    blocks.push(...read.blocks);
  }
  const title = textOf(firstChild(parseXml(partText(parts, 'docProps/core.xml') ?? ''), 'title')).trim();
  return { blocks, pictures: [], page, title: title || undefined, picturesLeftOut: 0, truncated };
}
