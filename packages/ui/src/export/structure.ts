import type { TextDirection, TextLineData, TextLink } from '../core/types';
import type { ExportFont, ExportParagraph } from './paragraphs';
import { trimLine } from './paragraphs';
import { compactTable } from './tables';
import type { FoundCell, PageItem, TableItem } from './tables';
import { cleanText } from './text';

/**
 * What the exports that rebuild a document — Word, Markdown, HTML, text,
 * PowerPoint — need beyond paragraphs: the page's tables as tables, with
 * the links in their cells, and where each falls among the paragraphs.
 */

/** A table found on the page, placed, its cells in reading order. */
export interface ExportTable {
  direction: TextDirection;
  ruled: boolean;
  /** Points from the page's top-left corner. */
  left: number;
  top: number;
  /** Left to right as drawn, in points. */
  widths: number[];
  /** Top to bottom, in points. */
  heights: number[];
  /**
   * Rows of cells in reading order — for a right-to-left table, its first
   * cell is its rightmost — `null` where a merged cell covers.
   */
  rows: (ExportCell | null)[][];
}

export interface ExportCell extends FoundCell {
  links?: TextLink[];
}

/** One thing on a page, in reading order: a paragraph, or a table. */
export type ExportBlock = { kind: 'paragraph'; paragraph: ExportParagraph } | { kind: 'table'; table: ExportTable };

/**
 * A table's rows in reading order. Left to right as drawn, a cell covering
 * columns c…c+span-1 of a right-to-left table starts at the mirror of its
 * right edge.
 */
export function readingRows<T extends FoundCell>(table: { widths: number[]; rows: (T | null)[][]; direction: TextDirection }): (T | null)[][] {
  const columns = table.widths.length || Math.max(0, ...table.rows.map((r) => r.length));
  if (table.direction !== 'rtl') return table.rows.map((row) => Array.from({ length: columns }, (_, c) => row[c] ?? null));
  return table.rows.map((row) => {
    const out: (T | null)[] = Array.from({ length: columns }, () => null);
    row.forEach((cell, c) => {
      if (!cell) return;
      const at = columns - c - Math.max(1, cell.columns);
      if (at >= 0 && at < columns) out[at] = cell;
    });
    return out;
  });
}

/** Where a table is: its box in points. */
export function tableBox(table: ExportTable): Box {
  return {
    x: table.left,
    y: table.top,
    width: table.widths.reduce((a, b) => a + b, 0),
    height: table.heights.reduce((a, b) => a + b, 0),
  };
}

/** Whether a line's middle is inside `box`, give or take a point. */
function inside(line: Pick<TextLineData, 'x' | 'y' | 'width' | 'height'>, box: Box): boolean {
  const cx = line.x + line.width / 2;
  const cy = line.y + line.height / 2;
  return cx >= box.x - 1 && cx <= box.x + box.width + 1 && cy >= box.y - 1 && cy <= box.y + box.height + 1;
}

/** The linked words of the lines in a table's box, given to the cells that hold them. */
function linkCells(rows: (ExportCell | null)[][], lines: readonly TextLineData[]): void {
  const linked = lines.flatMap((line) => {
    const own = trimLine(line);
    return own.links.map((link) => ({ text: own.text.slice(link.from, link.to), uri: link.uri }));
  });
  if (linked.length === 0) return;
  for (const cell of rows.flat()) {
    if (!cell) continue;
    for (const { text, uri } of linked) {
      const from = text.length > 0 ? cell.text.indexOf(text) : -1;
      if (from < 0) continue;
      const links = (cell.links ??= []);
      if (!links.some((l) => l.from < from + text.length && from < l.to)) links.push({ from, to: from + text.length, uri });
    }
    cell.links?.sort((a, b) => a.from - b.from);
  }
}

/**
 * The tables of a page (`export.tables`) that the core placed, in reading
 * order, with the links of `lines` in their cells.
 */
export function pageTables(items: readonly PageItem[], lines: readonly TextLineData[]): ExportTable[] {
  return items.flatMap((item): ExportTable[] => {
    if (item.kind !== 'table' || item.left === undefined || item.top === undefined || !item.heights) return [];
    const placed = compactTable(item) as TableItem & { left: number; top: number; heights: number[] };
    // One column of text is a box round paragraphs, not a table: its lines stay paragraphs.
    if (placed.widths.length < 2 || placed.rows.length === 0) return [];
    const rows = readingRows<ExportCell>({
      widths: placed.widths,
      direction: placed.direction,
      rows: placed.rows.map((row) => row.map((cell) => (cell ? { ...cell, text: cleanText(cell.text).replace(/\s+/g, ' ').trim() } : null))),
    });
    const table: ExportTable = {
      direction: placed.direction,
      ruled: placed.ruled,
      left: placed.left,
      top: placed.top,
      widths: placed.widths,
      heights: placed.heights,
      rows,
    };
    linkCells(rows, lines.filter((line) => inside(line, tableBox(table))));
    return [table];
  });
}

/** The lines outside every table: the ones inside are its cells, and go with it. */
export function outsideTables<L extends Pick<TextLineData, 'x' | 'y' | 'width' | 'height'>>(lines: readonly L[], tables: readonly ExportTable[]): L[] {
  if (tables.length === 0) return [...lines];
  const boxes = tables.map(tableBox);
  return lines.filter((line) => !boxes.some((box) => inside(line, box)));
}

/**
 * The page in reading order: its paragraphs (made of the lines outside
 * every table), and each table where it starts — before the first
 * paragraph below its top.
 */
export function pageBlocks(paragraphs: readonly ExportParagraph[], tables: readonly ExportTable[]): ExportBlock[] {
  const blocks: ExportBlock[] = paragraphs.map((paragraph) => ({ kind: 'paragraph', paragraph }));
  const top = (block: ExportBlock) => (block.kind === 'paragraph' ? Math.min(...(block.paragraph.lines ?? []).map((l) => l.y)) : block.table.top);
  for (const table of [...tables].sort((a, b) => a.top - b.top)) {
    const at = blocks.findIndex((block) => block.kind === 'paragraph' && top(block) > table.top);
    blocks.splice(at < 0 ? blocks.length : at, 0, { kind: 'table', table });
  }
  return blocks;
}

/** A stretch of text, linked or not. */
export interface TextPiece {
  text: string;
  uri?: string;
}

/** `text` cut where its links start and end. */
export function linkedPieces(text: string, links: readonly TextLink[] | undefined): TextPiece[] {
  if (!links || links.length === 0) return [{ text }];
  const pieces: TextPiece[] = [];
  let at = 0;
  for (const link of [...links].sort((a, b) => a.from - b.from)) {
    const from = Math.max(at, Math.min(text.length, link.from));
    const to = Math.max(from, Math.min(text.length, link.to));
    if (from > at) pieces.push({ text: text.slice(at, from) });
    if (to > from) pieces.push({ text: text.slice(from, to), uri: link.uri });
    at = to;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

/** A rectangle on the page, in points. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where each cell of a table's reading-order rows is on the page, merges
 * and all; `null` where a merge covers.
 */
export function cellBoxes(table: ExportTable): (Box | null)[][] {
  const columns = table.widths.length;
  const xs = [table.left];
  for (const w of table.widths) xs.push(xs[xs.length - 1]! + w);
  const ys = [table.top];
  for (const h of table.heights) ys.push(ys[ys.length - 1]! + h);
  return table.rows.map((row, r) =>
    row.map((cell, c) => {
      if (!cell) return null;
      const span = Math.max(1, Math.min(columns, cell.columns));
      const first = table.direction === 'rtl' ? columns - c - span : c;
      const x0 = xs[Math.max(0, first)] ?? table.left;
      const x1 = xs[Math.min(columns, first + span)] ?? x0;
      const y0 = ys[r] ?? table.top;
      const y1 = ys[Math.min(ys.length - 1, r + Math.max(1, cell.rows))] ?? y0;
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }),
  );
}

/** How a cell's text sits in it: across, and up and down. */
export interface CellPlace {
  align: 'start' | 'center' | 'end';
  valign: 'top' | 'center' | 'bottom';
  /** Points between the text and the side of the cell it is set against; 0 when centred. */
  inset: number;
}

/**
 * Where a cell's lines sit in its box: centred when the room either side is
 * about even, else against the side that has least.
 */
export function cellPlace(box: Box, lines: readonly Pick<TextLineData, 'x' | 'y' | 'width' | 'height' | 'direction'>[]): CellPlace {
  if (lines.length === 0) return { align: 'start', valign: 'center', inset: 0 };
  const x0 = Math.min(...lines.map((l) => l.x));
  const x1 = Math.max(...lines.map((l) => l.x + l.width));
  const y0 = Math.min(...lines.map((l) => l.y));
  const y1 = Math.max(...lines.map((l) => l.y + l.height));
  const side = (before: number, after: number, room: number) =>
    Math.abs(before - after) <= Math.max(2, room * 0.15) ? 'center' : before < after ? 'before' : 'after';
  const across = side(x0 - box.x, box.x + box.width - x1, box.width - (x1 - x0));
  const down = side(y0 - box.y, box.y + box.height - y1, box.height - (y1 - y0));
  const rtl = lines[0]!.direction === 'rtl';
  return {
    align: across === 'center' ? 'center' : (across === 'before') !== rtl ? 'start' : 'end',
    valign: down === 'center' ? 'center' : down === 'before' ? 'top' : 'bottom',
    inset: across === 'center' ? 0 : Math.max(0, across === 'before' ? x0 - box.x : box.x + box.width - x1),
  };
}

/** The lines whose middles are inside `box`. */
export function linesIn<L extends Pick<TextLineData, 'x' | 'y' | 'width' | 'height'>>(lines: readonly L[], box: Box): L[] {
  return lines.filter((line) => inside(line, box));
}

/** A table set where it was on its page (Word with the layout kept): how its cells look. */
export interface LayoutTable extends ExportTable {
  /** Points: the type size of its cells. */
  size: number;
  font?: ExportFont;
  /** For each cell of `rows`: its text's colour (`rrggbb`) and place. */
  looks: ({ color: string; place: CellPlace; hidden?: boolean } | null)[][];
  /** Points between a cell's side and its text, the same each side: the usual inset of its cells. */
  margin: number;
}
