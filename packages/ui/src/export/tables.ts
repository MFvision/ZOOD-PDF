import type { TextDirection } from '../core/types';
import { cleanText } from './text';

/** A cell of a table the core found (`export.tables`): its text, and the grid cells it covers. */
export interface FoundCell {
  text: string;
  rows: number;
  columns: number;
  /** Where its text is on the page, `[x, y, width, height]` in points; absent when it has none. */
  box?: [number, number, number, number];
  /** The colour the page paints behind it, `RRGGBB`, when not white (read from the page's picture). */
  fill?: string;
}

/** A table the core found: its grid left to right as drawn; `null` where a merged cell covers. */
export interface TableItem {
  kind: 'table';
  ruled: boolean;
  direction: TextDirection;
  /** Its columns' widths in points, left to right. */
  widths: number[];
  rows: (FoundCell | null)[][];
  /** Where it is on the page, in points from the top-left corner. */
  left?: number;
  top?: number;
  /** Its rows' heights in points, top to bottom. */
  heights?: number[];
}

/** A line of text outside every table, cut at its wide gaps (left to right). */
export interface LineItem {
  kind: 'line';
  text: string;
  direction: TextDirection;
  cells: { text: string; x0: number; x1: number; direction: TextDirection }[];
}

export type PageItem = TableItem | LineItem;

/** How a number was written: Excel shows it the same way. */
export interface NumberFormat {
  decimals: number;
  grouped: boolean;
  percent: boolean;
  /** A currency written with it ("$12,000", "1,250.50 ر.س"), and on which side. */
  currency?: { symbol: string; before: boolean };
  /** A unit written after it ("1.00 Units", "3 قطعة"): shown after the number, as it was. */
  unit?: string;
  /** A date: Excel's own code for it, as it was written ("dd/mm/yyyy"). */
  date?: string;
}

/** Currency signs a number may carry before or after it, and the riyal's abbreviation. */
const CURRENCY =
  /^(\$|€|£|¥|﷼|ر\.س\.?|ريال|SAR|SR|USD|EUR|GBP|AED|د\.إ\.?|KWD|QAR|BHD|OMR|EGP)\s*(.+)$|^(.+?)\s*(\$|€|£|¥|﷼|ر\.س\.?|ريال|SAR|SR|USD|EUR|GBP|AED|د\.إ\.?|KWD|QAR|BHD|OMR|EGP)$/u;

/** Units of count, weight, length, area and time a quantity may carry after it. */
const UNIT = /^(.+?)\s+(units?|pcs|pc|ea|each|nos?\.?|kg|g|m|m2|m²|km|sqm|hrs?|hours?|days?|months?|وحدة|وحدات|حبة|قطعة|كجم|كغ|متر|م²|م2|ساعة|ساعات|يوم|أيام|شهر|أشهر)$/iu;

export type SheetValue = { kind: 'number'; value: number; format: NumberFormat; text: string } | { kind: 'text'; text: string };

export interface SheetCell {
  value: SheetValue;
  /** The cell's fill and its text's colour, `RRGGBB`. */
  fill?: string;
  color?: string;
  /** A thin border all round: the table was drawn with rules. */
  border?: boolean;
  /** A web or mail address the cell's text links to. */
  link?: string;
  /** How many rows and columns it covers when it is merged. */
  rows?: number;
  columns?: number;
}

/** A sheet: rows of cells, column A first in the sheet's direction; `null` for an empty or covered cell. */
export interface Sheet {
  name: string;
  rtl: boolean;
  rows: (SheetCell | null)[][];
  /** Column widths in characters, where known. */
  widths: number[];
}

/** One sheet for each page, or one for each table. */
export type SheetMode = 'page' | 'table';

// Digits and signs of Arabic script, and the marks bidi text carries.
const ARABIC_INDIC = /[٠-٩]/g;
const PERSIAN = /[۰-۹]/g;
const MARKS = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;

/**
 * A number, if `text` is nothing but one: digits Western, Arabic-Indic or
 * Persian; thousands grouped with `,` or `٬`; a decimal point `.` or `٫`; a
 * sign, or parentheses as accountants write a loss; a percent sign before or
 * after (right-to-left text is often read with it before). A leading zero
 * (a code), a date, a phone number or anything with letters stays text, so
 * the sheet never changes what a cell says.
 */
export function parseNumber(raw: string): { value: number; format: NumberFormat } | null {
  let text = raw
    .replace(MARKS, '')
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/٪/g, '%')
    .replace(/[−‒–]/g, '-')
    .trim();
  let negative = false;
  const paren = /^\((.*)\)$/.exec(text);
  if (paren) {
    negative = true;
    text = paren[1]!.trim();
  }
  let currency: NumberFormat['currency'];
  // "-$5" as well as "$-5".
  const minus = /^-\s*(?=\D)/.exec(text);
  const money = CURRENCY.exec(minus ? text.slice(minus[0].length) : text);
  if (money) {
    currency = money[1] ? { symbol: money[1], before: true } : { symbol: money[4]!, before: false };
    text = `${minus ? '-' : ''}${(money[2] ?? money[3]!).trim()}`;
  }
  let unit: string | undefined;
  const counted = currency ? null : UNIT.exec(text);
  if (counted) {
    unit = counted[2]!;
    text = counted[1]!.trim();
  }
  let percent = false;
  if (text.endsWith('%') || text.startsWith('%')) {
    percent = true;
    text = text.replace(/^%|%$/g, '').trim();
  }
  const sign = /^([-+])/.exec(text);
  if (sign) {
    if (sign[1] === '-') negative = !negative;
    text = text.slice(1).trim();
  }
  const m = /^((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const whole = m[1]!;
  // "007" is a code, not seven; "0.5" and "0" are numbers.
  if (/^0\d/.test(whole)) return null;
  // A long run of digits, not grouped, is an ID, an account or a phone number: text, as written.
  if (!whole.includes(',') && whole.length >= 8 && !m[2]) return null;
  if (whole.replace(/,/g, '').length + (m[2]?.length ?? 0) > 15) return null;
  let value = Number(`${whole.replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
  if (!Number.isFinite(value)) return null;
  if (negative) value = -value;
  // A hundredth by division is not always the decimal written: 4.1% is 0.041, not 0.040999999999999995.
  if (percent) value = Number((value / 100).toPrecision(15));
  return {
    value,
    format: {
      decimals: Math.min(m[2]?.length ?? 0, 10),
      grouped: whole.includes(','),
      percent,
      ...(currency && !percent ? { currency } : {}),
      ...(unit && !percent ? { unit } : {}),
    },
  };
}

/**
 * A date, if `text` is nothing but one: day/month/year as Saudi papers
 * write it (month/day only when the day cannot be the first), or year-month-day,
 * with `/`, `-` or `.`, digits Western or Arabic-Indic. Its value is Excel's
 * day number, and its format writes it back exactly as it was.
 */
export function parseDate(raw: string): { value: number; format: NumberFormat } | null {
  const text = raw
    .replace(MARKS, '')
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN, (d) => String(d.charCodeAt(0) - 0x06f0))
    .trim();
  let day: number, month: number, year: number, code: string;
  const dmy = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/.exec(text);
  const ymd = /^(\d{4})([/.-])(\d{1,2})\2(\d{1,2})$/.exec(text);
  const part = (digits: string, letter: string) => letter.repeat(digits.length);
  if (dmy) {
    const [, a, sep, b, y] = dmy as unknown as [string, string, string, string, string];
    const monthFirst = Number(b) > 12 && Number(a) <= 12;
    day = Number(monthFirst ? b : a);
    month = Number(monthFirst ? a : b);
    year = Number(y);
    code = monthFirst ? `${part(a, 'm')}${sep}${part(b, 'd')}${sep}yyyy` : `${part(a, 'd')}${sep}${part(b, 'm')}${sep}yyyy`;
  } else if (ymd) {
    const [, y, sep, a, b] = ymd as unknown as [string, string, string, string, string];
    year = Number(y);
    month = Number(a);
    day = Number(b);
    code = `yyyy${sep}${part(a, 'm')}${sep}${part(b, 'd')}`;
  } else return null;
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const time = Date.UTC(year, month - 1, day);
  if (new Date(time).getUTCDate() !== day) return null;
  // Excel counts days from 30 December 1899.
  const value = Math.round(time / 86_400_000) + 25_569;
  return { value, format: { decimals: 0, grouped: false, percent: false, date: code.replace(/\./g, '\\.') } };
}

export function valueOf(raw: string): SheetValue {
  const text = cleanText(raw).replace(/\s+/g, ' ').trim();
  const number = parseNumber(text) ?? parseDate(text);
  return number ? { kind: 'number', ...number, text } : { kind: 'text', text };
}

/** Text that reads on a fill: white on a dark one, else the default. */
function textOn(fill: string | undefined): string | undefined {
  if (!fill) return undefined;
  const [r, g, b] = [0, 2, 4].map((k) => parseInt(fill.slice(k, k + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45 ? 'FFFFFF' : undefined;
}

/** Points to Excel's characters (the width of a digit of its default face, 7 pixels). */
const CHARACTER = 5.25;

/**
 * A table's rows in the sheet's column order: left to right as drawn, or
 * for a right-to-left sheet from the right, so column A is the table's
 * first column either way. Merged cells keep their size.
 */
function tableRows(table: TableItem, rtl: boolean): { rows: (SheetCell | null)[][]; widths: number[] } {
  const columns = table.widths.length || Math.max(0, ...table.rows.map((r) => r.length));
  const rows = table.rows.map((row) => {
    const out: (SheetCell | null)[] = Array.from({ length: columns }, () => null);
    row.forEach((cell, c) => {
      if (!cell) return;
      const span = Math.max(1, cell.columns);
      // Right to left, a cell covering columns c…c+span-1 starts at the mirror of its right edge.
      const at = rtl ? columns - c - span : c;
      if (at < 0 || at >= columns) return;
      const out_: SheetCell = { value: valueOf(cell.text) };
      if (cell.fill) out_.fill = cell.fill;
      const color = textOn(cell.fill);
      if (color) out_.color = color;
      if (table.ruled) out_.border = true;
      if (cell.rows > 1) out_.rows = cell.rows;
      if (span > 1) out_.columns = span;
      out[at] = out_;
    });
    return out;
  });
  const widths = (rtl ? [...table.widths].reverse() : table.widths).map((w) => Math.round(Math.min(80, Math.max(4, w / CHARACTER))));
  return { rows, widths };
}

/** The direction most of a page's text reads in. */
function pageDirection(items: readonly PageItem[]): TextDirection {
  let rtl = 0;
  let ltr = 0;
  const count = (text: string, direction: TextDirection) => {
    const weight = text.replace(/[\s\p{M}\p{N}\p{P}\p{S}]/gu, '').length;
    if (direction === 'rtl') rtl += weight;
    else ltr += weight;
  };
  for (const item of items) {
    if (item.kind === 'line') count(item.text, item.direction);
    else for (const cell of item.rows.flat()) if (cell) count(cell.text, item.direction);
  }
  return rtl > ltr ? 'rtl' : 'ltr';
}

/**
 * A page as a sheet: its tables, cell for cell, and every other line as a
 * row — cut into columns where the line has wide gaps. A right-to-left page
 * is a right-to-left sheet.
 */
export function pageSheet(items: readonly PageItem[], name: string): Sheet {
  const rtl = pageDirection(items) === 'rtl';
  const rows: (SheetCell | null)[][] = [];
  const widths: number[] = [];
  let previous: PageItem['kind'] | null = null;
  for (const item of items) {
    if (item.kind === 'table') {
      if (previous !== null) rows.push([]);
      const table = tableRows(item, rtl);
      rows.push(...table.rows);
      table.widths.forEach((w, k) => {
        widths[k] = Math.max(widths[k] ?? 0, w);
      });
      previous = 'table';
      continue;
    }
    if (previous === 'table') rows.push([]);
    const cells = item.cells.length > 1 ? (rtl ? [...item.cells].reverse() : item.cells).map((c) => c.text) : [item.text];
    rows.push(cells.map((text) => ({ value: valueOf(text) })));
    previous = 'line';
  }
  return { name, rtl, rows: trim(rows), widths };
}

/** Each table of the document as a sheet of its own; one that runs on over pages, one sheet. */
export function tableSheets(pages: readonly (readonly PageItem[])[], name: (table: number) => string): Sheet[] {
  const out: Sheet[] = [];
  const copies = pages.map((items) => items.map((item) => (item.kind === 'table' ? { ...item, rows: item.rows.map((row) => [...row]) } : item)));
  for (const { items } of joinAcrossPages(copies)) {
    for (const item of items) {
      if (item.kind !== 'table') continue;
      const rtl = item.direction === 'rtl';
      const { rows, widths } = tableRows(item, rtl);
      out.push({ name: name(out.length + 1), rtl, rows: trim(rows), widths });
    }
  }
  return out;
}

/** No empty cells at the ends of rows, and no empty rows at the end. */
function trim(rows: (SheetCell | null)[][]): (SheetCell | null)[][] {
  const empty = (cell: SheetCell | null) => cell === null || (cell.value.text === '' && !cell.columns && !cell.rows);
  for (const row of rows) while (row.length > 0 && empty(row[row.length - 1]!)) row.pop();
  while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
  return rows;
}

/** Whether a sheet has anything in it. */
export function sheetHasText(sheet: Sheet): boolean {
  return sheet.rows.some((row) => row.some((cell) => cell !== null && cell.value.text !== ''));
}

/**
 * Gives each cell whose text holds a linked stretch of the document's text
 * that link, as a sheet links a whole cell.
 */
export function linkSheets(sheets: readonly Sheet[], linked: readonly { text: string; uri: string }[]): void {
  const usable = linked.filter((l) => l.text.trim().length > 1);
  if (usable.length === 0) return;
  for (const sheet of sheets) {
    for (const cell of sheet.rows.flat()) {
      if (!cell || cell.value.kind !== 'text' || cell.link) continue;
      const found = usable.find((l) => cell.value.text.includes(l.text.trim()));
      if (found) cell.link = found.uri;
    }
  }
}

/**
 * A table without the columns and rows that hold nothing: rules a little
 * apart, or a frame drawn round a table, make grid lines no column of text
 * stands between. What each takes up goes to its neighbour (the one before
 * it, or after the first), so the table keeps its size; a merged cell over
 * it covers one fewer.
 */
export function compactTable(table: TableItem): TableItem {
  const columns = table.widths.length || Math.max(0, ...table.rows.map((r) => r.length));
  const filled = (cell: FoundCell | null | undefined) => cell !== null && cell !== undefined && cell.text.trim().length > 0;
  const keepColumn = Array.from({ length: columns }, (_, c) => table.rows.some((row) => filled(row[c])));
  const keepRow = table.rows.map((row) => row.some(filled));
  if (keepColumn.every(Boolean) && keepRow.every(Boolean)) return table;
  if (!keepColumn.some(Boolean)) return { ...table, widths: [], rows: [], ...(table.heights ? { heights: [] } : {}) };
  // A cell keeps its text; it covers only the columns and rows that stay.
  const kept = (from: number, span: number, keep: boolean[]) => keep.slice(from, from + Math.max(1, span)).filter(Boolean).length;
  const rows = table.rows.flatMap((row, r) => {
    if (!keepRow[r]) return [];
    const out: (FoundCell | null)[] = [];
    for (let c = 0; c < columns; c += 1) {
      if (!keepColumn[c]) continue;
      const cell = row[c];
      out.push(cell ? { ...cell, columns: Math.max(1, kept(c, cell.columns, keepColumn)), rows: Math.max(1, kept(r, cell.rows, keepRow)) } : null);
    }
    return [out];
  });
  /** Each removed size given to the kept one before it, or after it for those first. */
  const fold = (sizes: readonly number[], keep: readonly boolean[]) => {
    const out: number[] = [];
    let carried = 0;
    sizes.forEach((size, k) => {
      if (keep[k]) {
        out.push(size + carried);
        carried = 0;
      } else if (out.length > 0) out[out.length - 1]! += size;
      else carried += size;
    });
    return out;
  };
  return {
    ...table,
    rows,
    widths: fold(table.widths, keepColumn),
    ...(table.heights ? { heights: fold(table.heights, keepRow) } : {}),
  };
}

/**
 * A table read from columns of text, with the lines a cell wrapped onto
 * joined back into it: a row that fills fewer columns than the one above,
 * only columns that row fills, with no number in it, and that starts within
 * a line's height of it, is the rest of that row's cells. Ruled tables
 * already hold each cell's lines together.
 */
export function joinWrapped(table: TableItem): TableItem {
  if (table.ruled || table.rows.length < 2) return table;
  const filled = (cell: FoundCell | null | undefined): cell is FoundCell => !!cell && cell.text.trim().length > 0;
  const rows: (FoundCell | null)[][] = [];
  const heights: number[] = [];
  let joined = false;
  table.rows.forEach((row, r) => {
    const above = rows[rows.length - 1];
    const own = row.map((cell, c) => (filled(cell) ? c : -1)).filter((c) => c >= 0);
    const theirs = above ? above.map((cell, c) => (filled(cell) ? c : -1)).filter((c) => c >= 0) : [];
    const close = () => {
      const bottom = Math.max(...theirs.map((c) => (above![c]!.box ? above![c]!.box![1] + above![c]!.box![3] : NaN)));
      const top = Math.min(...own.map((c) => row[c]!.box?.[1] ?? NaN));
      const line = Math.max(...own.map((c) => row[c]!.box?.[3] ?? 0));
      return Number.isFinite(bottom) && Number.isFinite(top) && line > 0 && top - bottom < line * 0.8;
    };
    const rest =
      above !== undefined &&
      own.length > 0 &&
      theirs.length >= 2 &&
      own.length < theirs.length &&
      own.every((c) => theirs.includes(c) && row[c]!.columns === above[c]!.columns && parseNumber(row[c]!.text.trim()) === null) &&
      close();
    if (!rest) {
      rows.push(row.map((cell) => (cell ? { ...cell } : null)));
      heights.push(table.heights?.[r] ?? 0);
      return;
    }
    joined = true;
    for (const c of own) {
      const top = above[c]!;
      const more = row[c]!;
      top.text = `${top.text.trim()} ${more.text.trim()}`;
      if (top.box && more.box) {
        const [x0, y0] = [Math.min(top.box[0], more.box[0]), top.box[1]];
        const x1 = Math.max(top.box[0] + top.box[2], more.box[0] + more.box[2]);
        top.box = [x0, y0, x1 - x0, more.box[1] + more.box[3] - y0];
      }
    }
    heights[heights.length - 1]! += table.heights?.[r] ?? 0;
  });
  if (!joined) return table;
  return { ...table, rows, ...(table.heights ? { heights } : {}) };
}

/** Whether `next` goes on from `table`: as many columns, each as wide within a few points. */
function continues(table: TableItem, next: TableItem): boolean {
  return (
    table.widths.length > 1 &&
    table.widths.length === next.widths.length &&
    table.direction === next.direction &&
    table.widths.every((w, k) => Math.abs(w - next.widths[k]!) <= 6)
  );
}

const sameRow = (a: readonly (FoundCell | null)[], b: readonly (FoundCell | null)[]) =>
  a.length === b.length && a.every((cell, k) => (cell?.text.trim() ?? '') === (b[k]?.text.trim() ?? ''));

/**
 * Tables that run on over pages, joined: a page's first table that goes on
 * from the last table of the page before becomes more of its rows (its
 * header, when the page repeats it, left out). Each page's items, with
 * `joined` true where the page's first table went on from before.
 */
export function joinAcrossPages(pages: readonly (readonly PageItem[])[]): { items: PageItem[]; joined: boolean }[] {
  const out: { items: PageItem[]; joined: boolean }[] = [];
  let last: TableItem | null = null;
  for (const items of pages) {
    const tables = items.filter((item): item is TableItem => item.kind === 'table');
    const first = tables[0];
    if (last && first && continues(last, first)) {
      const header = last.rows[0];
      const rows = header && first.rows[0] && sameRow(header, first.rows[0]) ? first.rows.slice(1) : first.rows;
      last.rows.push(...rows);
      if (last.heights && first.heights) last.heights.push(...first.heights.slice(first.rows.length - rows.length));
      out.push({ items: items.filter((item) => item !== first), joined: true });
    } else {
      out.push({ items: [...items], joined: false });
    }
    const end = (out[out.length - 1]!.joined ? tables.slice(1) : tables).at(-1);
    if (end) last = end;
    else if (!out[out.length - 1]!.joined) last = null;
  }
  return out;
}

/**
 * One sheet for each page, but a page whose table goes on from the page
 * before carries on that page's sheet: its rows, then the page's other
 * lines (those the pages repeat, such as a header or "Page 2 of 3", left out).
 */
export function pageSheets(pages: readonly (readonly PageItem[])[], name: (page: number) => string): Sheet[] {
  const copies = pages.map((items) => items.map((item) => (item.kind === 'table' ? { ...item, rows: item.rows.map((row) => [...row]), ...(item.heights ? { heights: [...item.heights] } : {}) } : item)));
  const joined = joinAcrossPages(copies);
  const words = (item: PageItem) => (item.kind === 'line' ? item.text.replace(/[\d٠-٩]+/g, '#').trim() : '');
  const groups: { first: number; items: PageItem[] }[] = [];
  joined.forEach(({ items, joined: goesOn }, index) => {
    const group = groups[groups.length - 1];
    if (goesOn && group) {
      const before = new Set(pages[index - 1]!.map(words).filter(Boolean));
      group.items.push(...items.filter((item) => item.kind !== 'line' || !before.has(words(item))));
    } else groups.push({ first: index, items });
  });
  return groups.map((group) => pageSheet(group.items, name(group.first + 1)));
}

/**
 * Gives each cell of `table` the colour the page paints behind it, read
 * from the page drawn without its text (`rgba`, `width` × `height` pixels at
 * `scale` pixels a point): the colour most of the cell is, when it is most
 * of it and not white.
 */
export function fillCells(table: TableItem, rgba: Uint8Array, width: number, height: number, scale: number): void {
  if (table.left === undefined || table.top === undefined || !table.heights || table.heights.length !== table.rows.length) return;
  const xs = [table.left];
  for (const w of table.widths) xs.push(xs[xs.length - 1]! + w);
  const ys = [table.top];
  for (const h of table.heights) ys.push(ys[ys.length - 1]! + h);
  table.rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (!cell) return;
      const x0 = xs[c];
      const x1 = xs[Math.min(xs.length - 1, c + Math.max(1, cell.columns))];
      const y0 = ys[r];
      const y1 = ys[Math.min(ys.length - 1, r + Math.max(1, cell.rows))];
      if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) return;
      const fill = mostColour(rgba, width, height, x0 * scale + 2, y0 * scale + 2, x1 * scale - 2, y1 * scale - 2);
      if (fill) cell.fill = fill;
    });
  });
}

/** The colour most of a box of the picture is, `RRGGBB`, if it is 60% of it and not white. */
function mostColour(rgba: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number): string | null {
  const [left, top] = [Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0))];
  const [right, bottom] = [Math.min(width, Math.ceil(x1)), Math.min(height, Math.ceil(y1))];
  if (right - left < 2 || bottom - top < 2) return null;
  // At most about 400 samples a cell, however big.
  const step = Math.max(1, Math.floor(Math.sqrt(((right - left) * (bottom - top)) / 400)));
  // Each colour, a little coarse so antialiasing and noise fall together, with its pixels' sums.
  const counts = new Map<number, [n: number, r: number, g: number, b: number]>();
  let total = 0;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const k = (y * width + x) * 4;
      const [r, g, b] = [rgba[k]!, rgba[k + 1]!, rgba[k + 2]!];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const seen = counts.get(key);
      if (seen) {
        seen[0] += 1;
        seen[1] += r;
        seen[2] += g;
        seen[3] += b;
      } else counts.set(key, [1, r, g, b]);
      total += 1;
    }
  }
  let best: [number, number, number, number] | null = null;
  for (const seen of counts.values()) if (!best || seen[0] > best[0]) best = seen;
  if (!best || best[0] < total * 0.6) return null;
  const count = best[0];
  const [r, g, b] = [best[1], best[2], best[3]].map((sum) => Math.round(sum / count)) as [number, number, number];
  if (r >= 240 && g >= 240 && b >= 240) return null;
  return [r, g, b].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');
}
