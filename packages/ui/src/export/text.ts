import type { TextDirection } from '../core/types';
import type { ExportParagraph } from './paragraphs';

/** One page of a text export, as Warraq's core reads it. */
export interface ExportPage {
  /** One-based, as a person counts pages. */
  number: number;
  /** The page's lines in reading order, joined by "\n" (`extract_text`). */
  text: string;
  /** The same text as paragraphs (`paragraphsOf`). */
  paragraphs: ExportParagraph[];
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
      // Every C0 control except tab and newline, DEL, and the two non-characters XML excludes.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
  );
}

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
      const text = cleanText(page.text).trim();
      return text.length > 0 ? `${pageMarker(page.number)}\n\n${text}\n` : `${pageMarker(page.number)}\n`;
    })
    .join('\n');
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

/** Markdown: a heading for the document, one for each page, and its paragraphs. */
export function buildMarkdown(pages: readonly ExportPage[], options: TextExportOptions): string {
  const blocks = [`# ${escapeMarkdown(options.title)}`];
  for (const page of pages) {
    blocks.push(`## ${escapeMarkdown(options.pageLabel(page.number))}`);
    for (const paragraph of page.paragraphs) {
      const text = escapeMarkdown(paragraph.text);
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

/**
 * A web page of the text: each paragraph carries its own direction (`rtl`, or
 * `auto` for the rest, so the browser reads it from the text), with a heading
 * per page. Self-contained on purpose — no script, no font, no stylesheet or
 * image from anywhere else — so opening it reaches no one.
 */
export function buildHtml(pages: readonly ExportPage[], options: TextExportOptions): string {
  const title = escapeHtml(oneLine(options.title));
  const sections = pages.map((page) => {
    const paragraphs = page.paragraphs.flatMap((paragraph) => {
      const text = oneLine(paragraph.text);
      if (text.length === 0) return [];
      const dir = paragraph.direction === 'rtl' ? 'rtl' : 'auto';
      return [`<p dir="${dir}"${ALIGN_CLASS[paragraph.alignment]}>${escapeHtml(text)}</p>`];
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
