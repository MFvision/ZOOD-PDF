import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildDocx, documentXml } from './docx';
import type { ExportParagraph } from './paragraphs';
import type { ExportPage } from './text';

/**
 * A strict enough XML well-formedness check for what the builder writes:
 * nesting, attribute syntax and uniqueness, entity references, characters XML
 * forbids, one root. Word refuses a document that fails any of these.
 */
function assertWellFormed(xml: string): void {
  const forbidden = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(8) + String.fromCharCode(11, 12) + String.fromCharCode(14) + '-' + String.fromCharCode(31) + ']');
  if (forbidden.test(xml)) throw new Error('a character XML forbids');
  const checkText = (text: string) => {
    for (let at = text.indexOf('&'); at >= 0; at = text.indexOf('&', at + 1)) {
      if (!/^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/.test(text.slice(at))) throw new Error(`a bare & at ${at}`);
    }
    if (text.includes('<')) throw new Error('a < in text');
  };
  let i = 0;
  if (xml.startsWith('<?xml')) i = xml.indexOf('?>') + 2;
  const stack: string[] = [];
  let roots = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    checkText(text);
    if (stack.length === 0 && text.trim() !== '') throw new Error('text outside the root element');
    if (lt < 0) break;
    if (xml.startsWith('</', lt)) {
      const close = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(xml.slice(lt));
      if (!close) throw new Error(`a broken end tag at ${lt}`);
      if (stack.pop() !== close[1]) throw new Error(`</${close[1]}> closes the wrong element`);
      i = lt + close[0].length;
      continue;
    }
    const open = /^<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(xml.slice(lt));
    if (!open) throw new Error(`a broken start tag at ${lt}`);
    const names = [...open[2]!.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => {
      checkText(m[2] ?? m[3] ?? '');
      return m[1];
    });
    if (new Set(names).size !== names.length) throw new Error(`a repeated attribute on <${open[1]}>`);
    if (stack.length === 0) roots += 1;
    if (open[3] !== '/') stack.push(open[1]!);
    i = lt + open[0].length;
  }
  if (stack.length > 0) throw new Error(`<${stack[stack.length - 1]}> is never closed`);
  if (roots !== 1) throw new Error(`${roots} root elements`);
}

const para = (text: string, direction: 'rtl' | 'ltr' = 'rtl', extra: Partial<ExportParagraph> = {}): ExportParagraph => ({
  text,
  direction,
  alignment: 'start',
  fontSize: null,
  ...extra,
});

const PAGES: ExportPage[] = [
  {
    number: 1,
    text: '',
    paragraphs: [
      para('كلمة رئيس مجموعة البنك الدولي', 'rtl', { alignment: 'center', fontSize: 16 }),
      para('06/13/2021', 'ltr', { alignment: 'end' }),
      para('صباح الخير. يسعدني أن ألتقي بكم عبر شبكة الإنترنت.', 'rtl', { alignment: 'justify', fontSize: 13.56 }),
    ],
  },
  { number: 2, text: '', paragraphs: [para('والآن، يسعدني أن أتلقى أي أسئلة.')] },
];

function unpack(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, data]) => [name, strFromU8(data)]));
}

/** Each `<w:p>…</w:p>` of the body, in order. */
function paragraphsIn(xml: string): string[] {
  return xml.match(/<w:p>.*?<\/w:p>/g) ?? [];
}

describe('the well-formedness check itself', () => {
  it('rejects what Word would reject', () => {
    expect(() => assertWellFormed('<a><b></a></b>')).toThrow();
    expect(() => assertWellFormed('<a>&</a>')).toThrow();
    expect(() => assertWellFormed('<a x="1" x="2"/>')).toThrow();
    expect(() => assertWellFormed(`<a>${String.fromCharCode(0)}</a>`)).toThrow();
    expect(() => assertWellFormed('<a/><b/>')).toThrow();
    expect(() => assertWellFormed('<a><b>')).toThrow();
    expect(() => assertWellFormed('<?xml version="1.0"?><a x="&amp;">&#1604;<b/></a>')).not.toThrow();
  });
});

describe('Word export', () => {
  const files = unpack(buildDocx(PAGES, [595.28, 841.89]));
  const xml = files['word/document.xml']!;

  it('is a zip of the parts a .docx needs, all well-formed UTF-8 XML', () => {
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
    for (const [name, content] of Object.entries(files)) {
      expect(content.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), name).toBe(true);
      expect(() => assertWellFormed(content), name).not.toThrow();
    }
    expect(files['[Content_Types].xml']).toContain('PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"');
    expect(files['_rels/.rels']).toContain('Target="word/document.xml"');
    expect(files['word/_rels/document.xml.rels']).toContain('Target="styles.xml"');
  });

  it('holds the Arabic text in reading order, exactly as the core read it', () => {
    expect(xml).toContain('<w:t xml:space="preserve">صباح الخير. يسعدني أن ألتقي بكم عبر شبكة الإنترنت.</w:t>');
    expect(xml.indexOf('كلمة رئيس')).toBeLessThan(xml.indexOf('صباح الخير'));
    expect(xml.indexOf('صباح الخير')).toBeLessThan(xml.indexOf('والآن'));
  });

  it('marks right-to-left paragraphs w:bidi and their runs w:rtl, and leaves left-to-right ones alone', () => {
    const paragraphs = paragraphsIn(xml);
    expect(paragraphs).toHaveLength(4);
    const [title, date, body, last] = paragraphs as [string, string, string, string];
    for (const rtl of [title, body, last]) {
      expect(rtl).toContain('<w:bidi/>');
      expect(rtl).toMatch(/<w:rPr>(?:(?!<\/w:rPr>).)*<w:rtl\/><\/w:rPr>/);
    }
    expect(date).not.toContain('<w:bidi/>');
    expect(date).not.toContain('<w:rtl/>');
  });

  it('starts every PDF page after the first on a new Word page', () => {
    const paragraphs = paragraphsIn(xml);
    expect(xml.match(/<w:pageBreakBefore\/>/g)).toHaveLength(PAGES.length - 1);
    expect(paragraphs[3]).toContain('<w:pPr><w:pageBreakBefore/><w:bidi/></w:pPr>');
  });

  it('keeps alignment and type size, in Word terms', () => {
    const [title, date, body] = paragraphsIn(xml) as [string, string, string];
    expect(title).toContain('<w:jc w:val="center"/>');
    expect(title).toContain('<w:sz w:val="32"/><w:szCs w:val="32"/>');
    // Word reads w:jc logically: "right" is the end of the line.
    expect(date).toContain('<w:jc w:val="right"/>');
    expect(body).toContain('<w:jc w:val="both"/>');
    expect(body).toContain('<w:sz w:val="27"/>');
  });

  it('sets a face with Arabic letters for every script, and the page size of the PDF', () => {
    expect(files['word/styles.xml']).toContain('<w:rFonts w:ascii="Arial" w:eastAsia="Arial" w:hAnsi="Arial" w:cs="Arial"/>');
    expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    const landscape = documentXml(PAGES, [842, 595]);
    expect(landscape).toContain('<w:pgSz w:w="16840" w:h="11900" w:orient="landscape"/>');
    // A size Word cannot have falls back to A4.
    expect(documentXml(PAGES, [5000, 20])).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
  });

  it('stays well-formed whatever the text holds, and gives an empty page its page', () => {
    const hostile: ExportPage[] = [
      { number: 1, text: '', paragraphs: [para(`<w:p> & ]]> "x" ${String.fromCharCode(0)}${String.fromCharCode(0xffff)}\tتبويب`)] },
      { number: 2, text: '', paragraphs: [] },
      { number: 3, text: '', paragraphs: [para('   ')] },
    ];
    const content = documentXml(hostile);
    expect(() => assertWellFormed(content)).not.toThrow();
    expect(content).toContain('<w:t xml:space="preserve">&lt;w:p&gt; &amp; ]]&gt; "x" </w:t><w:tab/><w:t xml:space="preserve">تبويب</w:t>');
    const paragraphs = paragraphsIn(content);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[1]).toBe('<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>');
    expect(paragraphs[2]).toBe('<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>');
  });
});
