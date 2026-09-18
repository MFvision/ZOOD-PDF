import { describe, expect, it } from 'vitest';
import type { ExportParagraph } from './paragraphs';
import { buildHtml, buildMarkdown, buildText, cleanText, escapeMarkdown } from './text';
import type { ExportPage } from './text';

const para = (text: string, direction: 'rtl' | 'ltr' = 'rtl', extra: Partial<ExportParagraph> = {}): ExportParagraph => ({
  text,
  direction,
  alignment: 'start',
  fontSize: 12,
  ...extra,
});

/** Two pages as the core reads them: Arabic in logical order, one English paragraph. */
const PAGES: ExportPage[] = [
  {
    number: 1,
    text: 'صباح الخير. يسعدني أن ألتقي بكم\nعبر شبكة الإنترنت.\n06/13/2021',
    paragraphs: [para('صباح الخير. يسعدني أن ألتقي بكم عبر شبكة الإنترنت.'), para('06/13/2021', 'ltr')],
  },
  {
    number: 2,
    text: 'والآن، يسعدني أن أتلقى أي أسئلة.',
    paragraphs: [para('والآن، يسعدني أن أتلقى أي أسئلة.', 'rtl', { alignment: 'center' })],
  },
];

const options = { title: 'تقرير', pageLabel: (page: number) => `Page ${page}` };
const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);

describe('plain text', () => {
  it('writes every page in reading order, each opened by its marker and set off by a blank line', () => {
    expect(buildText(PAGES)).toBe(
      '— 1 —\n\nصباح الخير. يسعدني أن ألتقي بكم\nعبر شبكة الإنترنت.\n06/13/2021\n\n— 2 —\n\nوالآن، يسعدني أن أتلقى أي أسئلة.\n',
    );
  });

  it('still marks a page that has no text', () => {
    expect(buildText([{ number: 1, text: '  \n', paragraphs: [] }, PAGES[1]!])).toBe('— 1 —\n\n— 2 —\n\nوالآن، يسعدني أن أتلقى أي أسئلة.\n');
  });

  it('leaves out control characters a broken font map puts in the text', () => {
    expect(buildText([{ number: 1, text: `كتاب${NUL}${BELL}\tجديد\r\nثانٍ`, paragraphs: [] }])).toBe('— 1 —\n\nكتاب\tجديد\nثانٍ\n');
  });
});

describe('cleanText', () => {
  it('keeps tabs, newlines, Arabic, marks and emoji, and replaces a lone surrogate', () => {
    const lone = String.fromCharCode(0xd83d);
    expect(cleanText(`الْعِلْمُ نُورٌ\t😀\n${lone}x${String.fromCharCode(0xfffe)}`)).toBe(`الْعِلْمُ نُورٌ\t😀\n${String.fromCharCode(0xfffd)}x`);
  });
});

describe('Markdown', () => {
  it('has a heading for the document and one for each page, and paragraphs as paragraphs', () => {
    expect(buildMarkdown(PAGES, options)).toBe(
      [
        '# تقرير',
        '## Page 1',
        'صباح الخير. يسعدني أن ألتقي بكم عبر شبكة الإنترنت.',
        '06/13/2021',
        '## Page 2',
        'والآن، يسعدني أن أتلقى أي أسئلة.',
      ].join('\n\n') + '\n',
    );
  });

  it('writes text that looks like markup as the text it is', () => {
    expect(escapeMarkdown('# ليس عنوانًا')).toBe('\\# ليس عنوانًا');
    expect(escapeMarkdown('1. ليس قائمة')).toBe('1\\. ليس قائمة');
    expect(escapeMarkdown('- ولا هذا')).toBe('\\- ولا هذا');
    expect(escapeMarkdown('> ولا اقتباس')).toBe('\\> ولا اقتباس');
    expect(escapeMarkdown('a *b* _c_ [d](e) <f> `g` ~h~ &amp; \\')).toBe('a \\*b\\* \\_c\\_ \\[d\\](e) \\<f> \\`g\\` \\~h\\~ \\&amp; \\\\');
    expect(escapeMarkdown('الإجمالي: 3,450.00 ر.س - شامل')).toBe('الإجمالي: 3,450.00 ر.س - شامل');
  });
});

describe('HTML', () => {
  const html = buildHtml(PAGES, options);

  it('declares UTF-8 and runs right to left when most of the text does', () => {
    expect(html.startsWith('<!DOCTYPE html>\n<html dir="rtl">')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>تقرير</title>');
  });

  it('gives Arabic paragraphs dir="rtl" and the rest dir="auto", with a heading per page', () => {
    expect(html).toContain('<p dir="rtl">صباح الخير. يسعدني أن ألتقي بكم عبر شبكة الإنترنت.</p>');
    expect(html).toContain('<p dir="auto">06/13/2021</p>');
    expect(html).toContain('<p dir="rtl" class="center">والآن، يسعدني أن أتلقى أي أسئلة.</p>');
    expect(html.match(/<h2 dir="auto">Page \d<\/h2>/g)).toEqual(['<h2 dir="auto">Page 1</h2>', '<h2 dir="auto">Page 2</h2>']);
  });

  it('reaches nothing outside itself: no script, no link, no source, no URL', () => {
    expect(html).not.toMatch(/<script|<link|<img|<iframe|\bsrc=|\bhref=|url\(|@import|https?:/i);
  });

  it('escapes the text, so a paragraph cannot become markup', () => {
    const page: ExportPage = { number: 1, text: 'x', paragraphs: [para('<script>alert("x")</script> & \'y\'', 'ltr')] };
    const escaped = buildHtml([page], { ...options, title: 'a<b' });
    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62; &#38; &#39;y&#39;');
    expect(escaped).toContain('<title>a&#60;b</title>');
    expect(escaped.startsWith('<!DOCTYPE html>\n<html dir="ltr">')).toBe(true);
  });
});
