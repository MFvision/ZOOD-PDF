import { dominantDirection, withRuns } from './blocks';
import type { Block, BlockAlign, ReadDocument, SourcePicture, TableCell, TextBlock, TextRun } from './blocks';
import { decodeText } from './text';

/**
 * Markdown (CommonMark with GitHub's tables and strike-through) read into
 * blocks: headings, paragraphs, hard line breaks, bulleted and numbered
 * lists (nested), quotations, fenced and indented code, tables with their
 * column alignment, rules; inside them bold, italic, strike-through, code
 * and links. Each paragraph takes its direction from its text, so Arabic
 * and English notes mix.
 *
 * Pictures are taken only when the file carries them (a `data:` address);
 * one on the network or the disk is left out, its description kept as text.
 * Raw HTML inside Markdown is shown as the text it is.
 */

const HEADING = [22, 18, 15, 13, 12, 11];
const CODE_SHADE = '#f2f2f4';

const SPACE = /\s/;

/** For each place in `source`, the first place at or after it where `stop` holds (the length where it never does). */
function nextWhere(source: string, stop: (k: number) => boolean): Int32Array {
  const out = new Int32Array(source.length + 1);
  let next = source.length;
  out[source.length] = next;
  for (let k = source.length - 1; k >= 0; k -= 1) {
    if (stop(k)) next = k;
    out[k] = next;
  }
  return out;
}

/**
 * Finds links, pictures and web addresses in a paragraph in time that grows
 * with its length, not its square. Regular expressions tried at every `[`
 * read on to the paragraph's end each time: a page of brackets (or of
 * `[x](`, or of `<http://`) froze the app for minutes. Here each "where is
 * the next…" is looked up in a table built once, in one pass.
 */
class LinkScanner {
  private tables = new Map<string, Int32Array>();
  constructor(private readonly source: string) {}

  private table(name: string, stop: (k: number) => boolean): Int32Array {
    let table = this.tables.get(name);
    if (!table) {
      table = nextWhere(this.source, stop);
      this.tables.set(name, table);
    }
    return table;
  }

  private nonSpace(k: number): number {
    return this.table('nonSpace', (p) => !SPACE.test(this.source[p]!))[Math.min(k, this.source.length)]!;
  }

  /** `[text](address "title")` (or, for a picture, `![text](…)`) starting at `at`: its text, its address, and where it ends. */
  bracketed(at: number, picture: boolean): { text: string; href: string; end: number } | null {
    const s = this.source;
    const open = at + (picture ? 2 : 1);
    // A picture's description holds no `]`; a link's may hold an escaped one.
    const close = picture
      ? this.table('close', (p) => s[p] === ']')[open]!
      : this.table('closeUnescaped', (p) => s[p] === ']' && backslashesBefore(s, p) % 2 === 0)[open]!;
    if (close >= s.length || s[close + 1] !== '(') return null;
    let k = this.nonSpace(close + 2);
    if (s[k] === '<') k += 1;
    const stop = this.table('addressEnd', (p) => s[p] === ')' || s[p] === '>' || SPACE.test(s[p]!))[k]!;
    const href = s.slice(k, stop);
    let m = stop;
    if (s[m] === '>') m += 1;
    const titled = this.nonSpace(m);
    if (titled > m && s[titled] === '"') {
      const quote = this.table('quote', (p) => s[p] === '"')[titled + 1]!;
      if (quote < s.length) {
        const after = this.nonSpace(quote + 1);
        if (s[after] === ')') return { text: s.slice(open, close), href, end: after + 1 };
      }
    }
    const after = this.nonSpace(m);
    return s[after] === ')' ? { text: s.slice(open, close), href, end: after + 1 } : null;
  }

  /** `<https://…>` or `<mailto:…>` starting at `at`: the address and where it ends. */
  autolink(at: number): { href: string; end: number } | null {
    const s = this.source;
    const scheme = /^(?:https?:\/\/|mailto:)/i.exec(s.slice(at + 1, at + 9));
    if (!scheme) return null;
    const from = at + 1 + scheme[0].length;
    const end = this.table('autolinkEnd', (p) => s[p] === '>' || SPACE.test(s[p]!))[from]!;
    if (end === from || s[end] !== '>') return null;
    return { href: s.slice(at + 1, end), end: end + 1 };
  }
}

function backslashesBefore(source: string, at: number): number {
  let n = 0;
  while (at - n - 1 >= 0 && source[at - n - 1] === '\\') n += 1;
  return n;
}

/** Inline Markdown — emphasis, code, links, pictures' descriptions — as runs. */
export function inlineRuns(source: string, base: Omit<TextRun, 'text'> = {}, pictures?: (alt: string, src: string) => void): TextRun[] {
  const scanner = new LinkScanner(source);
  const runs: TextRun[] = [];
  const push = (text: string, style: Omit<TextRun, 'text'>) => {
    if (text.length > 0) runs.push({ ...style, text });
  };
  // One pass over the text with a stack of open emphasis.
  let style: Omit<TextRun, 'text'> = { ...base };
  const open: { marker: string; saved: Omit<TextRun, 'text'> }[] = [];
  let text = '';
  let i = 0;
  const flush = () => {
    push(text, style);
    text = '';
  };
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\\' && i + 1 < source.length && /[\\`*_{}[\]()#+\-.!~|>]/.test(source[i + 1]!)) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const ticks = /^`+/.exec(source.slice(i))![0];
      const end = source.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        flush();
        push(source.slice(i + ticks.length, end).trim(), { ...style, color: '#8a1f3d' });
        i = end + ticks.length;
        continue;
      }
    }
    if (c === '!' && source[i + 1] === '[') {
      const m = scanner.bracketed(i, true);
      if (m) {
        flush();
        if (pictures) pictures(m.text, m.href);
        i = m.end;
        continue;
      }
    }
    if (c === '[') {
      const m = scanner.bracketed(i, false);
      if (m) {
        flush();
        const href = m.href;
        const linked = /^(https?:|mailto:)/i.test(href) ? { link: href, underline: true, color: '#1a56b8' } : {};
        runs.push(...inlineRuns(m.text, { ...style, ...linked }));
        i = m.end;
        continue;
      }
    }
    if (c === '<') {
      const m = scanner.autolink(i);
      if (m) {
        flush();
        push(m.href.replace(/^mailto:/i, ''), { ...style, link: m.href, underline: true, color: '#1a56b8' });
        i = m.end;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      const run = /^([*_~]+)/.exec(source.slice(i))![1]!;
      const marker = run.slice(0, Math.min(run.length, c === '~' ? 2 : 3));
      const before = source[i - 1] ?? ' ';
      const after = source[i + marker.length] ?? ' ';
      // Underscores inside a word are the word's own (snake_case).
      const intraword = c === '_' && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after);
      const top = open[open.length - 1];
      if (!intraword && top && top.marker === marker && !/\s/.test(before)) {
        flush();
        style = top.saved;
        open.pop();
        i += marker.length;
        continue;
      }
      if (!intraword && !/\s/.test(after) && source.indexOf(marker, i + marker.length) > 0 && (c !== '~' || marker === '~~')) {
        flush();
        open.push({ marker, saved: style });
        style = { ...style };
        if (c === '~') style.strike = true;
        else if (marker.length === 1) style.italic = true;
        else if (marker.length === 2) style.bold = true;
        else {
          style.bold = true;
          style.italic = true;
        }
        i += marker.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    text += c;
    i += 1;
  }
  flush();
  // Emphasis left open was only asterisks after all: its runs stay as they read.
  return runs;
}

interface ListFrame {
  indent: number;
  ordered: boolean;
  next: number;
}

/** A GitHub table's row split into its cells. */
function cells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function plain(source: string): string {
  return inlineRuns(source)
    .map((r) => r.text)
    .join('');
}

export function readMarkdown(bytes: Uint8Array): ReadDocument {
  const lines = decodeText(bytes).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  const pictures: SourcePicture[] = [];
  let leftOut = 0;
  let title: string | undefined;
  let paragraph: string[] = [];
  let quote = 0;
  const lists: ListFrame[] = [];
  let marker: string | null = null;

  const picture = (_alt: string, src: string) => {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(src);
    if (!m) {
      leftOut += 1;
      return;
    }
    try {
      const binary = atob(m[2]!);
      pictures.push({ bytes: Uint8Array.from(binary, (c) => c.charCodeAt(0)), mime: m[1]!.toLowerCase() });
      blocks.push({ type: 'image', index: pictures.length - 1, align: 'center' });
    } catch {
      leftOut += 1;
    }
  };

  const flush = () => {
    if (paragraph.length === 0) return;
    // A line ending in two spaces or a backslash breaks; others join with a space.
    const source = paragraph
      .map((line, k) => (k < paragraph.length - 1 ? (/( {2,}|\\)$/.test(line) ? `${line.replace(/( +|\\)$/, '')}\n` : `${line} `) : line))
      .join('');
    paragraph = [];
    const runs = inlineRuns(source.trim(), {}, picture);
    if (runs.length === 0) return;
    const shape: Omit<TextBlock, 'text' | 'runs'> = { type: 'text', size: 11, spaceAfter: 6 };
    const indent = lists.reduce((sum) => sum + 18, 0) + quote * 20;
    if (indent > 0) shape.indent = indent;
    if (quote > 0) shape.color = '#444444';
    if (marker !== null) {
      shape.marker = marker;
      shape.spaceAfter = 3;
      marker = null;
    }
    blocks.push(withRuns(shape, runs));
  };

  let i = 0;
  while (i < lines.length) {
    let line = lines[i]!;
    // Quotations: `>` at the start, as deep as there are of them.
    const q = /^ {0,3}((?:> ?)+)/.exec(line);
    const depth = q ? (q[1]!.match(/>/g) ?? []).length : 0;
    if (depth !== quote && (depth > 0 || line.trim() === '' || paragraph.length === 0)) {
      flush();
      quote = depth;
    }
    if (q) line = line.slice(q[0].length);
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const close = fence[1]!;
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(close)) code.push(lines[i++]!);
      i += 1;
      blocks.push({ type: 'text', text: code.join('\n'), preserve: true, size: 9.5, shade: CODE_SHADE, dir: 'ltr', spaceBefore: 4, spaceAfter: 8 });
      continue;
    }
    if (line.trim() === '') {
      flush();
      // A blank line ends the list only when what follows is not indented into it.
      const next = lines[i + 1] ?? '';
      if (lists.length > 0 && !/^\s+\S/.test(next) && !/^\s*([-*+]|\d{1,9}[.)])\s/.test(next)) lists.length = 0;
      i += 1;
      continue;
    }
    if (/^ {4,}\S/.test(line) && paragraph.length === 0 && lists.length === 0) {
      const code: string[] = [];
      while (i < lines.length && (/^ {4,}/.test(lines[i]!) || lines[i]!.trim() === '')) code.push(lines[i++]!.slice(4));
      while (code.length > 0 && code[code.length - 1]!.trim() === '') code.pop();
      blocks.push({ type: 'text', text: code.join('\n'), preserve: true, size: 9.5, shade: CODE_SHADE, dir: 'ltr', spaceBefore: 4, spaceAfter: 8 });
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length - 1;
      const runs = inlineRuns(heading[2] ?? '');
      const text = runs.map((r) => r.text).join('');
      title ??= level === 0 ? text : undefined;
      blocks.push(withRuns({ type: 'text', size: HEADING[level], bold: true, keepWithNext: true, spaceBefore: 10, spaceAfter: 6 }, runs));
      i += 1;
      continue;
    }
    // A setext heading: a paragraph underlined with = or -.
    if (paragraph.length > 0 && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      const level = line.trim().startsWith('=') ? 0 : 1;
      const runs = inlineRuns(paragraph.join(' '));
      paragraph = [];
      blocks.push(withRuns({ type: 'text', size: HEADING[level], bold: true, keepWithNext: true, spaceBefore: 10, spaceAfter: 6 }, runs));
      i += 1;
      continue;
    }
    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }
    // A table: a row, then a row of dashes and colons.
    const divider = lines[i + 1];
    if (line.includes('|') && divider !== undefined && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(divider)) {
      flush();
      const head = cells(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') body.push(cells(lines[i++]!));
      // GitHub's colons are left and right on the page: in an Arabic table, right is where a line starts.
      const rtl = dominantDirection([{ type: 'text', text: [...head, ...body.flat()].map(plain).join(' ') }]) === 'rtl';
      const [left, right]: BlockAlign[] = rtl ? ['end', 'start'] : ['start', 'end'];
      const aligns: (BlockAlign | undefined)[] = cells(divider).map((d) =>
        d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? right : d.startsWith(':') ? left : undefined,
      );
      const rows: TableCell[][] = [head.map((text, k) => ({ text: plain(text), bold: true, align: aligns[k] }))];
      for (const row of body) rows.push(head.map((_, k) => ({ text: plain(row[k] ?? ''), align: aligns[k] })));
      for (const row of rows) for (const cell of row) if (cell.align === undefined) delete cell.align;
      blocks.push({ type: 'table', rows, headerRows: 1, size: 10 });
      continue;
    }
    const item = /^(\s*)([-*+]|(\d{1,9})([.)]))\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const indent = item[1]!.replace(/\t/g, '    ').length;
      const ordered = item[3] !== undefined;
      while (lists.length > 0 && lists[lists.length - 1]!.indent > indent) lists.pop();
      let list = lists[lists.length - 1];
      if (!list || list.indent < indent || list.ordered !== ordered) {
        list = { indent, ordered, next: ordered ? Number(item[3]) : 1 };
        if (lists.length > 0 && lists[lists.length - 1]!.indent === indent) lists.pop();
        lists.push(list);
      }
      let text = item[5]!;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (task) text = `${task[1] === ' ' ? '☐' : '☑'} ${task[2]}`;
      marker = ordered ? `${list.next}${item[4]}` : ['•', '◦', '▪'][(lists.length - 1) % 3]!;
      list.next += 1;
      paragraph.push(text);
      i += 1;
      continue;
    }
    paragraph.push(line.trim());
    i += 1;
  }
  flush();
  return { blocks, pictures, title, picturesLeftOut: leftOut, truncated: false };
}
