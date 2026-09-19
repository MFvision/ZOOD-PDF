import { PAGE_COUNT, PAGE_NUMBER, withRuns } from './blocks';
import type { Block, BlockAlign, ImageBlock, ReadDocument, SourcePage, SourcePicture, TableBlock, TableCell, TextBlock, TextRun } from './blocks';
import { attr, childElements, descendants, firstChild, parseXml, textOf } from './xml';
import type { XmlElement } from './xml';
import { partText, pictureMime, readParts, relsPath, resolvePart } from './zip';

/**
 * A Word document (.docx) read into blocks for the core to typeset: its
 * paragraphs with their direction, alignment, size, spacing, indent and
 * shading; within them bold, italic, underline, strike-through, colour and
 * links; headings kept with what follows them; numbered and bulleted lists
 * with their markers counted as Word counts them; tables with their column
 * widths, merged cells, shading and repeated header rows; pictures (PNG,
 * JPEG, GIF, BMP, WebP, TIFF) at their size; page breaks and sections of
 * another page size; and the header and footer, with page numbers.
 *
 * Not read: text boxes and shapes, footnotes, comments, columns, a first
 * page's own header, and fonts — the text is set in one of Warraq's faces.
 * Tracked insertions are kept and deletions left out, as the document reads
 * now.
 */

/** Twentieths of a point, Word's unit of length, in points. */
const twips = (v: number) => v / 20;
const EMU = 1 / 12_700;

/** Paragraph and run properties, as far as the blocks carry them. */
interface Props {
  align?: BlockAlign;
  bidi?: boolean;
  before?: number;
  after?: number;
  spacing?: number;
  indent?: number;
  outline?: number;
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  numId?: string;
  ilvl?: number;
  shade?: string;
  size?: number;
  sizeCs?: number;
  bold?: boolean;
  boldCs?: boolean;
  italic?: boolean;
  italicCs?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  hidden?: boolean;
}

interface Style {
  name: string;
  basedOn?: string;
  props: Props;
}

interface Level {
  format: string;
  text: string;
  start: number;
  indent?: number;
}

type Rels = Map<string, { target: string; external: boolean }>;

interface Context {
  styles: Map<string, Style>;
  defaults: Props;
  defaultParagraph?: string;
  numbering: Map<string, { levels: Map<number, Level>; starts: Map<number, number> }>;
  counters: Map<string, number[]>;
  /** The part being read (the body, a header), and its relationships. */
  part: string;
  rels: Rels;
  parts: Record<string, Uint8Array>;
  pictures: SourcePicture[];
  pictureIndex: Map<string, number>;
  leftOut: number;
}

const on = (element: XmlElement | null): boolean | undefined => {
  if (!element) return undefined;
  const value = attr(element, 'val');
  return value === undefined || !['0', 'false', 'off', 'none'].includes(value);
};

const number = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/** A colour Word wrote as `rrggbb`; `auto` and nonsense are none. */
const hexColour = (value: string | undefined): string | undefined =>
  value && /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : undefined;

function jc(value: string | undefined): BlockAlign | undefined {
  switch (value) {
    // Word reads `w:jc` logically: in a right-to-left paragraph "left" is its start.
    case 'left':
    case 'start':
      return 'start';
    case 'right':
    case 'end':
      return 'end';
    case 'center':
      return 'center';
    case 'both':
    case 'distribute':
    case 'thaiDistribute':
    case 'lowKashida':
    case 'mediumKashida':
    case 'highKashida':
      return 'justify';
    default:
      return undefined;
  }
}

function paragraphProps(pPr: XmlElement | null): Props {
  const props: Props = {};
  if (!pPr) return props;
  props.align = jc(attr(firstChild(pPr, 'jc'), 'val'));
  props.bidi = on(firstChild(pPr, 'bidi'));
  const spacing = firstChild(pPr, 'spacing');
  if (spacing) {
    const before = number(attr(spacing, 'before'));
    const after = number(attr(spacing, 'after'));
    if (before !== undefined) props.before = twips(before);
    if (after !== undefined) props.after = twips(after);
    const line = number(attr(spacing, 'line'));
    const rule = attr(spacing, 'lineRule') ?? 'auto';
    if (line !== undefined && rule === 'auto') props.spacing = line / 240;
  }
  const ind = firstChild(pPr, 'ind');
  if (ind) {
    // `left` is the start of the paragraph in either direction (ECMA-376 §17.3.1.12).
    const start = number(attr(ind, 'start') ?? attr(ind, 'left'));
    if (start !== undefined) props.indent = twips(start);
  }
  const outline = number(attr(firstChild(pPr, 'outlineLvl'), 'val'));
  if (outline !== undefined && outline < 9) props.outline = outline;
  props.keepNext = on(firstChild(pPr, 'keepNext'));
  props.pageBreakBefore = on(firstChild(pPr, 'pageBreakBefore'));
  props.shade = hexColour(attr(firstChild(pPr, 'shd'), 'fill'));
  const numPr = firstChild(pPr, 'numPr');
  if (numPr) {
    props.numId = attr(firstChild(numPr, 'numId'), 'val');
    props.ilvl = number(attr(firstChild(numPr, 'ilvl'), 'val')) ?? 0;
  }
  return props;
}

function runProps(rPr: XmlElement | null): Props {
  const props: Props = {};
  if (!rPr) return props;
  const sz = number(attr(firstChild(rPr, 'sz'), 'val'));
  const szCs = number(attr(firstChild(rPr, 'szCs'), 'val'));
  if (sz !== undefined) props.size = sz / 2;
  if (szCs !== undefined) props.sizeCs = szCs / 2;
  props.bold = on(firstChild(rPr, 'b'));
  props.boldCs = on(firstChild(rPr, 'bCs'));
  props.italic = on(firstChild(rPr, 'i'));
  props.italicCs = on(firstChild(rPr, 'iCs'));
  const u = firstChild(rPr, 'u');
  if (u) props.underline = attr(u, 'val') !== 'none';
  const strike = on(firstChild(rPr, 'strike')) ?? on(firstChild(rPr, 'dstrike'));
  if (strike !== undefined) props.strike = strike;
  props.color = hexColour(attr(firstChild(rPr, 'color'), 'val'));
  props.hidden = on(firstChild(rPr, 'vanish'));
  return props;
}

/** `b` over `a`: what `b` says, and what it leaves unsaid from `a`. */
function merge(a: Props, b: Props): Props {
  const out: Props = { ...a };
  for (const [key, value] of Object.entries(b) as [keyof Props, Props[keyof Props]][]) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function readStyles(xml: string | null): Pick<Context, 'styles' | 'defaults' | 'defaultParagraph'> {
  const styles = new Map<string, Style>();
  const root = xml ? parseXml(xml) : null;
  let defaults: Props = {};
  const docDefaults = firstChild(root, 'docDefaults');
  if (docDefaults) {
    defaults = merge(
      runProps(firstChild(firstChild(docDefaults, 'rPrDefault'), 'rPr')),
      paragraphProps(firstChild(firstChild(docDefaults, 'pPrDefault'), 'pPr')),
    );
  }
  let defaultParagraph: string | undefined;
  for (const style of childElements(root, 'style')) {
    const id = attr(style, 'styleId');
    if (!id) continue;
    const type = attr(style, 'type') ?? 'paragraph';
    if (type === 'paragraph' && ['1', 'true', 'on'].includes(attr(style, 'default') ?? '')) defaultParagraph = id;
    styles.set(id, {
      name: (attr(firstChild(style, 'name'), 'val') ?? id).toLowerCase(),
      basedOn: attr(firstChild(style, 'basedOn'), 'val'),
      props: merge(paragraphProps(firstChild(style, 'pPr')), runProps(firstChild(style, 'rPr'))),
    });
  }
  return { styles, defaults, defaultParagraph };
}

/** A style's properties with everything it is based on, oldest first. */
function styleProps(context: Context, id: string | undefined, paragraph = true): { props: Props; name: string } {
  const chain: Style[] = [];
  let next = id ?? (paragraph ? context.defaultParagraph : undefined);
  const seen = new Set<string>();
  while (next && !seen.has(next) && chain.length < 32) {
    seen.add(next);
    const style = context.styles.get(next);
    if (!style) break;
    chain.unshift(style);
    next = style.basedOn;
  }
  return {
    props: chain.reduce((acc, style) => merge(acc, style.props), {} as Props),
    name: chain[chain.length - 1]?.name ?? '',
  };
}

function readNumbering(xml: string | null): Context['numbering'] {
  const out: Context['numbering'] = new Map();
  const root = xml ? parseXml(xml) : null;
  const abstract = new Map<string, Map<number, Level>>();
  for (const a of childElements(root, 'abstractNum')) {
    const levels = new Map<number, Level>();
    for (const lvl of childElements(a, 'lvl')) {
      const ilvl = number(attr(lvl, 'ilvl')) ?? 0;
      levels.set(ilvl, {
        format: attr(firstChild(lvl, 'numFmt'), 'val') ?? 'decimal',
        text: attr(firstChild(lvl, 'lvlText'), 'val') ?? '',
        start: number(attr(firstChild(lvl, 'start'), 'val')) ?? 1,
        indent: paragraphProps(firstChild(lvl, 'pPr')).indent,
      });
    }
    const id = attr(a, 'abstractNumId');
    if (id !== undefined) abstract.set(id, levels);
  }
  for (const num of childElements(root, 'num')) {
    const id = attr(num, 'numId');
    const levels = abstract.get(attr(firstChild(num, 'abstractNumId'), 'val') ?? '');
    if (id === undefined || !levels) continue;
    const starts = new Map<number, number>();
    for (const override of childElements(num, 'lvlOverride')) {
      const start = number(attr(firstChild(override, 'startOverride'), 'val'));
      if (start !== undefined) starts.set(number(attr(override, 'ilvl')) ?? 0, start);
    }
    out.set(id, { levels, starts });
  }
  return out;
}

const ARABIC_ALPHA = 'أبتثجحخدذرزسشصضطظعغفقكلمنهوي';
const ARABIC_ABJAD = 'أبجدهوزحطيكلمنسعفصقرشتثخذضظغ';

function roman(n: number): string {
  const table: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  let rest = Math.max(1, Math.min(3999, n));
  for (const [value, letters] of table) {
    while (rest >= value) {
      out += letters;
      rest -= value;
    }
  }
  return out;
}

function letters(n: number, alphabet: string): string {
  const chars = [...alphabet];
  const k = Math.max(1, n) - 1;
  // Word repeats the letter past the end: a…z, aa…zz.
  return chars[k % chars.length]!.repeat(Math.floor(k / chars.length) + 1);
}

/** Counter `n` written in a list format of Word's. */
export function formatNumber(n: number, format: string): string {
  switch (format) {
    case 'bullet':
      return '•';
    case 'none':
      return '';
    case 'decimalZero':
      return n < 10 ? `0${n}` : String(n);
    case 'lowerLetter':
      return letters(n, 'abcdefghijklmnopqrstuvwxyz');
    case 'upperLetter':
      return letters(n, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    case 'lowerRoman':
      return roman(n);
    case 'upperRoman':
      return roman(n).toUpperCase();
    case 'arabicAlpha':
      return letters(n, ARABIC_ALPHA);
    case 'arabicAbjad':
      return letters(n, ARABIC_ABJAD);
    case 'hindiNumbers':
    case 'arabicIndic':
      return String(n).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    default:
      return String(n);
  }
}

/** The marker of the next item of list `numId` at level `ilvl`, counted as Word counts. */
function marker(context: Context, numId: string, ilvl: number): { text: string; indent?: number } | null {
  const list = context.numbering.get(numId);
  const level = list?.levels.get(ilvl);
  if (!list || !level) return null;
  const counters = context.counters.get(numId) ?? [];
  const startOf = (k: number) => list.starts.get(k) ?? list.levels.get(k)?.start ?? 1;
  counters[ilvl] = counters[ilvl] === undefined ? startOf(ilvl) : counters[ilvl]! + 1;
  // Deeper levels start again.
  counters.length = ilvl + 1;
  context.counters.set(numId, counters);
  if (level.format === 'bullet') return { text: ['•', '◦', '▪'][ilvl % 3]!, indent: level.indent };
  if (level.format === 'none') return null;
  const text = level.text.replace(/%(\d)/g, (_, d: string) => {
    const k = Number(d) - 1;
    const format = list.levels.get(k)?.format ?? 'decimal';
    return formatNumber(counters[k] ?? startOf(k), format);
  });
  return text.trim() ? { text: text.trim(), indent: level.indent } : null;
}

const ARABIC_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/** A run as read, with the size it was set at. */
interface Run extends TextRun {
  size?: number;
}

/** A paragraph's runs, in order; its pictures; and whether a page break comes after it. */
interface ReadParagraph {
  runs: Run[];
  pictures: number[];
  pictureSizes: { width?: number; height?: number }[];
  pageBreak: boolean;
}

function pictureOf(context: Context, id: string | undefined): number | null {
  if (!id) return null;
  const rel = context.rels.get(id);
  if (!rel || rel.external) {
    context.leftOut += 1;
    return null;
  }
  const path = resolvePart(context.part, rel.target);
  const known = context.pictureIndex.get(path);
  if (known !== undefined) return known;
  const bytes = context.parts[path];
  const mime = pictureMime(path);
  if (!bytes || mime === 'image/emf' || mime === 'image/wmf' || mime === 'image/svg+xml' || mime === 'application/octet-stream') {
    context.leftOut += 1;
    return null;
  }
  context.pictures.push({ bytes, mime });
  context.pictureIndex.set(path, context.pictures.length - 1);
  return context.pictures.length - 1;
}

const R_NS = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];

function relId(element: XmlElement | null, local: string): string | undefined {
  for (const ns of R_NS) {
    const value = attr(element, local, ns);
    if (value !== undefined) return value;
  }
  return attr(element, local);
}

/** What a field shows in place of its instruction, when Warraq can say. */
function fieldText(instruction: string): string | null {
  const word = instruction.trim().split(/\s+/)[0]?.toUpperCase();
  if (word === 'PAGE') return PAGE_NUMBER;
  if (word === 'NUMPAGES' || word === 'SECTIONPAGES') return PAGE_COUNT;
  return null;
}

/** A field being read: its instruction so far, and whether its result is being shown. */
interface Field {
  instruction: string;
  result: boolean;
  /** Its result is Warraq's own (a page number), not the one saved in the file. */
  replaced: boolean;
}

function readRuns(p: XmlElement, base: Props, context: Context): ReadParagraph {
  const out: ReadParagraph = { runs: [], pictures: [], pictureSizes: [], pageBreak: false };
  const fields: Field[] = [];
  const showing = () => fields.every((f) => f.result && !f.replaced);
  const push = (text: string, props: Props, link: string | undefined) => {
    const complex = ARABIC_LETTER.test(text);
    const run: Run = { text, size: complex ? (props.sizeCs ?? props.size) : props.size };
    if (complex ? (props.boldCs ?? props.bold) : props.bold) run.bold = true;
    if (complex ? (props.italicCs ?? props.italic) : props.italic) run.italic = true;
    if (props.underline) run.underline = true;
    if (props.strike) run.strike = true;
    if (props.color) run.color = props.color;
    if (link) run.link = link;
    out.runs.push(run);
  };
  // Depth-first through the inline containers, in order, without recursion;
  // each with the link it is inside.
  const todo: [XmlElement, string | undefined][] = childElements(p)
    .reverse()
    .map((node) => [node, undefined]);
  const enter = (node: XmlElement, link: string | undefined) => {
    for (const child of childElements(node).reverse()) todo.push([child, link]);
  };
  while (todo.length > 0) {
    const [node, link] = todo.pop()!;
    switch (node.local) {
      case 'r': {
        const character = styleProps(context, attr(firstChild(firstChild(node, 'rPr'), 'rStyle'), 'val'), false);
        const props = merge(merge(base, character.props), runProps(firstChild(node, 'rPr')));
        let text = '';
        const flush = () => {
          if (text.length > 0 && !props.hidden && showing()) push(text, props, link);
          text = '';
        };
        for (const child of childElements(node)) {
          switch (child.local) {
            case 'fldChar': {
              flush();
              const kind = attr(child, 'fldCharType');
              if (kind === 'begin') fields.push({ instruction: '', result: false, replaced: false });
              else if (kind === 'separate' || kind === 'end') {
                const field = fields[fields.length - 1];
                if (field && !field.result) {
                  field.result = true;
                  const own = fieldText(field.instruction);
                  if (own !== null) {
                    field.replaced = true;
                    if (fields.slice(0, -1).every((f) => f.result && !f.replaced)) push(own, props, link);
                  }
                }
                if (kind === 'end') fields.pop();
              }
              break;
            }
            case 'instrText': {
              const field = fields[fields.length - 1];
              if (field && !field.result) field.instruction += textOf(child);
              break;
            }
            case 't':
              text += textOf(child);
              break;
            case 'tab':
            case 'ptab':
              text += ' ';
              break;
            case 'br':
              if (attr(child, 'type') === 'page') out.pageBreak = true;
              else text += '\n';
              break;
            case 'cr':
              text += '\n';
              break;
            case 'noBreakHyphen':
              text += '‑';
              break;
            case 'drawing':
            case 'pict':
            case 'object':
            case 'AlternateContent': {
              // A picture: DrawingML's blip, or VML's imagedata; one choice only.
              const scope = child.local === 'AlternateContent' ? (firstChild(child, 'Choice') ?? firstChild(child, 'Fallback')) : child;
              const blip = descendants(scope, 'blip')[0] ?? null;
              const image = blip ? relId(blip, 'embed') : relId(descendants(scope, 'imagedata')[0] ?? null, 'id');
              if (!blip && !image) break;
              const index = pictureOf(context, image);
              if (index === null) break;
              const extent = descendants(scope, 'extent')[0] ?? null;
              const cx = number(attr(extent, 'cx'));
              const cy = number(attr(extent, 'cy'));
              out.pictures.push(index);
              out.pictureSizes.push({ width: cx !== undefined ? cx * EMU : undefined, height: cy !== undefined ? cy * EMU : undefined });
              break;
            }
            default:
              break;
          }
        }
        flush();
        break;
      }
      case 'fldSimple': {
        const own = fieldText(attr(node, 'instr') ?? '');
        if (own !== null) {
          const character = firstChild(firstChild(node, 'r'), 'rPr');
          if (showing()) push(own, merge(base, runProps(character)), link);
        } else enter(node, link);
        break;
      }
      case 'hyperlink': {
        const rel = context.rels.get(relId(node, 'id') ?? '');
        enter(node, rel?.external ? rel.target : link);
        break;
      }
      case 'ins':
      case 'moveTo':
      case 'smartTag':
      case 'customXml':
      case 'bdo':
      case 'dir':
      case 'sdtContent':
        enter(node, link);
        break;
      case 'sdt':
        enter(firstChild(node, 'sdtContent') ?? node, link);
        break;
      default:
        break;
    }
  }
  return out;
}

const HEADING_SIZES = [20, 16, 14, 13, 12, 11, 11, 11, 11];

/** One paragraph: a text block, its pictures after it, and a page break if it has one. */
function paragraph(p: XmlElement, context: Context): Block[] {
  const pPr = firstChild(p, 'pPr');
  const style = styleProps(context, attr(firstChild(pPr, 'pStyle'), 'val'));
  const props = merge(merge(context.defaults, style.props), paragraphProps(pPr));
  const heading = /^heading (\d)$/.exec(style.name);
  const level = heading ? Number(heading[1]) - 1 : style.name === 'title' ? 0 : props.outline;
  // A heading whose style gives no weight is bold, as Word's own headings are.
  const base = level !== undefined && props.bold === undefined ? { ...props, bold: true, boldCs: true } : props;
  const read = readRuns(p, base, context);
  const blocks: Block[] = [];
  if (props.pageBreakBefore) blocks.push({ type: 'pageBreak' });
  const text = read.runs.map((r) => r.text).join('');
  // The paragraph takes the size most of its letters have.
  const weight = (r: Run) => r.text.replace(/\s/g, '').length;
  const sizes = new Map<number, number>();
  for (const r of read.runs) if (r.size !== undefined) sizes.set(r.size, (sizes.get(r.size) ?? 0) + weight(r));
  const size = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (level !== undefined ? HEADING_SIZES[level] : undefined);
  let listMarker: { text: string; indent?: number } | null = null;
  if (props.numId && props.numId !== '0') listMarker = marker(context, props.numId, props.ilvl ?? 0);
  const shape: Omit<TextBlock, 'text' | 'runs'> = {
    type: 'text',
    align: props.align ?? 'start',
    size: size ?? 11,
    spaceBefore: props.before ?? (level !== undefined ? 12 : 0),
    spaceAfter: props.after ?? (level !== undefined ? 6 : 0),
    keepWithNext: Boolean(props.keepNext) || level !== undefined,
  };
  if (props.bidi) shape.dir = 'rtl';
  if (props.spacing !== undefined && props.spacing > 0) shape.spacing = props.spacing;
  if (props.shade && props.shade !== '#ffffff') shape.shade = props.shade;
  const indent = props.indent ?? listMarker?.indent;
  if (indent !== undefined && indent > 0) shape.indent = indent;
  if (listMarker) {
    shape.marker = listMarker.text;
    shape.indent = Math.max(shape.indent ?? 0, (shape.size ?? 11) * 1.8);
  }
  if (text.length > 0 || read.pictures.length === 0) {
    blocks.push(withRuns(shape, read.runs.map(({ size: _size, ...run }) => run)));
  }
  read.pictures.forEach((index, k) => {
    const image: ImageBlock = { type: 'image', index, align: props.align === 'justify' ? 'center' : (props.align ?? 'center') };
    const { width, height } = read.pictureSizes[k] ?? {};
    if (width) image.width = width;
    if (height) image.height = height;
    if (props.bidi) image.dir = 'rtl';
    blocks.push(image);
  });
  if (read.pageBreak) blocks.push({ type: 'pageBreak' });
  return blocks;
}

function cellText(tc: XmlElement, context: Context): { cell: TableCell; size?: number } {
  const paragraphs = descendants(tc, 'p');
  const pieces: string[] = [];
  let bold = 0;
  let letterCount = 0;
  let align: BlockAlign | undefined;
  let rtl: boolean | undefined;
  let size: number | undefined;
  for (const p of paragraphs) {
    const pPr = firstChild(p, 'pPr');
    const style = styleProps(context, attr(firstChild(pPr, 'pStyle'), 'val'));
    const props = merge(merge(context.defaults, style.props), paragraphProps(pPr));
    const read = readRuns(p, props, context);
    pieces.push(read.runs.map((r) => r.text).join(''));
    for (const r of read.runs) {
      const n = r.text.replace(/\s/g, '').length;
      letterCount += n;
      if (r.bold) bold += n;
      size ??= r.size;
    }
    align ??= props.align;
    rtl ??= props.bidi;
  }
  const cell: TableCell = { text: pieces.join('\n').replace(/\n+$/, '') };
  if (letterCount > 0 && bold * 2 > letterCount) cell.bold = true;
  if (align) cell.align = align;
  if (rtl) cell.dir = 'rtl';
  const fill = hexColour(attr(firstChild(firstChild(tc, 'tcPr'), 'shd'), 'fill'));
  if (fill && fill !== '#ffffff') cell.fill = fill;
  return { cell, size };
}

function table(tbl: XmlElement, context: Context): TableBlock {
  const widths = childElements(firstChild(tbl, 'tblGrid'), 'gridCol').map((col) => number(attr(col, 'w')) ?? 0);
  const rows: TableCell[][] = [];
  const sizes: number[] = [];
  let headerRows = 0;
  let stillHeader = true;
  for (const tr of childElements(tbl, 'tr')) {
    const isHeader = on(firstChild(firstChild(tr, 'trPr'), 'tblHeader')) === true;
    if (stillHeader && isHeader) headerRows += 1;
    else stillHeader = false;
    const row: TableCell[] = [];
    for (const tc of childElements(tr, 'tc')) {
      const tcPr = firstChild(tc, 'tcPr');
      const span = number(attr(firstChild(tcPr, 'gridSpan'), 'val')) ?? 1;
      const merged = firstChild(tcPr, 'vMerge');
      // A cell that continues one above it keeps its place, empty.
      const continues = merged !== null && attr(merged, 'val') !== 'restart';
      const { cell, size } = continues ? { cell: { text: '' } as TableCell, size: undefined } : cellText(tc, context);
      if (span > 1) cell.span = span;
      if (size !== undefined) sizes.push(size);
      row.push(cell);
    }
    rows.push(row);
  }
  const block: TableBlock = { type: 'table', rows };
  if (widths.some((w) => w > 0)) block.widths = widths;
  if (headerRows > 0) block.headerRows = headerRows;
  if (on(firstChild(firstChild(tbl, 'tblPr'), 'bidiVisual'))) block.dir = 'rtl';
  const size = sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)];
  if (size !== undefined) block.size = size;
  return block;
}

/** A body's blocks, in sections: each ends with the `sectPr` that describes it. */
function body(element: XmlElement | null, context: Context): { blocks: Block[]; section: XmlElement | null }[] {
  const sections: { blocks: Block[]; section: XmlElement | null }[] = [{ blocks: [], section: null }];
  const todo: XmlElement[] = [...childElements(element)].reverse();
  while (todo.length > 0) {
    const node = todo.pop()!;
    const current = sections[sections.length - 1]!;
    if (node.local === 'p') {
      current.blocks.push(...paragraph(node, context));
      const section = firstChild(firstChild(node, 'pPr'), 'sectPr');
      if (section) {
        current.section = section;
        sections.push({ blocks: [], section: null });
      }
    } else if (node.local === 'tbl') current.blocks.push(table(node, context));
    else if (node.local === 'sectPr') current.section = node;
    else if (node.local === 'sdt') todo.push(...[...childElements(firstChild(node, 'sdtContent'))].reverse());
    else if (node.local === 'customXml' || node.local === 'ins') todo.push(...[...childElements(node)].reverse());
  }
  return sections;
}

function sectionPage(section: XmlElement | null): SourcePage | undefined {
  const size = firstChild(section, 'pgSz');
  const w = number(attr(size, 'w'));
  const h = number(attr(size, 'h'));
  if (!w || !h) return undefined;
  const margin = firstChild(section, 'pgMar');
  const side = (name: string, fallback: number) => twips(Math.abs(number(attr(margin, name)) ?? fallback));
  return {
    width: twips(w),
    height: twips(h),
    margins: [side('top', 1440), side('right', 1440), side('bottom', 1440), side('left', 1440)],
    header: side('header', 720),
    footer: side('footer', 720),
  };
}

const samePage = (a: SourcePage | undefined, b: SourcePage | undefined) =>
  !a || !b || (Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1 && a.margins.every((m, k) => Math.abs(m - b.margins[k]!) < 1));

/** Blocks read from another part of the package — a header or a footer. */
function partBlocks(part: string, context: Context): Block[] {
  const root = parseXml(partText(context.parts, part) ?? '');
  if (!root) return [];
  const rels: Rels = new Map();
  for (const rel of childElements(parseXml(partText(context.parts, relsPath(part)) ?? ''), 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id && target) rels.set(id, { target, external: attr(rel, 'TargetMode') === 'External' });
  }
  const own = { ...context, part, rels };
  const blocks = body(root, own).flatMap((s) => s.blocks);
  context.leftOut = own.leftOut;
  // Headers are furniture: no page breaks, no space kept after the last line.
  return blocks.filter((b) => b.type !== 'pageBreak' && b.type !== 'page');
}

/** The part a section's default header or footer is in. */
function furniturePart(section: XmlElement | null, kind: 'header' | 'footer', context: Context): string | null {
  const reference = childElements(section, `${kind}Reference`).find((r) => (attr(r, 'type') ?? 'default') === 'default');
  const rel = reference ? context.rels.get(relId(reference, 'id') ?? '') : undefined;
  return rel && !rel.external ? resolvePart('word/document.xml', rel.target) : null;
}

/** Whether `bytes` is a Word document: a zip with `word/document.xml`. */
export function isDocx(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  try {
    return 'word/document.xml' in readParts(bytes, (name) => name === 'word/document.xml');
  } catch {
    return false;
  }
}

export function readDocx(bytes: Uint8Array): ReadDocument {
  const parts = readParts(
    bytes,
    (name) =>
      name === 'word/document.xml' ||
      name === 'word/styles.xml' ||
      name === 'word/numbering.xml' ||
      /^word\/(header|footer)\d*\.xml$/.test(name) ||
      /^word\/_rels\/[^/]+\.rels$/.test(name) ||
      name === 'docProps/core.xml' ||
      name.startsWith('word/media/'),
  );
  const documentXml = partText(parts, 'word/document.xml');
  const root = documentXml ? parseXml(documentXml) : null;
  if (!root || root.local !== 'document') throw new Error('E_CREATE: not a Word document');
  const rels: Rels = new Map();
  const relsRoot = parseXml(partText(parts, relsPath('word/document.xml')) ?? '');
  for (const rel of childElements(relsRoot, 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id && target) rels.set(id, { target, external: attr(rel, 'TargetMode') === 'External' });
  }
  const context: Context = {
    ...readStyles(partText(parts, 'word/styles.xml')),
    numbering: readNumbering(partText(parts, 'word/numbering.xml')),
    counters: new Map(),
    part: 'word/document.xml',
    rels,
    parts,
    pictures: [],
    pictureIndex: new Map(),
    leftOut: 0,
  };
  const sections = body(firstChild(root, 'body'), context).filter((s, k, all) => s.blocks.length > 0 || k === all.length - 1);
  const pages = sections.map((s) => sectionPage(s.section));
  const first = pages.find((p) => p !== undefined);
  const blocks: Block[] = [];
  sections.forEach((s, k) => {
    if (k > 0) {
      const page = pages[k];
      if (page && !samePage(page, pages[k - 1] ?? first)) {
        blocks.push({ type: 'page', width: page.width, height: page.height, margins: page.margins, header: page.header, footer: page.footer });
      } else if (attr(firstChild(s.section, 'type'), 'val') !== 'continuous') blocks.push({ type: 'pageBreak' });
    }
    blocks.push(...s.blocks);
  });
  while (blocks.length > 0 && blocks[blocks.length - 1]!.type === 'pageBreak') blocks.pop();
  // The header and footer of the first section that has them.
  const find = (kind: 'header' | 'footer') => {
    for (const s of sections) {
      const part = furniturePart(s.section, kind, context);
      if (part) return partBlocks(part, context);
    }
    return [];
  };
  const header = find('header');
  const footer = find('footer');
  const core = parseXml(partText(parts, 'docProps/core.xml') ?? '');
  const title = textOf(firstChild(core, 'title')).trim();
  return {
    blocks,
    header: header.length > 0 ? header : undefined,
    footer: footer.length > 0 ? footer : undefined,
    pictures: context.pictures,
    title: title || undefined,
    page: first,
    picturesLeftOut: context.leftOut,
    truncated: false,
  };
}
