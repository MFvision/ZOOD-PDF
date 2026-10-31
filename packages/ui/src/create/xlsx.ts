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
 * Each cell keeps its fill, its text's colour and weight and its font (theme
 * and indexed colours resolved, tints applied); a sheet wider than the page
 * is scaled to fit it as Excel's "fit to width" prints it, and a word is
 * never broken inside a cell (the core sets a cell smaller instead).
 *
 * Not read: charts, pictures, conditional formats, and anything past the
 * first 2,000 rows or 60 columns of a sheet (the document says it was cut).
 */

const MAX_ROWS = 2_000;
const MAX_COLUMNS = 60;
/** Excel's column width is in characters of the default font's "0" (7 px at Calibri 11) plus 5 px of padding. */
const CHARACTER = 5.25;
const PADDING = 3.75;
/** Text smaller than this is not made to fit a sheet onto the page. */
const MIN_SIZE = 6;
const A4: [number, number] = [595.28, 841.89];
const MARGIN = 36;

/**
 * Whether a sheet's first row is column titles: two or more filled cells, all
 * words (no figures), each bold or shaded, over rows that are not the same.
 */
export function looksLikeHeader(rows: readonly TableCell[][]): boolean {
  if (rows.length < 3) return false;
  const filled = rows[0]!.filter((cell) => cell.text.trim().length > 0);
  if (filled.length < 2) return false;
  return filled.every((cell) => (cell.bold || cell.fill) && cell.align !== 'end' && !/^[\d\s.,%()+-]+$/.test(cell.text.trim()));
}

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
  /** Text the format puts before and after the number: a currency ("SR", "€"), a unit. */
  prefix?: string;
  suffix?: string;
}

/** The literal text a number format's section shows around its number. */
export function literalsOf(section: string): { prefix: string; suffix: string } {
  const parts: { literal: string; number: boolean }[] = [];
  for (let k = 0; k < section.length; k += 1) {
    const c = section[k]!;
    if (c === '"') {
      const end = section.indexOf('"', k + 1);
      parts.push({ literal: section.slice(k + 1, end < 0 ? section.length : end), number: false });
      k = end < 0 ? section.length : end;
    } else if (c === '\\') {
      parts.push({ literal: section[k + 1] ?? '', number: false });
      k += 1;
    } else if (c === '[') {
      const end = section.indexOf(']', k + 1);
      const inner = section.slice(k + 1, end < 0 ? section.length : end);
      // [$SR-401]: a currency's symbol; [Red], [>=100]: nothing shown.
      if (inner.startsWith('$')) parts.push({ literal: inner.slice(1).split('-')[0] ?? '', number: false });
      k = end < 0 ? section.length : end;
    } else if (c === '_' || c === '*') {
      k += 1;
    } else if ('0#?.,'.includes(c) || ((c === 'E' || c === 'e') && /[+-]/.test(section[k + 1] ?? ''))) {
      parts.push({ literal: '', number: true });
      if (c === 'E' || c === 'e') k += 1;
    } else if (c !== '%' && c !== '@') {
      parts.push({ literal: c, number: false });
    }
  }
  const first = parts.findIndex((p) => p.number);
  if (first < 0) return { prefix: '', suffix: '' };
  let last = first;
  parts.forEach((p, k) => {
    if (p.number) last = k;
  });
  const join = (list: typeof parts) => list.map((p) => p.literal).join('');
  return { prefix: join(parts.slice(0, first)), suffix: join(parts.slice(last + 1)) };
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
  const { prefix, suffix } = literalsOf(first);
  return {
    kind: bare.includes('%') ? 'percent' : 'number',
    decimals,
    grouped,
    ...(prefix.trim() ? { prefix } : {}),
    ...(suffix.trim() ? { suffix } : {}),
  };
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
      return `${showNumber(value * 100, { ...shape, kind: 'number', prefix: undefined, suffix: undefined })}%`;
    case 'number': {
      const shown = value.toLocaleString('en-US', {
        minimumFractionDigits: shape.decimals,
        maximumFractionDigits: shape.decimals,
        useGrouping: shape.grouped,
      });
      return `${shape.prefix ?? ''}${shown}${shape.suffix ?? ''}`.trim();
    }
    default: {
      // General: at most eleven significant digits, as Excel shows in a cell.
      if (Number.isInteger(value) && Math.abs(value) < 1e11) return String(value);
      const text = Number(value.toPrecision(11)).toString();
      return text.includes('e') ? value.toExponential(5).toUpperCase() : text;
    }
  }
}

interface Styles {
  /** Per cell style index: its number format's shape, alignment, weight, fill, text colour and font. */
  cells: { shape: NumberShape; align?: string; bold: boolean; fill?: string; color?: string; font?: string }[];
  /** The workbook's default font size and family. */
  size: number;
  font?: string;
}

/** Excel's legacy indexed colours (0–63). */
const INDEXED = [
  '000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff',
  '000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff',
  '800000', '008000', '000080', '808000', '800080', '008080', 'c0c0c0', '808080',
  '9999ff', '993366', 'ffffcc', 'ccffff', '660066', 'ff8080', '0066cc', 'ccccff',
  '000080', 'ff00ff', 'ffff00', '00ffff', '800080', '800000', '008080', '0000ff',
  '00ccff', 'ccffff', 'ccffcc', 'ffff99', '99ccff', 'ff99cc', 'cc99ff', 'ffcc99',
  '3366ff', '33cccc', '99cc00', 'ffcc00', 'ff9900', 'ff6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

/** The theme's colours in the order Excel numbers them: lt1, dk1, lt2, dk2, accent1–6, hlink, folHlink. */
export function readThemeColours(xml: string | null): string[] {
  const root = xml ? parseXml(xml) : null;
  const scheme = firstChild(firstChild(root, 'themeElements'), 'clrScheme');
  const colour = (name: string) => {
    const slot = firstChild(scheme, name);
    const srgb = attr(firstChild(slot, 'srgbClr'), 'val');
    const sys = attr(firstChild(slot, 'sysClr'), 'lastClr');
    return (srgb ?? sys ?? '').toLowerCase();
  };
  return ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(colour);
}

/** `rrggbb` lightened (tint > 0) or darkened (tint < 0) as Excel does, on its HSL lightness. */
export function tinted(hex: string, tint: number): string {
  if (!tint) return hex;
  const [r, g, b] = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r1, g1, b1].map((v) => Math.round(Math.min(1, Math.max(0, v + m)) * 255).toString(16).padStart(2, '0')).join('');
}

/** A `<color>`/`<fgColor>` element as `#rrggbb`, or undefined for automatic. */
export function excelColour(element: XmlElement | null, theme: readonly string[]): string | undefined {
  if (!element) return undefined;
  const tint = Number(attr(element, 'tint') ?? 0) || 0;
  const rgb = attr(element, 'rgb');
  let hex: string | undefined;
  if (rgb && /^[0-9a-f]{6,8}$/i.test(rgb)) hex = rgb.slice(-6).toLowerCase();
  else if (attr(element, 'theme') !== undefined) hex = theme[Number(attr(element, 'theme'))] || undefined;
  else if (attr(element, 'indexed') !== undefined) hex = INDEXED[Number(attr(element, 'indexed'))];
  if (!hex || !/^[0-9a-f]{6}$/.test(hex)) return undefined;
  return `#${tinted(hex, tint)}`;
}

function readStyles(xml: string | null, theme: readonly string[] = []): Styles {
  const root = xml ? parseXml(xml) : null;
  const codes = new Map<number, string>();
  for (const f of childElements(firstChild(root, 'numFmts'), 'numFmt')) {
    const id = Number(attr(f, 'numFmtId'));
    const code = attr(f, 'formatCode');
    if (Number.isFinite(id) && code !== undefined) codes.set(id, code);
  }
  const fonts = childElements(firstChild(root, 'fonts'), 'font').map((font) => {
    const b = firstChild(font, 'b');
    const color = excelColour(firstChild(font, 'color'), theme);
    return {
      bold: b !== null && attr(b, 'val') !== '0' && attr(b, 'val') !== 'false',
      color: color === '#000000' ? undefined : color,
      size: Number(attr(firstChild(font, 'sz'), 'val')) || undefined,
      name: attr(firstChild(font, 'name'), 'val'),
    };
  });
  const fills = childElements(firstChild(root, 'fills'), 'fill').map((fill) => {
    const pattern = firstChild(fill, 'patternFill');
    if (!pattern || (attr(pattern, 'patternType') ?? 'none') === 'none') return undefined;
    const colour = excelColour(firstChild(pattern, 'fgColor'), theme) ?? excelColour(firstChild(pattern, 'bgColor'), theme);
    return colour === '#ffffff' ? undefined : colour;
  });
  const cells = childElements(firstChild(root, 'cellXfs'), 'xf').map((xf) => {
    const id = Number(attr(xf, 'numFmtId') ?? 0);
    const code = codes.get(id) ?? BUILT_IN[id];
    const font = fonts[Number(attr(xf, 'fontId') ?? 0)];
    return {
      shape: shapeOf(code),
      align: attr(firstChild(xf, 'alignment'), 'horizontal'),
      bold: font?.bold ?? false,
      fill: fills[Number(attr(xf, 'fillId') ?? 0)],
      color: font?.color,
      font: font?.name,
    };
  });
  return { cells, size: fonts[0]?.size ?? 11, font: fonts[0]?.name };
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
  fill?: string;
  color?: string;
  font?: string;
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
      // An empty cell with a fill still shows its colour (a banded header).
      if (text === '' && !style?.fill) continue;
      cells.set(ri * MAX_COLUMNS + ci, { text, numeric, bold: style?.bold ?? false, align: style?.align, fill: style?.fill, color: style?.color, font: style?.font });
      // Only cells with something in them make the table larger: a whole row
      // coloured to the sheet's edge does not.
      if (text === '') continue;
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
      if (cell?.fill) out.fill = cell.fill;
      if (cell?.color) out.color = cell.color;
      if (cell?.font && cell.font !== styles.font) out.font = cell.font;
      if (cell?.align === 'center' || cell?.align === 'centerContinuous') out.align = 'center';
      else if (cell?.numeric || cell?.align === 'right') out.align = 'end';
      if (cell && !cell.numeric && /[\u0600-\u06FF]/.test(cell.text)) out.dir = 'rtl';
      row.push(out);
    }
    rows.push(row);
  }
  const relative = columns.map((k) => (widths[k] ?? 8.43) * CHARACTER + PADDING);
  const natural = relative.reduce((sum, w) => sum + w, 0);
  // Wider than a landscape page: everything scaled down together, as
  // Excel's "fit all columns on one page" prints it.
  const room = A4[1] - 2 * MARGIN;
  const scale = natural > room ? room / natural : 1;
  const size = Math.max(MIN_SIZE, Math.round(styles.size * 0.9 * scale * 10) / 10);
  const table: Block = { type: 'table', rows, widths: relative, dir: rtl ? 'rtl' : 'ltr', size };
  if (styles.font) table.font = styles.font;
  // A first row that reads as column titles is printed again at the top of
  // every page, as Excel's "Print titles" does (First Five, 2026-10-31: page
  // two of a staff list had no column names).
  if (looksLikeHeader(rows)) table.headerRows = 1;
  return {
    blocks: [
      { type: 'text', text: name, size: 14, bold: true, keepWithNext: true, spaceAfter: 8, dir: rtl ? 'rtl' : 'auto', ...(styles.font ? { font: styles.font } : {}) },
      table,
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
      name === 'xl/theme/theme1.xml' ||
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
  const styles = readStyles(partText(parts, 'xl/styles.xml'), readThemeColours(partText(parts, 'xl/theme/theme1.xml')));
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
