import type { TextDirection, TextLink } from '../core/types';
import type { ExportParagraph } from './paragraphs';
import { linkedPieces, pageBlocks } from './structure';
import type { ExportCell, ExportTable } from './structure';

/** One page of a text export, as Warraq's core reads it. */
export interface ExportPage {
  /** One-based, as a person counts pages. */
  number: number;
  /** The page's lines in reading order, joined by "\n" (`extract_text`). */
  text: string;
  /** The same text as paragraphs (`paragraphsOf`), without the text of its tables. */
  paragraphs: ExportParagraph[];
  /** The tables found on it, which `paragraphs` leave out. */
  tables?: ExportTable[];
}

/** What the page headings of Markdown and HTML say, in the interface's language. */
export interface TextExportOptions {
  /** The document's name, without the ".pdf". */
  title: string;
  /** "Page 3" or "الصفحة 3". */
  pageLabel: (page: number) => string;
}

/**
 * Text as it may appear in any file Warraq writes: a PDF's text can carry
 * control characters (a broken ToUnicode maps glyphs to U+0000) that XML
 * forbids outright — one of them makes Word refuse the whole document — and
 * lone surrogates that no encoder can write.
 */
export function cleanText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // A list's bullet drawn from a symbol font (Word's Symbol and Wingdings,
      // LibreOffice's OpenSymbol) reads as a private-use character, which no
      // other font draws: the bullet it stands for.
      .replace(SYMBOL_BULLETS, (c) => BULLETS[c] ?? c)
      // Every C0 control except tab and newline, DEL, and the two non-characters XML excludes.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
  );
}

/** Symbol-font bullets, and what they look like. */
const BULLETS: Record<string, string> = {
  '\uF0B7': '•',
  '\uF06C': '•',
  '\uF09F': '•',
  '\uF0A7': '▪',
  '\uF06E': '■',
  '\uF0A8': '□',
  '\uF0D8': '➢',
  '\uF0E0': '➢',
  '\uF076': '❖',
  '\uF0FC': '✓',
  '\uF02D': '-',
};
const SYMBOL_BULLETS = /[\uF0B7\uF06C\uF09F\uF0A7\uF06E\uF0A8\uF0D8\uF0E0\uF076\uF0FC\uF02D]/g;

/** A paragraph's text on one line: the lines it was drawn on joined, spacing kept. */
function oneLine(text: string): string {
  return cleanText(text).replace(/[\t\n]+/g, ' ').trim();
}

/** "— 2 —": the page marker of a text export, the same in every language. */
export function pageMarker(page: number): string {
  return `— ${page} —`;
}

/**
 * Plain text: every page's lines in reading order, each page opened by its
 * marker and set off by a blank line.
 */
export function buildText(pages: readonly ExportPage[]): string {
  return pages
    .map((page) => {
      const text = (page.tables?.length ? textWithTables(page) : cleanText(page.text)).trim();
      return text.length > 0 ? `${pageMarker(page.number)}\n\n${text}\n` : `${pageMarker(page.number)}\n`;
    })
    .join('\n');
}

/** A cell's text on one line, without tabs: a tab is what parts cells. */
function cellText(cell: ExportCell | null): string {
  return cell ? oneLine(cell.text).replace(/\t/g, ' ') : '';
}

/**
 * A page that has tables, as text: each paragraph's lines as they were,
 * and each table a row to a line, its cells parted by tabs (so it pastes
 * into a spreadsheet as a table), a blank line before and after.
 */
function textWithTables(page: ExportPage): string {
  const out: string[] = [];
  for (const block of pageBlocks(page.paragraphs, page.tables ?? [])) {
    if (block.kind === 'paragraph') {
      const lines = block.paragraph.lines?.map((line) => cleanText(line.text).trim()) ?? [cleanText(block.paragraph.text)];
      out.push(lines.join('\n'));
    } else {
      out.push('', block.table.rows.map((row) => row.map(cellText).join('\t').replace(/\t+$/, '')).join('\n'), '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Backslash-escapes what Markdown would read as markup, so a paragraph that
 * happens to start with "1." or "#", or holds a "*", comes out as written.
 */
export function escapeMarkdown(text: string): string {
  return oneLine(text)
    .replace(/[\\`*_[\]<~]/g, '\\$&')
    .replace(/&(?=#?\w+;)/g, '\\&')
    .replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^[#>+=-]/, '\\$&');
}

/** A link's address as Markdown can hold it: no spaces or brackets to end it early. */
function markdownAddress(uri: string): string {
  return uri.replace(/[\s()<>]/g, (c) => encodeURIComponent(c));
}

/** Text with its links as Markdown links, escaped. */
function markdownText(text: string, links: readonly TextLink[] | undefined): string {
  const line = oneLine(text);
  if (!links?.length || line !== text) return escapeMarkdown(text);
  return linkedPieces(text, links)
    .map((piece, k) => {
      // Only the start of the paragraph may look like a list or a heading.
      const escaped = k === 0 ? escapeMarkdown(piece.text) : escapeMarkdown(`x${piece.text}`).slice(1);
      const spaced = piece.text.startsWith(' ') && k > 0 ? ' ' : '';
      const trailing = piece.text.endsWith(' ') ? ' ' : '';
      return piece.uri ? `${spaced}[${escaped}](${markdownAddress(piece.uri)})${trailing}` : `${spaced}${escaped}${trailing}`;
    })
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * A table as Markdown's pipe table: its first row the header, as Markdown
 * wants one. A merged cell keeps its text in its first cell.
 */
function markdownTable(table: ExportTable): string {
  const columns = Math.max(1, ...table.rows.map((row) => row.length));
  const cell = (c: ExportCell | null) => (c ? markdownText(oneLine(c.text), c.links).replace(/\|/g, '\\|') : '');
  const row = (cells: (ExportCell | null)[]) => `| ${Array.from({ length: columns }, (_, k) => cell(cells[k] ?? null)).join(' | ')} |`;
  const [head = [], ...body] = table.rows;
  return [row(head), `|${' --- |'.repeat(columns)}`, ...body.map(row)].join('\n');
}

/** Markdown: a heading for the document, one for each page, and its paragraphs and tables. */
export function buildMarkdown(pages: readonly ExportPage[], options: TextExportOptions): string {
  const blocks = [`# ${escapeMarkdown(options.title)}`];
  for (const page of pages) {
    blocks.push(`## ${escapeMarkdown(options.pageLabel(page.number))}`);
    for (const block of pageBlocks(page.paragraphs, page.tables ?? [])) {
      if (block.kind === 'table') {
        blocks.push(markdownTable(block.table));
        continue;
      }
      const text = markdownText(block.paragraph.text, block.paragraph.links);
      if (text.length > 0) blocks.push(text);
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The direction most of the document's text runs in; Arabic when there is none. */
export function dominantDirection(pages: readonly ExportPage[]): TextDirection {
  let rtl = 0;
  let ltr = 0;
  for (const page of pages) {
    for (const paragraph of page.paragraphs) {
      if (paragraph.direction === 'rtl') rtl += paragraph.text.length;
      else ltr += paragraph.text.length;
    }
  }
  return ltr > rtl ? 'ltr' : 'rtl';
}

const ALIGN_CLASS = { start: '', end: ' class="end"', center: ' class="center"', justify: ' class="justify"' } as const;

/** Text with its links as `<a>`; only web and mail addresses ever reach here. */
function htmlText(text: string, links: readonly TextLink[] | undefined): string {
  return linkedPieces(text, links)
    .map((piece) => (piece.uri ? `<a href="${escapeHtml(piece.uri)}">${escapeHtml(piece.text)}</a>` : escapeHtml(piece.text)))
    .join('');
}

/** A table as a table, merged cells merged, in its own direction. */
function htmlTable(table: ExportTable): string {
  const rows = table.rows.map((row, r) => {
    const cells = row.flatMap((cell) => {
      if (!cell) return [];
      const span = `${cell.columns > 1 ? ` colspan="${cell.columns}"` : ''}${cell.rows > 1 ? ` rowspan="${cell.rows}"` : ''}`;
      const tag = r === 0 ? 'th' : 'td';
      return [`<${tag}${span}>${htmlText(oneLine(cell.text), cell.links)}</${tag}>`];
    });
    return `<tr>${cells.join('')}</tr>`;
  });
  return `<table dir="${table.direction}">\n${rows.join('\n')}\n</table>`;
}

/**
 * A web page of the text: each paragraph carries its own direction (`rtl`, or
 * `auto` for the rest, so the browser reads it from the text), with a heading
 * per page. Self-contained on purpose — no script, no font, no stylesheet or
 * image from anywhere else — so opening it reaches no one.
 */
export function buildHtml(pages: readonly ExportPage[], options: TextExportOptions): string {
  const title = escapeHtml(oneLine(options.title));
  const sections = pages.map((page) => {
    const paragraphs = pageBlocks(page.paragraphs, page.tables ?? []).flatMap((block) => {
      if (block.kind === 'table') return [htmlTable(block.table)];
      const { paragraph } = block;
      const text = oneLine(paragraph.text);
      if (text.length === 0) return [];
      const dir = paragraph.direction === 'rtl' ? 'rtl' : 'auto';
      // Links only where the text is as the paragraph had it, so their places hold.
      const links = text === paragraph.text ? paragraph.links : undefined;
      return [`<p dir="${dir}"${ALIGN_CLASS[paragraph.alignment]}>${htmlText(text, links)}</p>`];
    });
    const heading = `<h2 dir="auto">${escapeHtml(options.pageLabel(page.number))}</h2>`;
    return ['<section>', heading, ...paragraphs, '</section>'].join('\n');
  });
  return [
    '<!DOCTYPE html>',
    `<html dir="${dominantDirection(pages)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    '<style>',
    'body { max-inline-size: 48rem; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, "Segoe UI", Arial, sans-serif; line-height: 1.7; }',
    'h2 { margin-block-start: 2.5rem; font-size: 1rem; color: #5f6772; }',
    'section + section { break-before: page; }',
    '.center { text-align: center; } .end { text-align: end; } .justify { text-align: justify; }',
    'table { border-collapse: collapse; margin-block: 1rem; } th, td { border: 1px solid #c8ccd2; padding: 0.25rem 0.5rem; text-align: start; vertical-align: top; }',
    '</style>',
    '</head>',
    '<body>',
    `<h1 dir="auto">${title}</h1>`,
    ...sections,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
