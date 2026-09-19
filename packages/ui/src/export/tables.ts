import type { TextDirection } from '../core/types';
import { cleanText } from './text';

/** A cell of a table the core found (`export.tables`): its text, and the grid cells it covers. */
export interface FoundCell {
  text: string;
  rows: number;
  columns: number;
}

/** A table the core found: its grid left to right as drawn; `null` where a merged cell covers. */
export interface TableItem {
  kind: 'table';
  ruled: boolean;
  direction: TextDirection;
  /** Its columns' widths in points, left to right. */
  widths: number[];
  rows: (FoundCell | null)[][];
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
}

export type SheetValue = { kind: 'number'; value: number; format: NumberFormat; text: string } | { kind: 'text'; text: string };

export interface SheetCell {
  value: SheetValue;
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
  if (whole.replace(/,/g, '').length + (m[2]?.length ?? 0) > 15) return null;
  let value = Number(`${whole.replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
  if (!Number.isFinite(value)) return null;
  if (negative) value = -value;
  if (percent) value /= 100;
  return { value, format: { decimals: Math.min(m[2]?.length ?? 0, 10), grouped: whole.includes(','), percent } };
}

export function valueOf(raw: string): SheetValue {
  const text = cleanText(raw).replace(/\s+/g, ' ').trim();
  const number = parseNumber(text);
  return number ? { kind: 'number', ...number, text } : { kind: 'text', text };
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

/** Each table of the document as a sheet of its own. */
export function tableSheets(pages: readonly (readonly PageItem[])[], name: (table: number) => string): Sheet[] {
  const out: Sheet[] = [];
  for (const items of pages) {
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
