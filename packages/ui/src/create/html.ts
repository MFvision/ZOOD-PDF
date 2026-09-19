import { mergeRuns, withRuns } from './blocks';
import type { Block, BlockAlign, BlockDir, ReadDocument, SourcePicture, TableCell, TextBlock, TextRun } from './blocks';

/**
 * A web page (.html) read into blocks: headings, paragraphs, line breaks,
 * lists, tables (with column and row spans), quotations, preformatted text,
 * rules and pictures, with bold, italic, underline, strike-through, colour
 * and links inside them, each block in the direction its `dir` or text
 * gives it.
 *
 * The page is hostile input and is only read, never shown: nothing in it
 * runs, and nothing it points to is fetched. Scripts, styles, frames,
 * forms' controls and embedded objects are dropped; a picture is taken only
 * when the page carries it (a `data:` address), never from the network or
 * the disk. Style sheets are not applied — only a `style` attribute's
 * colour, alignment and direction — so the layout is the text's, not the
 * page's.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen']);
/** Elements whose content is not the page's text. */
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'video', 'audio', 'select', 'button', 'textarea', 'head', 'map', 'datalist', 'dialog']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'li', 'main',
  'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul', 'caption', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot',
]);
/** Opening one of these closes an open paragraph. */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'ul', 'li', 'dd', 'dt',
]);
const MAX_NODES = 500_000;
const MAX_DEPTH = 200;

/** A few hundred of HTML's named characters: those pages actually use. */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', shy: '\u00AD', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', sbquo: '‚',
  bdquo: '„', bull: '•', middot: '·', deg: '°', plusmn: '±', times: '×', divide: '÷', minus: '−', frac12: '½', frac14: '¼',
  frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', para: '¶', sect: '§', euro: '€', pound: '£', yen: '¥', cent: '¢',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', check: '✓', cross: '✗', hearts: '♥', star: '☆', dagger: '†',
  Dagger: '‡', permil: '‰', prime: '′', Prime: '″', thinsp: '\u2009', ensp: '\u2002', emsp: '\u2003', zwnj: '\u200C',
  zwj: '\u200D', lrm: '\u200E', rlm: '\u200F', iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', not: '¬', macr: '¯',
  acute: '´', cedil: '¸', uml: '¨', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', sum: '∑', prod: '∏', radic: '√',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω', Omega: 'Ω', mu: 'μ', lambda: 'λ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', atilde: 'ã', aring: 'å',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', otilde: 'õ', uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', iacute: 'í',
  igrave: 'ì', icirc: 'î', iuml: 'ï', ccedil: 'ç', ntilde: 'ñ', szlig: 'ß', Eacute: 'É', Agrave: 'À', Ccedil: 'Ç',
  Ouml: 'Ö', Uuml: 'Ü', Auml: 'Ä', oslash: 'ø', aelig: 'æ', AElig: 'Æ',
};

function decode(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return ENTITIES[body] ?? whole;
  });
}

export interface HtmlElement {
  name: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}
export type HtmlNode = HtmlElement | string;

const ATTRIBUTE = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * The page as a tree, the way a browser's parser would roughly build it:
 * void elements never hold anything, a new paragraph, list item, row or cell
 * closes the one before, and a stray end tag is ignored. Never throws.
 */
export function parseHtml(source: string): HtmlElement {
  const root: HtmlElement = { name: '#root', attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  let nodes = 0;
  const top = () => stack[stack.length - 1]!;
  const closeTo = (names: readonly string[], until: readonly string[] = ['table', 'ul', 'ol', 'body', 'html']) => {
    for (let k = stack.length - 1; k > 0; k -= 1) {
      const name = stack[k]!.name;
      if (until.includes(name)) return;
      if (names.includes(name)) {
        stack.length = k;
        return;
      }
    }
  };
  // For finding where a script or style ends, whatever its case.
  const lower = source.toLowerCase();
  let at = 0;
  while (at < source.length && nodes < MAX_NODES) {
    const lt = source.indexOf('<', at);
    if (lt < 0) {
      top().children.push(decode(source.slice(at)));
      break;
    }
    if (lt > at) top().children.push(decode(source.slice(at, lt)));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source[lt + 1] === '!' || source[lt + 1] === '?') {
      const end = source.indexOf('>', lt);
      at = end < 0 ? source.length : end + 1;
      continue;
    }
    const tagMatch = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/.exec(source.slice(lt, lt + 64));
    if (!tagMatch) {
      top().children.push('<');
      at = lt + 1;
      continue;
    }
    // The tag's end, outside quoted attribute values.
    let k = lt + tagMatch[0].length;
    let quote = '';
    for (; k < source.length; k += 1) {
      const c = source[k];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const inside = source.slice(lt + tagMatch[0].length, k);
    at = k + 1;
    const name = tagMatch[2]!.toLowerCase();
    if (tagMatch[1] === '/') {
      if (name === 'p' && !stack.some((e) => e.name === 'p')) {
        top().children.push({ name: 'p', attrs: {}, children: [] });
        continue;
      }
      const index = stack.map((e) => e.name).lastIndexOf(name);
      if (index > 0) stack.length = index;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const m of inside.matchAll(ATTRIBUTE)) {
      const key = m[1]!.toLowerCase();
      if (!(key in attrs)) attrs[key] = decode(m[2] ?? m[3] ?? m[4] ?? '');
    }
    if (CLOSES_P.has(name)) closeTo(['p']);
    if (name === 'li') closeTo(['li']);
    if (name === 'dt' || name === 'dd') closeTo(['dt', 'dd']);
    if (name === 'tr') closeTo(['tr', 'td', 'th'], ['table']);
    if (name === 'td' || name === 'th') closeTo(['td', 'th'], ['tr', 'table']);
    if (name === 'thead' || name === 'tbody' || name === 'tfoot') closeTo(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], ['table']);
    if (/^h[1-6]$/.test(name)) closeTo(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    const element: HtmlElement = { name, attrs, children: [] };
    nodes += 1;
    top().children.push(element);
    if (RAW.has(name)) {
      const close = lower.indexOf(`</${name}`, at);
      const end = close < 0 ? source.length : close;
      element.children.push(name === 'title' || name === 'textarea' ? decode(source.slice(at, end)) : source.slice(at, end));
      const gt = close < 0 ? -1 : source.indexOf('>', close);
      at = gt < 0 ? source.length : gt + 1;
      continue;
    }
    if (!VOID.has(name) && !inside.trimEnd().endsWith('/') && stack.length < MAX_DEPTH) stack.push(element);
  }
  return root;
}

/** CSS declarations of a `style` attribute: property to value. */
function styleOf(element: HtmlElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const declaration of (element.attrs.style ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon > 0) out.set(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim().toLowerCase());
  }
  return out;
}

const NAMED_COLOURS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', navy: '#000080', maroon: '#800000',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', purple: '#800080', teal: '#008080', olive: '#808000', orange: '#ffa500',
  brown: '#a52a2a', darkblue: '#00008b', darkred: '#8b0000', darkgreen: '#006400',
};

/** A CSS colour as `#rrggbb`: `#rgb`, `#rrggbb`, `rgb()` or a few names. */
export function cssColour(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`;
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(v);
  if (m) return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
  return NAMED_COLOURS[v];
}

function hidden(element: HtmlElement): boolean {
  if ('hidden' in element.attrs) return true;
  const display = styleOf(element).get('display');
  const visibility = styleOf(element).get('visibility');
  return display === 'none' || visibility === 'hidden';
}

function dirOf(element: HtmlElement, around: BlockDir): BlockDir {
  const given = (element.attrs.dir ?? styleOf(element).get('direction') ?? '').toLowerCase();
  return given === 'rtl' || given === 'ltr' ? given : around;
}

function alignOf(element: HtmlElement, dir: BlockDir, around: BlockAlign | undefined): BlockAlign | undefined {
  const given = (styleOf(element).get('text-align') ?? element.attrs.align ?? '').toLowerCase();
  const rtl = dir === 'rtl';
  switch (given) {
    case 'center':
    case 'middle':
      return 'center';
    case 'justify':
      return 'justify';
    case 'start':
      return 'start';
    case 'end':
      return 'end';
    case 'left':
      return rtl ? 'end' : 'start';
    case 'right':
      return rtl ? 'start' : 'end';
    default:
      return element.name === 'center' ? 'center' : around;
  }
}

interface Inline {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  link?: string;
}

interface Context {
  dir: BlockDir;
  align?: BlockAlign;
  /** List nesting: each list's kind and its next number. */
  lists: { ordered: boolean; next: number; type: string }[];
  indent: number;
  quote: number;
}

const HEADING = [24, 20, 16, 14, 12, 11];

/** The page's blocks, pictures and title. */
class Reader {
  blocks: Block[] = [];
  pictures: SourcePicture[] = [];
  leftOut = 0;
  private runs: TextRun[] = [];
  /** A list item's marker, for its first paragraph. */
  marker: string | null = null;

  /** The inline text gathered so far, as a paragraph. */
  flush(context: Context, extra: Partial<TextBlock> = {}) {
    const runs = mergeRuns(this.runs);
    this.runs = [];
    // Leading and trailing white space of a paragraph is not the paragraph's.
    const text = runs.map((r) => r.text).join('');
    if (text.trim().length === 0) return;
    if (runs[0]) runs[0].text = runs[0].text.replace(/^\s+/, '');
    const last = runs[runs.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, '');
    const block: Omit<TextBlock, 'text' | 'runs'> = { type: 'text', size: 11, spaceAfter: 6, ...extra };
    if (this.marker !== null) {
      block.marker = this.marker;
      this.marker = null;
    }
    if (context.dir !== 'auto') block.dir = context.dir;
    if (context.align) block.align = context.align;
    const indent = context.indent + context.quote * 24;
    if (indent > 0) block.indent = (block.indent ?? 0) + indent;
    if (context.quote > 0) block.color ??= '#444444';
    this.blocks.push(withRuns(block, runs));
  }

  text(text: string, inline: Inline, pre: boolean) {
    const clean = pre ? text : text.replace(/[\t\n\r\f ]+/g, ' ');
    if (clean.length === 0) return;
    const run: TextRun = { text: clean };
    if (inline.bold) run.bold = true;
    if (inline.italic) run.italic = true;
    if (inline.underline) run.underline = true;
    if (inline.strike) run.strike = true;
    if (inline.color) run.color = inline.color;
    if (inline.link) run.link = inline.link;
    this.runs.push(run);
  }

  picture(element: HtmlElement, context: Context) {
    const src = (element.attrs.src ?? '').trim();
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
    if (!m) {
      // Never fetched: from the network or the disk, a page's picture stays out.
      this.leftOut += 1;
      return;
    }
    let bytes: Uint8Array;
    try {
      const binary = atob(m[2]!.replace(/\s+/g, ''));
      bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    } catch {
      this.leftOut += 1;
      return;
    }
    this.pictures.push({ bytes, mime: m[1]!.toLowerCase() });
    const px = (v: string | undefined) => {
      const n = Number.parseFloat(v ?? '');
      return Number.isFinite(n) && n > 0 && !/%/.test(v ?? '') ? n * 0.75 : undefined;
    };
    const style = styleOf(element);
    const width = px(style.get('width') ?? element.attrs.width);
    const height = px(style.get('height') ?? element.attrs.height);
    const block: Block = { type: 'image', index: this.pictures.length - 1, align: context.align ?? 'center' };
    if (width) block.width = width;
    if (height) block.height = height;
    if (context.dir !== 'auto') block.dir = context.dir;
    this.blocks.push(block);
  }

  table(element: HtmlElement, context: Context) {
    const rows: TableCell[][] = [];
    let headerRows = 0;
    // Cells a row span from above still holds, per row: column → count.
    const pending = new Map<number, number>();
    const visitRows = (node: HtmlElement, head: boolean) => {
      for (const child of node.children) {
        if (typeof child === 'string' || hidden(child)) continue;
        if (child.name === 'thead') visitRows(child, true);
        else if (child.name === 'tbody' || child.name === 'tfoot') visitRows(child, false);
        else if (child.name === 'tr') {
          const row: TableCell[] = [];
          let column = 0;
          let allHeads = true;
          const skip = () => {
            while ((pending.get(column) ?? 0) > 0) {
              pending.set(column, pending.get(column)! - 1);
              row.push({ text: '' });
              column += 1;
            }
          };
          for (const cell of child.children) {
            if (typeof cell === 'string' || (cell.name !== 'td' && cell.name !== 'th')) continue;
            skip();
            if (cell.name !== 'th') allHeads = false;
            const span = Math.min(100, Math.max(1, Number.parseInt(cell.attrs.colspan ?? '1', 10) || 1));
            const down = Math.min(1000, Math.max(1, Number.parseInt(cell.attrs.rowspan ?? '1', 10) || 1));
            const text = textOfNode(cell).replace(/[ \t]+/g, ' ').trim();
            const out: TableCell = { text };
            if (span > 1) out.span = span;
            if (cell.name === 'th' || /bold|[6-9]00/.test(styleOf(cell).get('font-weight') ?? '')) out.bold = true;
            const dir = dirOf(cell, context.dir);
            if (dir !== 'auto') out.dir = dir;
            const align = alignOf(cell, dir, undefined);
            if (align) out.align = align;
            const fill = cssColour(styleOf(cell).get('background-color') ?? styleOf(cell).get('background') ?? cell.attrs.bgcolor);
            if (fill && fill !== '#ffffff') out.fill = fill;
            row.push(out);
            for (let k = 0; k < span; k += 1) if (down > 1) pending.set(column + k, down - 1);
            column += span;
          }
          skip();
          if (row.length === 0) continue;
          if ((head || allHeads) && rows.length === headerRows) headerRows += 1;
          rows.push(row);
        }
      }
    };
    visitRows(element, false);
    const caption = element.children.find((c): c is HtmlElement => typeof c !== 'string' && c.name === 'caption');
    if (caption) this.blocks.push({ type: 'text', text: textOfNode(caption).trim(), bold: true, align: 'center', size: 11, spaceAfter: 4 });
    if (rows.length === 0) return;
    const dir = dirOf(element, context.dir);
    const block: Block = { type: 'table', rows, headerRows, size: 10 };
    if (dir !== 'auto') block.dir = dir;
    this.blocks.push(block);
  }

  /** Walks `root` depth first without recursion, gathering blocks. */
  read(root: HtmlElement) {
    type Step = { node: HtmlNode; inline: Inline; context: Context; pre: boolean } | { end: HtmlElement; context: Context; extra?: Partial<TextBlock> };
    const start: Context = { dir: 'auto', lists: [], indent: 0, quote: 0 };
    const todo: Step[] = [{ node: root, inline: {}, context: start, pre: false }];
    while (todo.length > 0) {
      const step = todo.pop()!;
      if ('end' in step) {
        this.flush(step.context, step.extra);
        if (step.end.name === 'li') this.marker = null;
        continue;
      }
      const { node, inline, pre } = step;
      let context = step.context;
      if (typeof node === 'string') {
        this.text(node, inline, pre);
        continue;
      }
      if (SKIP.has(node.name) || hidden(node) || node.name === 'title') continue;
      const name = node.name;
      const dir = dirOf(node, context.dir);
      const align = alignOf(node, dir, context.align);
      if (dir !== context.dir || align !== context.align) context = { ...context, dir, align };
      const next: Inline = { ...inline };
      const style = styleOf(node);
      const colour = cssColour(style.get('color') ?? node.attrs.color);
      if (colour) next.color = colour;
      if (['b', 'strong'].includes(name) || /bold|[6-9]00/.test(style.get('font-weight') ?? '')) next.bold = true;
      if (['i', 'em', 'cite', 'var', 'dfn'].includes(name) || style.get('font-style') === 'italic') next.italic = true;
      if (['u', 'ins'].includes(name) || (style.get('text-decoration') ?? '').includes('underline')) next.underline = true;
      if (['s', 'strike', 'del'].includes(name) || (style.get('text-decoration') ?? '').includes('line-through')) next.strike = true;
      if (name === 'a' && node.attrs.href && /^(https?:|mailto:)/i.test(node.attrs.href.trim())) {
        next.link = node.attrs.href.trim();
        next.underline = true;
        next.color ??= '#1a56b8';
      }
      if (name === 'br') {
        this.runs.push({ text: '\n' });
        continue;
      }
      if (name === 'img') {
        this.flush(context);
        this.picture(node, context);
        continue;
      }
      if (name === 'hr') {
        this.flush(context);
        this.blocks.push({ type: 'rule' });
        continue;
      }
      if (name === 'table') {
        this.flush(context);
        this.table(node, context);
        continue;
      }
      if (name === 'input' && /checkbox|radio/i.test(node.attrs.type ?? '')) {
        this.text('checked' in node.attrs ? '☑ ' : '☐ ', next, pre);
        continue;
      }
      if (!BLOCK.has(name)) {
        const children = node.children.map<Step>((child) => ({ node: child, inline: next, context, pre: pre || name === 'pre' }));
        todo.push(...children.reverse());
        continue;
      }
      // A block starts: what came before it is a paragraph of its own.
      this.flush(context);
      let extra: Partial<TextBlock> = {};
      if (/^h[1-6]$/.test(name)) {
        const level = Number(name[1]) - 1;
        extra = { size: HEADING[level], bold: true, keepWithNext: true, spaceBefore: 10, spaceAfter: 6 };
      } else if (name === 'pre') {
        // Code reads left to right, whatever the page around it, unless it says otherwise.
        const own = (node.attrs.dir ?? '').toLowerCase();
        context = { ...context, dir: own === 'rtl' ? 'rtl' : 'ltr', align: undefined };
        extra = { preserve: true, size: 9.5, shade: '#f2f2f4', spaceBefore: 4, spaceAfter: 8 };
      } else if (name === 'blockquote') {
        context = { ...context, quote: context.quote + 1 };
      } else if (name === 'ul' || name === 'ol' || name === 'menu' || name === 'dir') {
        const ordered = name === 'ol';
        const start = Number.parseInt(node.attrs.start ?? '1', 10);
        context = {
          ...context,
          lists: [...context.lists, { ordered, next: Number.isFinite(start) ? start : 1, type: node.attrs.type ?? '1' }],
          indent: context.indent + 18,
        };
      } else if (name === 'li') {
        const list = context.lists[context.lists.length - 1];
        // The item's first paragraph carries it, even one inside a <p> or before a nested list.
        this.marker = list?.ordered ? `${listNumber(list.next, list.type)}.` : ['•', '◦', '▪'][(context.lists.length - 1) % 3]!;
        if (list?.ordered) list.next += 1;
        extra = { spaceAfter: 3 };
      } else if (name === 'dd') {
        context = { ...context, indent: context.indent + 24 };
      } else if (name === 'dt') {
        extra = { bold: true, spaceAfter: 2 };
      }
      todo.push({ end: node, context, extra });
      const children = node.children.map<Step>((child) => ({ node: child, inline: next, context, pre: pre || name === 'pre' }));
      todo.push(...children.reverse());
    }
  }
}

function listNumber(n: number, type: string): string {
  if (type === 'a') return String.fromCharCode(96 + Math.min(26, Math.max(1, n)));
  if (type === 'A') return String.fromCharCode(64 + Math.min(26, Math.max(1, n)));
  if (type === 'i' || type === 'I') {
    const numerals: [number, string][] = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let out = '';
    let rest = Math.min(39, Math.max(1, n));
    for (const [v, s] of numerals) {
      while (rest >= v) {
        out += s;
        rest -= v;
      }
    }
    return type === 'I' ? out.toUpperCase() : out;
  }
  return String(n);
}

/** All the text inside a node, with its line breaks. */
function textOfNode(node: HtmlNode): string {
  let out = '';
  const todo: HtmlNode[] = [node];
  while (todo.length > 0) {
    const next = todo.pop()!;
    if (typeof next === 'string') out += next.replace(/[\t\n\r\f ]+/g, ' ');
    else if (next.name === 'br') out += '\n';
    else if (!SKIP.has(next.name) && !hidden(next)) {
      if (next.name === 'p' || next.name === 'div' || next.name === 'li') out += '\n';
      for (let k = next.children.length - 1; k >= 0; k -= 1) todo.push(next.children[k]!);
    }
  }
  return out.replace(/\n\s*\n+/g, '\n').replace(/^\s*\n|\n\s*$/g, '');
}

/**
 * The page's text from its bytes: UTF-8 or UTF-16 by a byte order mark, else
 * the charset its `<meta>` names (Windows-1256 for many Arabic pages), else UTF-8.
 */
export function decodeHtml(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const named = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/i.exec(head)?.[1];
  if (named) {
    try {
      return new TextDecoder(named.toLowerCase()).decode(bytes);
    } catch {
      // A charset the host does not know: UTF-8 is the best guess.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export function readHtml(bytes: Uint8Array): ReadDocument {
  const root = parseHtml(decodeHtml(bytes));
  const find = (node: HtmlElement, name: string): HtmlElement | null => {
    const todo: HtmlElement[] = [node];
    while (todo.length > 0) {
      const next = todo.pop()!;
      if (next.name === name) return next;
      for (const child of next.children) if (typeof child !== 'string') todo.push(child);
    }
    return null;
  };
  const title = find(root, 'title');
  const html = find(root, 'html');
  const reader = new Reader();
  const body = find(root, 'body') ?? root;
  // The page's own direction, from <html dir> or <body dir>.
  const dir = (body.attrs.dir ?? html?.attrs.dir ?? '').toLowerCase();
  if ((dir === 'rtl' || dir === 'ltr') && !body.attrs.dir) body.attrs.dir = dir;
  reader.read(body);
  reader.flush({ dir: 'auto', lists: [], indent: 0, quote: 0 });
  return {
    blocks: reader.blocks,
    pictures: reader.pictures,
    title: title ? textOfNode(title).trim() || undefined : undefined,
    picturesLeftOut: reader.leftOut,
    truncated: false,
  };
}
