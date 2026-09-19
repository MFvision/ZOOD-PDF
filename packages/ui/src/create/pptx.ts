import { mergeRuns } from './blocks';
import type { Block, BlockAlign, FrameBlock, ReadDocument, SourcePicture, TableCell, TextBlock, TextRun } from './blocks';
import { attr, childElements, firstChild, parseXml, textOf } from './xml';
import type { XmlElement } from './xml';
import { partText, pictureMime, readParts, relsPath, resolvePart } from './zip';

/**
 * A PowerPoint presentation (.pptx) read into blocks: each slide a page of
 * the slide's size with its background colour, and on it, where they were,
 * its text boxes (paragraphs, bullets and numbering, alignment, direction,
 * size, weight, slant, underline, colour, links), filled and outlined
 * shapes, pictures and tables. A placeholder takes its place and its text's
 * size and bullets from the slide's layout and master, and theme colours
 * are resolved.
 *
 * Not read: charts, SmartArt, video and sound, gradients and pictures as
 * fills, shapes other than boxes (drawn as their box), rotation, text that
 * shrinks to fit beyond the scale PowerPoint saved, animations and notes.
 */

const EMU = 1 / 12_700;
/** PowerPoint's own room around the text of a box: 0.1" at the sides, 0.05" above and below. */
const INSET = [91_440, 45_720, 91_440, 45_720] as const;
const MAX_SLIDES = 1_000;
const MAX_DEPTH = 8;

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

type Rels = Map<string, { target: string; external: boolean }>;

function relsOf(parts: Record<string, Uint8Array>, part: string): Rels {
  const out: Rels = new Map();
  for (const rel of childElements(parseXml(partText(parts, relsPath(part)) ?? ''), 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (!id || !target) continue;
    const external = attr(rel, 'TargetMode') === 'External';
    out.set(id, { target: external ? target : resolvePart(part, target), external });
  }
  return out;
}

/** The part `part` refers to with a relationship of `type` (its layout, its master, its theme). */
function relOfType(parts: Record<string, Uint8Array>, part: string, type: string): string | null {
  for (const rel of childElements(parseXml(partText(parts, relsPath(part)) ?? ''), 'Relationship')) {
    if ((attr(rel, 'Type') ?? '').endsWith(`/${type}`)) {
      const target = attr(rel, 'Target');
      if (target) return resolvePart(part, target);
    }
  }
  return null;
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** RGB from `rrggbb`, and back. */
function rgb(hex: string): [number, number, number] {
  return [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16)) as [number, number, number];
}
function hex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

/** A colour's luminance changed as DrawingML's `lumMod` and `lumOff` say (per 100,000). */
function luminance(color: [number, number, number], mod: number, off: number): [number, number, number] {
  const [r, g, b] = color.map((v) => v / 255) as [number, number, number];
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
  }
  l = Math.min(1, Math.max(0, l * mod + off));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

interface Theme {
  colors: Map<string, string>;
}

function readTheme(xml: string | null): Theme {
  const colors = new Map<string, string>();
  const scheme = firstChild(firstChild(parseXml(xml ?? ''), 'themeElements'), 'clrScheme');
  for (const entry of childElements(scheme)) {
    const srgb = firstChild(entry, 'srgbClr');
    const sys = firstChild(entry, 'sysClr');
    const value = attr(srgb, 'val') ?? attr(sys, 'lastClr');
    if (value && /^[0-9a-f]{6}$/i.test(value)) colors.set(entry.local, value.toLowerCase());
  }
  return { colors };
}

/** The colour a fill or colour element says, as `#rrggbb`. */
function colourOf(element: XmlElement | null, theme: Theme): string | undefined {
  if (!element) return undefined;
  const choice = childElements(element).find((c) => ['srgbClr', 'schemeClr', 'sysClr', 'prstClr'].includes(c.local));
  if (!choice) return undefined;
  let value: string | undefined;
  if (choice.local === 'srgbClr') value = attr(choice, 'val');
  else if (choice.local === 'sysClr') value = attr(choice, 'lastClr');
  else if (choice.local === 'prstClr') value = { black: '000000', white: 'ffffff', red: 'ff0000', blue: '0000ff', green: '008000' }[attr(choice, 'val') ?? ''];
  else {
    const name = attr(choice, 'val') ?? '';
    const mapped = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[name] ?? name;
    value = theme.colors.get(mapped);
  }
  if (!value || !/^[0-9a-f]{6}$/i.test(value)) return undefined;
  let color = rgb(value.toLowerCase());
  const mod = num(attr(firstChild(choice, 'lumMod'), 'val'));
  const off = num(attr(firstChild(choice, 'lumOff'), 'val'));
  if (mod !== undefined || off !== undefined) color = luminance(color, (mod ?? 100_000) / 100_000, (off ?? 0) / 100_000);
  const shade = num(attr(firstChild(choice, 'shade'), 'val'));
  if (shade !== undefined) color = color.map((v) => v * (shade / 100_000)) as [number, number, number];
  const tint = num(attr(firstChild(choice, 'tint'), 'val'));
  if (tint !== undefined) color = color.map((v) => v + (255 - v) * (1 - tint / 100_000)) as [number, number, number];
  return hex(color);
}

/** The text style of a level of a list (`a:lvl1pPr` …) in a style list. */
interface LevelStyle {
  size?: number;
  bold?: boolean;
  color?: string;
  bullet?: string | null;
  rtl?: boolean;
  /** DrawingML's own `algn`, turned into start or end once the paragraph's direction is known. */
  algn?: string;
}

function levelStyles(list: XmlElement | null, theme: Theme): LevelStyle[] {
  const out: LevelStyle[] = [];
  for (let k = 1; k <= 9; k += 1) {
    const pPr = firstChild(list, `lvl${k}pPr`);
    if (!pPr) continue;
    const def = firstChild(pPr, 'defRPr');
    const style: LevelStyle = {};
    const size = num(attr(def, 'sz'));
    if (size !== undefined) style.size = size / 100;
    const b = attr(def, 'b');
    if (b !== undefined) style.bold = b === '1' || b === 'true';
    const color = colourOf(firstChild(def, 'solidFill'), theme);
    if (color) style.color = color;
    const algn = attr(pPr, 'algn');
    if (algn) style.algn = algn;
    if (firstChild(pPr, 'buNone')) style.bullet = null;
    const char = attr(firstChild(pPr, 'buChar'), 'char');
    if (char) style.bullet = char;
    if (firstChild(pPr, 'buAutoNum')) style.bullet = '#';
    const rtl = attr(pPr, 'rtl');
    if (rtl !== undefined) style.rtl = rtl === '1';
    out[k - 1] = style;
  }
  return out;
}

/**
 * DrawingML's alignment is on the page: left is left in an Arabic paragraph
 * too. As a block's, it is start or end by the paragraph's direction.
 */
function alignOf(value: string | undefined, rtl = false): BlockAlign | undefined {
  switch (value) {
    case 'l':
      return rtl ? 'end' : 'start';
    case 'ctr':
      return 'center';
    case 'r':
      return rtl ? 'start' : 'end';
    case 'just':
    case 'dist':
    case 'thaiDist':
    case 'justLow':
      return 'justify';
    default:
      return undefined;
  }
}

/** Where a shape is, in points from the slide's top-left corner. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxOf(spPr: XmlElement | null): Box | null {
  const xfrm = firstChild(spPr, 'xfrm');
  const off = firstChild(xfrm, 'off');
  const ext = firstChild(xfrm, 'ext');
  const [x, y, w, h] = [num(attr(off, 'x')), num(attr(off, 'y')), num(attr(ext, 'cx')), num(attr(ext, 'cy'))];
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  return { x: x * EMU, y: y * EMU, width: w * EMU, height: h * EMU };
}

/** A placeholder's kind and number, which the layout and master match it by. */
interface Placeholder {
  type: string;
  idx?: string;
}

function placeholderOf(shape: XmlElement): Placeholder | null {
  const nv = childElements(shape).find((c) => c.local.startsWith('nv'));
  const ph = firstChild(firstChild(nv ?? null, 'nvPr'), 'ph');
  if (!ph) return null;
  return { type: attr(ph, 'type') ?? 'body', idx: attr(ph, 'idx') };
}

/** A layout's or master's placeholders, with their boxes and text styles. */
interface Template {
  placeholders: { ph: Placeholder; box: Box | null; styles: LevelStyle[]; anchor?: string }[];
  background?: string;
  /** The master's own styles for titles, body text and everything else. */
  title: LevelStyle[];
  body: LevelStyle[];
  other: LevelStyle[];
}

function readTemplate(xml: string | null, theme: Theme): Template {
  const root = parseXml(xml ?? '');
  const tree = firstChild(firstChild(root, 'cSld'), 'spTree');
  const placeholders = childElements(tree, 'sp').flatMap((sp) => {
    const ph = placeholderOf(sp);
    if (!ph) return [];
    const body = firstChild(sp, 'txBody');
    return [
      {
        ph,
        box: boxOf(firstChild(sp, 'spPr')),
        styles: levelStyles(firstChild(body, 'lstStyle'), theme),
        anchor: attr(firstChild(body, 'bodyPr'), 'anchor'),
      },
    ];
  });
  const txStyles = firstChild(root, 'txStyles');
  return {
    placeholders,
    background: backgroundOf(root, theme),
    title: levelStyles(firstChild(txStyles, 'titleStyle'), theme),
    body: levelStyles(firstChild(txStyles, 'bodyStyle'), theme),
    other: levelStyles(firstChild(txStyles, 'otherStyle'), theme),
  };
}

function backgroundOf(root: XmlElement | null, theme: Theme): string | undefined {
  const bg = firstChild(firstChild(root, 'cSld'), 'bg');
  if (!bg) return undefined;
  const fill = firstChild(firstChild(bg, 'bgPr'), 'solidFill');
  if (fill) return colourOf(fill, theme);
  // A reference to the theme's background fills, with a colour to use.
  return colourOf(firstChild(bg, 'bgRef'), theme);
}

const isTitle = (ph: Placeholder | null) => ph !== null && (ph.type === 'title' || ph.type === 'ctrTitle');

function matchPlaceholder(template: Template, ph: Placeholder) {
  return (
    template.placeholders.find((p) => ph.idx !== undefined && p.ph.idx === ph.idx) ??
    template.placeholders.find((p) => p.ph.type === ph.type || (isTitle(p.ph) && isTitle(ph)))
  );
}

interface SlideContext {
  parts: Record<string, Uint8Array>;
  rels: Rels;
  theme: Theme;
  layout: Template;
  master: Template;
  pictures: SourcePicture[];
  pictureIndex: Map<string, number>;
  leftOut: number;
}

function picture(context: SlideContext, id: string | undefined): number | null {
  const rel = id ? context.rels.get(id) : undefined;
  if (!rel || rel.external) {
    context.leftOut += 1;
    return null;
  }
  const known = context.pictureIndex.get(rel.target);
  if (known !== undefined) return known;
  const bytes = context.parts[rel.target];
  const mime = pictureMime(rel.target);
  if (!bytes || ['image/emf', 'image/wmf', 'image/svg+xml', 'application/octet-stream'].includes(mime)) {
    context.leftOut += 1;
    return null;
  }
  context.pictures.push({ bytes, mime });
  context.pictureIndex.set(rel.target, context.pictures.length - 1);
  return context.pictures.length - 1;
}

/** The paragraphs of a text body as text blocks. */
function paragraphs(
  body: XmlElement | null,
  context: SlideContext,
  levels: (level: number) => LevelStyle,
  scale: number,
): TextBlock[] {
  const out: TextBlock[] = [];
  const numbers: number[] = [];
  const own = levelStyles(firstChild(body, 'lstStyle'), context.theme);
  for (const p of childElements(body, 'p')) {
    const pPr = firstChild(p, 'pPr');
    const level = Math.min(8, Math.max(0, num(attr(pPr, 'lvl')) ?? 0));
    const style = { ...levels(level), ...own[level] };
    const runs: TextRun[] = [];
    let size: number | undefined;
    for (const child of childElements(p)) {
      if (child.local === 'br') {
        runs.push({ text: '\n' });
        continue;
      }
      if (child.local !== 'r' && child.local !== 'fld') continue;
      const rPr = firstChild(child, 'rPr');
      const text = textOf(firstChild(child, 't'));
      if (text.length === 0) continue;
      const run: TextRun = { text };
      const b = attr(rPr, 'b');
      if (b === '1' || (b === undefined && style.bold)) run.bold = true;
      if (attr(rPr, 'i') === '1') run.italic = true;
      const u = attr(rPr, 'u');
      if (u !== undefined && u !== 'none') run.underline = true;
      const strike = attr(rPr, 'strike');
      if (strike !== undefined && strike !== 'noStrike') run.strike = true;
      const color = colourOf(firstChild(rPr, 'solidFill'), context.theme) ?? style.color;
      if (color) run.color = color;
      const link = context.rels.get(attr(firstChild(rPr, 'hlinkClick'), 'id', R) ?? '');
      if (link?.external) run.link = link.target;
      size ??= num(attr(rPr, 'sz'));
      runs.push(run);
    }
    const bulletChar = attr(firstChild(pPr, 'buChar'), 'char');
    const autoNumber = firstChild(pPr, 'buAutoNum');
    const bullet = firstChild(pPr, 'buNone') ? null : autoNumber ? '#' : (bulletChar ?? style.bullet ?? null);
    const merged = mergeRuns(runs);
    const text = merged.map((r) => r.text).join('');
    const said = attr(pPr, 'rtl');
    const rtl = said === '1' || (said === undefined && (style.rtl || /^[^A-Za-z]*[\u0590-\u08FF]/.test(text)));
    const block: TextBlock = {
      type: 'text',
      text,
      size: ((size !== undefined ? size / 100 : style.size) ?? 18) * scale,
      align: alignOf(attr(pPr, 'algn') ?? style.algn, rtl) ?? 'start',
      spaceAfter: 2,
    };
    if (merged.length > 0) block.runs = merged;
    if (rtl) block.dir = 'rtl';
    const before = num(attr(firstChild(firstChild(pPr, 'spcBef'), 'spcPts'), 'val'));
    const after = num(attr(firstChild(firstChild(pPr, 'spcAft'), 'spcPts'), 'val'));
    if (before !== undefined) block.spaceBefore = before / 100;
    if (after !== undefined) block.spaceAfter = after / 100;
    const indent = num(attr(pPr, 'marL'));
    if (indent !== undefined && indent > 0) block.indent = indent * EMU;
    if (bullet !== null && text.trim().length > 0) {
      if (bullet === '#') {
        numbers[level] = (numbers[level] ?? (num(attr(autoNumber, 'startAt')) ?? 1) - 1) + 1;
        block.marker = `${numbers[level]}.`;
      } else block.marker = bullet;
      block.indent = Math.max(block.indent ?? 0, (block.size ?? 18) * 1.2 * (level + 1));
    } else numbers.length = level;
    out.push(block);
  }
  return out;
}

/** A table's cells, as a table block. */
function tableOf(tbl: XmlElement, context: SlideContext): Block {
  const widths = childElements(firstChild(tbl, 'tblGrid'), 'gridCol').map((c) => (num(attr(c, 'w')) ?? 0) * EMU);
  const header = attr(firstChild(tbl, 'tblPr'), 'firstRow') === '1';
  const rows: TableCell[][] = [];
  let size: number | undefined;
  for (const tr of childElements(tbl, 'tr')) {
    const row: TableCell[] = [];
    for (const tc of childElements(tr, 'tc')) {
      // A cell another spans across is left out; one it spans down stays, empty.
      if (attr(tc, 'hMerge') === '1') continue;
      const body = firstChild(tc, 'txBody');
      const texts = childElements(body, 'p').map((p) =>
        childElements(p)
          .filter((c) => c.local === 'r' || c.local === 'fld')
          .map((r) => textOf(firstChild(r, 't')))
          .join(''),
      );
      size ??= num(attr(firstChild(childElements(firstChild(body, 'p'), 'r')[0] ?? null, 'rPr'), 'sz'));
      const cell: TableCell = { text: attr(tc, 'vMerge') === '1' ? '' : texts.join('\n') };
      const span = num(attr(tc, 'gridSpan'));
      if (span && span > 1) cell.span = span;
      const fill = colourOf(firstChild(firstChild(tc, 'tcPr'), 'solidFill'), context.theme);
      if (fill) cell.fill = fill;
      if (/[\u0600-ۿ]/.test(cell.text)) cell.dir = 'rtl';
      row.push(cell);
    }
    rows.push(row);
  }
  const rtl = attr(firstChild(tbl, 'tblPr'), 'rtl') === '1';
  return { type: 'table', rows, widths, headerRows: header ? 1 : 0, dir: rtl ? 'rtl' : 'auto', size: size ? size / 100 : 12, spaceBefore: 0, spaceAfter: 0 };
}

/** Maps a group's child coordinates onto the slide. */
type Place = (box: Box) => Box;

/** The blocks of a shape tree: frames in drawing order. */
function shapes(tree: XmlElement | null, context: SlideContext): FrameBlock[] {
  const out: FrameBlock[] = [];
  const todo: { node: XmlElement; place: Place; depth: number }[] = childElements(tree)
    .reverse()
    .map((node) => ({ node, place: (b: Box) => b, depth: 0 }));
  while (todo.length > 0) {
    const { node, place, depth } = todo.pop()!;
    if (node.local === 'grpSp' && depth < MAX_DEPTH) {
      const xfrm = firstChild(firstChild(node, 'grpSpPr'), 'xfrm');
      const off = firstChild(xfrm, 'off');
      const ext = firstChild(xfrm, 'ext');
      const chOff = firstChild(xfrm, 'chOff');
      const chExt = firstChild(xfrm, 'chExt');
      const [ox, oy, ex, ey] = [num(attr(off, 'x')) ?? 0, num(attr(off, 'y')) ?? 0, num(attr(ext, 'cx')) ?? 0, num(attr(ext, 'cy')) ?? 0];
      const [cx, cy, cw, ch] = [num(attr(chOff, 'x')) ?? ox, num(attr(chOff, 'y')) ?? oy, num(attr(chExt, 'cx')) ?? ex, num(attr(chExt, 'cy')) ?? ey];
      const sx = cw > 0 ? ex / cw : 1;
      const sy = ch > 0 ? ey / ch : 1;
      const inner: Place = (b) =>
        place({
          x: (ox + (b.x / EMU - cx) * sx) * EMU,
          y: (oy + (b.y / EMU - cy) * sy) * EMU,
          width: b.width * sx,
          height: b.height * sy,
        });
      for (const child of childElements(node).reverse()) todo.push({ node: child, place: inner, depth: depth + 1 });
      continue;
    }
    if (node.local === 'pic') {
      const box = boxOf(firstChild(node, 'spPr'));
      const blip = firstChild(firstChild(node, 'blipFill'), 'blip');
      const index = picture(context, attr(blip, 'embed', R) ?? attr(blip, 'embed'));
      if (!box || index === null) continue;
      const at = place(box);
      out.push({ type: 'frame', ...at, blocks: [{ type: 'image', index, width: at.width, height: at.height, spaceBefore: 0, spaceAfter: 0 }] });
      continue;
    }
    if (node.local === 'graphicFrame') {
      const tbl = firstChild(firstChild(firstChild(node, 'graphic'), 'graphicData'), 'tbl');
      const xfrm = firstChild(node, 'xfrm');
      const box = boxOf(xfrm ? { ns: '', local: 'spPr', attrs: {}, children: [xfrm] } : null);
      if (!tbl || !box) {
        // A chart or a diagram: nothing Warraq can draw.
        context.leftOut += 1;
        continue;
      }
      out.push({ type: 'frame', ...place(box), blocks: [tableOf(tbl, context)] });
      continue;
    }
    if (node.local !== 'sp') continue;
    const spPr = firstChild(node, 'spPr');
    const ph = placeholderOf(node);
    const fromLayout = ph ? matchPlaceholder(context.layout, ph) : undefined;
    const fromMaster = ph ? matchPlaceholder(context.master, ph) : undefined;
    const box = boxOf(spPr) ?? fromLayout?.box ?? fromMaster?.box ?? null;
    if (!box) continue;
    const at = place(box);
    const frame: FrameBlock = { type: 'frame', ...at, blocks: [] };
    if (!firstChild(spPr, 'noFill')) {
      const fill = colourOf(firstChild(spPr, 'solidFill'), context.theme);
      if (fill) frame.fill = fill;
    }
    const ln = firstChild(spPr, 'ln');
    if (ln && !firstChild(ln, 'noFill')) {
      const color = colourOf(firstChild(ln, 'solidFill'), context.theme);
      if (color) frame.line = { color, width: (num(attr(ln, 'w')) ?? 12_700) * EMU };
    }
    const body = firstChild(node, 'txBody');
    if (body) {
      const bodyPr = firstChild(body, 'bodyPr');
      const inset = (name: string, k: number) => (num(attr(bodyPr, name)) ?? INSET[k]!) * EMU;
      frame.inset = [inset('lIns', 0), inset('tIns', 1), inset('rIns', 2), inset('bIns', 3)];
      const anchor = attr(bodyPr, 'anchor') ?? fromLayout?.anchor ?? fromMaster?.anchor;
      frame.anchor = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top';
      const fontScale = num(attr(firstChild(bodyPr, 'normAutofit'), 'fontScale'));
      const scale = fontScale !== undefined ? fontScale / 100_000 : 1;
      const master = isTitle(ph) ? context.master.title : ph ? context.master.body : context.master.other;
      const levels = (level: number): LevelStyle => ({
        ...master[level],
        ...fromMaster?.styles[level],
        ...fromLayout?.styles[level],
        // A text box that is not a placeholder has no bullets of its own.
        ...(ph ? {} : { bullet: null }),
      });
      frame.blocks = paragraphs(body, context, levels, scale);
    }
    if (frame.blocks.length > 0 || frame.fill || frame.line) out.push(frame);
  }
  return out;
}

/** Whether `bytes` is a PowerPoint presentation: a zip with `ppt/presentation.xml`. */
export function isPptx(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  try {
    return 'ppt/presentation.xml' in readParts(bytes, (name) => name === 'ppt/presentation.xml');
  } catch {
    return false;
  }
}

export function readPptx(bytes: Uint8Array): ReadDocument {
  const parts = readParts(
    bytes,
    (name) =>
      name === 'ppt/presentation.xml' ||
      name === 'docProps/core.xml' ||
      /^ppt\/(slides|slideLayouts|slideMasters|theme)\/[^/]+\.xml$/.test(name) ||
      /^ppt\/(slides|slideLayouts|slideMasters)?\/?_rels\/[^/]+\.rels$/.test(name) ||
      name.startsWith('ppt/media/'),
  );
  const presentation = parseXml(partText(parts, 'ppt/presentation.xml') ?? '');
  if (!presentation || presentation.local !== 'presentation') throw new Error('E_CREATE: not a PowerPoint presentation');
  const size = firstChild(presentation, 'sldSz');
  const width = (num(attr(size, 'cx')) ?? 9_144_000) * EMU;
  const height = (num(attr(size, 'cy')) ?? 6_858_000) * EMU;
  const rels = relsOf(parts, 'ppt/presentation.xml');
  const pictures: SourcePicture[] = [];
  const pictureIndex = new Map<string, number>();
  let leftOut = 0;
  const templates = new Map<string, Template>();
  const themes = new Map<string, Theme>();
  const blocks: Block[] = [];
  const slides = childElements(firstChild(presentation, 'sldIdLst'), 'sldId').slice(0, MAX_SLIDES);
  for (const id of slides) {
    const part = rels.get(attr(id, 'id', R) ?? attr(id, 'id') ?? '')?.target;
    const xml = part ? partText(parts, part) : null;
    const root = xml ? parseXml(xml) : null;
    if (!part || !root || attr(root, 'show') === '0') continue;
    const slideRels = relsOf(parts, part);
    const layoutPart = relOfType(parts, part, 'slideLayout');
    const masterPart = layoutPart ? relOfType(parts, layoutPart, 'slideMaster') : null;
    const themePart = masterPart ? relOfType(parts, masterPart, 'theme') : null;
    const theme = themes.get(themePart ?? '') ?? readTheme(themePart ? partText(parts, themePart) : null);
    themes.set(themePart ?? '', theme);
    const template = (p: string | null) => {
      const key = p ?? '';
      let t = templates.get(key);
      if (!t) {
        t = readTemplate(p ? partText(parts, p) : null, theme);
        templates.set(key, t);
      }
      return t;
    };
    const layout = template(layoutPart);
    const master = template(masterPart);
    const context: SlideContext = { parts, rels: slideRels, theme, layout, master, pictures, pictureIndex, leftOut };
    const background = backgroundOf(root, theme) ?? layout.background ?? master.background;
    blocks.push({ type: 'page', width, height, margins: [0, 0, 0, 0], background: background ?? '#ffffff' });
    blocks.push(...shapes(firstChild(firstChild(root, 'cSld'), 'spTree'), context));
    leftOut = context.leftOut;
  }
  const title = textOf(firstChild(parseXml(partText(parts, 'docProps/core.xml') ?? ''), 'title')).trim();
  return {
    blocks,
    pictures,
    page: { width, height, margins: [0, 0, 0, 0] },
    title: title || undefined,
    picturesLeftOut: leftOut,
    truncated: childElements(firstChild(presentation, 'sldIdLst'), 'sldId').length > MAX_SLIDES,
  };
}
