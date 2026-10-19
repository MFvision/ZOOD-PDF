import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildDocx } from './docx';
import { buildLayoutDocx, wordPage } from './docxLayout';
import { WORDPROCESSING, validate } from './ooxml.testing';
import type { Slide, SlideText } from './pptx';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const text = (extra: Partial<SlideText> = {}): SlideText => ({
  x: 300,
  y: 80,
  width: 200,
  height: 20,
  lines: ['فاتورة ضريبية مبسطة'],
  direction: 'rtl',
  alignment: 'start',
  size: 18,
  pitch: null,
  color: '1a4f8b',
  ...extra,
});

const pages: Slide[] = [
  {
    width: 595,
    height: 842,
    picture: PNG,
    texts: [
      text({ font: { family: 'Cairo', weight: 700, italic: false } }),
      text({ x: 60, lines: ['Invoice <No. 42> & co', 'second line'], direction: 'ltr', alignment: 'end', size: 11, pitch: 14, color: '000000' }),
      text({ x: 10, y: 300, width: 12, height: 200, lines: ['Public Disclosure Authorized'], direction: 'ltr', vertical: true }),
      text({ y: 700, lines: ['محفوظ في الصورة'], hidden: true }),
    ],
    hiddenText: false,
  },
  { width: 842, height: 595, picture: null, texts: [text()], hiddenText: false },
  { width: 595, height: 842, picture: PNG, texts: [text({ lines: ['نص ممسوح'] })], hiddenText: true },
];

describe('Word with the layout kept', () => {
  const parts = unzipSync(buildLayoutDocx(pages));
  const xml = strFromU8(parts['word/document.xml']!);

  it('writes parts Word accepts, in the order ECMA-376 sets', () => {
    for (const name of ['word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', '[Content_Types].xml', '_rels/.rels']) {
      expect(validate(strFromU8(parts[name]!), WORDPROCESSING), name).toEqual([]);
    }
    expect(strFromU8(parts['[Content_Types].xml']!)).toContain('Extension="png"');
  });

  it('puts each page picture behind the page, and only the pages that have one', () => {
    expect(Object.keys(parts).filter((name) => name.startsWith('word/media/'))).toEqual(['word/media/page1.png', 'word/media/page3.png']);
    expect(xml.match(/behindDoc="1"/g)).toHaveLength(2);
    const rels = strFromU8(parts['word/_rels/document.xml.rels']!);
    expect(rels).toContain('Id="rIdPicture1"');
    expect(rels).toContain('Target="media/page3.png"');
  });

  it('gives every page its own size and section, the landscape one turned', () => {
    expect(xml.match(/<w:sectPr>/g)).toHaveLength(3);
    expect(xml).toContain('<w:pgSz w:w="16840" w:h="11900" w:orient="landscape"/>');
    expect(xml).toContain('w:top="0" w:right="0" w:bottom="0" w:left="0"');
  });

  it('sets each text box in its face, weight, size and colour, right to left where it is Arabic', () => {
    expect(xml.match(/<wps:wsp>/g)).toHaveLength(6);
    expect(xml).toContain('<w:rFonts w:ascii="Cairo" w:hAnsi="Cairo" w:eastAsia="Cairo" w:cs="Cairo"/><w:b/><w:bCs/><w:color w:val="1A4F8B"/><w:sz w:val="36"/><w:szCs w:val="36"/><w:rtl/>');
    expect(xml).toMatch(/<w:bidi\/><w:spacing [^>]*\/><w:rPr>/);
    // A face the file does not name is Arial; Latin end-aligned text is right-aligned.
    expect(xml).toContain('w:ascii="Arial"');
    expect(xml).toContain('<w:jc w:val="right"/>');
    // Lines break where the page broke them, the text escaped.
    expect(xml).toContain('<w:t xml:space="preserve">Invoice &lt;No. 42&gt; &amp; co</w:t></w:r><w:r>');
    expect(xml).toContain('<w:br/><w:t xml:space="preserve">second line</w:t>');
    expect(xml).toContain('w:line="280" w:lineRule="exact"');
  });

  it('turns text set up the page, and keeps text already in the picture, or a scan’s, without drawing it again', () => {
    expect(xml).toContain('<a:xfrm rot="16200000">');
    const invisible = xml.match(/<w14:textFill><w14:noFill\/><\/w14:textFill>/g) ?? [];
    // The hidden paragraph and the scan's text: in each run and paragraph mark.
    expect(invisible.length).toBe(4);
    expect(xml).toContain('محفوظ في الصورة');
  });

  it('keeps a page within Word’s limits, scaled to fit', () => {
    expect(wordPage({ width: 3000, height: 1000 })).toEqual({ width: 1584, height: 528, scale: 0.528 });
    expect(wordPage({ width: 595, height: 842 }).scale).toBe(1);
  });
});

describe('Word as flowing text', () => {
  it('writes a document Word accepts', () => {
    const parts = unzipSync(buildDocx([{ number: 1, text: 'سلام', paragraphs: [{ text: 'سلام', direction: 'rtl', alignment: 'start', fontSize: 12 }] }]));
    expect(validate(strFromU8(parts['word/document.xml']!), WORDPROCESSING)).toEqual([]);
  });
});
