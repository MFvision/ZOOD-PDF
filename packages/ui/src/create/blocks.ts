/**
 * What the core's `create.document` typesets (`warraq-pdf/src/create.rs`):
 * the content of a Word file, a spreadsheet, a presentation, a web page,
 * Markdown or text, read by this folder's readers into blocks.
 */

export type BlockAlign = 'start' | 'center' | 'end' | 'justify';
/** `auto`: from the text's first strong letter, or the document's direction for none. */
export type BlockDir = 'auto' | 'rtl' | 'ltr';

/** A stretch of a paragraph set differently from the rest of it. */
export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** `#rrggbb`. */
  color?: string;
  /** Web or mail addresses only; the core drops any other. */
  link?: string;
}

export interface TextBlock {
  type: 'text';
  /** `\n` breaks a line inside the paragraph. Ignored when there are `runs`. */
  text: string;
  runs?: TextRun[];
  /** Points; 11 when absent. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  /** `#rrggbb`. */
  color?: string;
  align?: BlockAlign;
  dir?: BlockDir;
  spaceBefore?: number;
  spaceAfter?: number;
  /** From the side the text starts on, in points. */
  indent?: number;
  /** A list's bullet or number. */
  marker?: string;
  keepWithNext?: boolean;
  /** Times the face's own line height. */
  spacing?: number;
  /** `#rrggbb` behind the lines. */
  shade?: string;
  /** Spaces and line breaks exactly as written. */
  preserve?: boolean;
  /** The family the source sets it in ("Arial"), for its face to be found. */
  font?: string;
  /** Into the document's faces: set by `createPdf` from `font`. */
  face?: number;
}

export interface TableCell {
  text: string;
  bold?: boolean;
  align?: BlockAlign;
  dir?: BlockDir;
  span?: number;
  /** `#rrggbb` behind the cell. */
  fill?: string;
  /** `#rrggbb` of its text. */
  color?: string;
  font?: string;
  face?: number;
}

export interface TableBlock {
  type: 'table';
  /** Relative widths of the columns. */
  widths?: number[];
  rows: TableCell[][];
  headerRows?: number;
  dir?: BlockDir;
  size?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  font?: string;
  face?: number;
}

export interface ImageBlock {
  type: 'image';
  /** Into the document's `pictures`. */
  index: number;
  /** Points, when the source says how large. */
  width?: number;
  height?: number;
  align?: BlockAlign;
  dir?: BlockDir;
  spaceBefore?: number;
  spaceAfter?: number;
}

/** A box placed on the page (a slide's text box, shape or picture), from its top-left corner. */
export interface FrameBlock {
  type: 'frame';
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  line?: { color: string; width: number };
  /** Left, top, right, bottom. */
  inset?: [number, number, number, number];
  anchor?: 'top' | 'middle' | 'bottom';
  /** Text, tables, pictures and rules only. */
  blocks: Block[];
}

/** A page of its own size from here on (a slide, a landscape section). */
export interface PageBlock {
  type: 'page';
  width: number;
  height: number;
  /** Top, right, bottom, left. */
  margins?: [number, number, number, number];
  header?: number;
  footer?: number;
  background?: string;
}

export type Block = TextBlock | TableBlock | ImageBlock | FrameBlock | PageBlock | { type: 'pageBreak' } | { type: 'rule' };

/** In a header or footer's text: the page's number, and the number of pages. */
export const PAGE_NUMBER = '\uE000';
export const PAGE_COUNT = '\uE001';

/** A picture a document carries, before it goes to the core. */
export interface SourcePicture {
  bytes: Uint8Array;
  /** From its name or content: `image/png`, `image/gif`… */
  mime: string;
}

/** A page's size and margins in points, when the source says (a Word section). */
export interface SourcePage {
  width: number;
  height: number;
  /** Top, right, bottom, left. */
  margins: [number, number, number, number];
  /** From the top edge to the header, and from the bottom edge to the footer. */
  header?: number;
  footer?: number;
}

/** A document read into blocks. */
export interface ReadDocument {
  blocks: Block[];
  header?: Block[];
  footer?: Block[];
  pictures: SourcePicture[];
  title?: string;
  page?: SourcePage;
  /** Pictures the source refers to and does not carry, or in a form no browser draws (EMF, WMF). */
  picturesLeftOut: number;
  /** Parts of the source left out because they were too large (a sheet's far rows). */
  truncated: boolean;
}

/** The text of a text block, runs or not. */
export function blockText(block: TextBlock): string {
  return block.runs ? block.runs.map((run) => run.text).join('') : block.text;
}

/** The direction most of the blocks' letters run in. */
export function dominantDirection(blocks: readonly Block[]): 'rtl' | 'ltr' {
  let rtl = 0;
  let ltr = 0;
  const count = (text: string, dir: BlockDir | undefined) => {
    const arabic = (text.match(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g) ?? []).length;
    const latin = (text.match(/[A-Za-z\u00C0-\u024F]/g) ?? []).length;
    if (dir === 'rtl') rtl += arabic + latin;
    else if (dir === 'ltr') ltr += arabic + latin;
    else {
      rtl += arabic;
      ltr += latin;
    }
  };
  const visit = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.type === 'text') count(blockText(block), block.dir);
      if (block.type === 'table') for (const cell of block.rows.flat()) count(cell.text, cell.dir ?? block.dir);
      if (block.type === 'frame') visit(block.blocks);
    }
  };
  visit(blocks);
  return rtl > ltr ? 'rtl' : 'ltr';
}

/** Runs next to each other set the same way, made one; empty ones dropped. */
export function mergeRuns(runs: readonly TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  const same = (a: TextRun, b: TextRun) =>
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    a.color === b.color &&
    a.link === b.link;
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && same(last, run)) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

/**
 * A text block of `runs`: plain `text` when they are all set alike, so the
 * core has less to carry; `runs` otherwise.
 */
export function withRuns(block: Omit<TextBlock, 'text' | 'runs'>, runs: readonly TextRun[]): TextBlock {
  const merged = mergeRuns(runs);
  const text = merged.map((run) => run.text).join('');
  const plain = merged.every((run) => !run.bold && !run.italic && !run.underline && !run.strike && !run.color && !run.link);
  return plain ? { ...block, text } : { ...block, text, runs: merged };
}
