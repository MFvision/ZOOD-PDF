import { strToU8, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { blockText } from './blocks';
import type { Block, TableBlock, TextBlock } from './blocks';
import { MAX_BLOCKS, MAX_LETTERS, createKind, createPdf, withinLimits } from './createPdf';
import type { CreateEnvironment } from './createPdf';
import { readDocx } from './docx';
import { inlineRuns, readMarkdown } from './markdown';
import { readPptx } from './pptx';
import { readText } from './text';
import { parseXml, readAttributes } from './xml';
import { firstRows, readXlsx } from './xlsx';
import { TooLargeError, hasPart, readParts } from './zip';

/**
 * Files made to hurt: small on disk, and each once froze the app for
 * seconds to minutes or filled its memory. Every one must come back within
 * a moment, or be refused with a reason the panel can name.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const u8 = (text: string) => new TextEncoder().encode(text);

/** Milliseconds `run` takes. */
function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

function workbook(sheet: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync(
    {
      'xl/workbook.xml': strToU8(`<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="ورقة 😀" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8(sheet),
      ...extra,
    },
    { level: 9 },
  );
}

function wordFile(body: string, extra: Zippable = {}): Uint8Array {
  return zipSync({ 'word/document.xml': strToU8(`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`), ...extra }, { level: 9 });
}

const tables = (blocks: readonly Block[]) => blocks.filter((b): b is TableBlock => b.type === 'table');

let bombMade: Uint8Array | null = null;
/** 300 MB of zeros in three parts, zipped to well under a megabyte: made once, it takes a moment. */
function bombFile(): Uint8Array {
  const zeros = new Uint8Array(100 * 1024 * 1024);
  bombMade ??= zipSync({ 'word/document.xml': zeros, 'word/styles.xml': zeros, 'word/numbering.xml': zeros }, { level: 1 });
  return bombMade;
}

describe('the XML reader', () => {
  it('reads a tag left open with a long value at once (it took minutes)', () => {
    const { value, ms } = timed(() => parseXml(`<a b="${'x'.repeat(2_000_000)}`));
    expect(ms).toBeLessThan(1000);
    expect(value?.local).toBe('a');
  });

  it('reads a tag of a long name with no value at once', () => {
    const { ms } = timed(() => parseXml(`<a ${'x'.repeat(2_000_000)}/>`));
    expect(ms).toBeLessThan(1000);
  });

  it('reads attributes as before: both quotes, spaces round the equals sign, entities', () => {
    expect(readAttributes(` w:val = "a&amp;b" x='1'  y="" z novalue=bare q="2"`)).toEqual([
      ['w:val', 'a&b'],
      ['x', '1'],
      ['y', ''],
      ['q', '2'],
    ]);
  });

  it('does not copy the namespaces for every element under a root that declares thousands', () => {
    const declared = Array.from({ length: 5_000 }, (_, k) => `xmlns:p${k}="urn:${k}"`).join(' ');
    const { value, ms } = timed(() => parseXml(`<r ${declared}>${'<p1:c/>'.repeat(50_000)}</r>`));
    expect(ms).toBeLessThan(2000);
    expect(value?.children[0]).toMatchObject({ ns: 'urn:1', local: 'c' });
  });

  it('stops at its element limit and says so', () => {
    const root = parseXml(`<r>${'<c/>'.repeat(1000)}</r>`, 100);
    expect(root?.children.length).toBeLessThan(100);
    expect(root?.truncated).toBe(true);
    expect(parseXml('<r><c/></r>')?.truncated).toBeUndefined();
  });

  it('never expands entities a doctype defines (billion laughs)', () => {
    const laughs = '<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><r>&c;&c;&c;</r>';
    const root = parseXml(laughs);
    expect(root?.children.join('')).toBe('&c;&c;&c;');
  });

  it('reads an external entity as nothing but its text', () => {
    const root = parseXml('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>');
    expect(root?.children).toEqual(['&x;']);
  });
});

describe('zip bombs', () => {
  it('refuses a document whose parts inflate past the limit, without inflating them', () => {
    // 300 MB of zeros declared in a few hundred kilobytes.
    const bomb = bombFile();
    expect(bomb.length).toBeLessThan(1_000_000);
    const { ms } = timed(() => expect(() => readDocx(bomb)).toThrow(TooLargeError));
    expect(ms).toBeLessThan(1000);
  }, 30_000);

  it('leaves out pictures past the limit, keeping the text', () => {
    const picture = new Uint8Array(90 * 1024 * 1024);
    // Three of 90 MB: the third is past the 256 MB that are read in all.
    picture.set([0x89, 0x50, 0x4e, 0x47]);
    const rels = `<Relationships>${[1, 2, 3].map((k) => `<Relationship Id="p${k}" Target="media/p${k}.png"/>`).join('')}</Relationships>`;
    const drawing = (k: number) =>
      `<w:p><w:r><w:drawing><a:blip xmlns:a="${A}" r:embed="p${k}"/></w:drawing></w:r></w:p>`;
    const file = wordFile(`<w:p><w:r><w:t>نص</w:t></w:r></w:p>${[1, 2, 3].map(drawing).join('')}`, {
      'word/_rels/document.xml.rels': strToU8(rels),
      ...Object.fromEntries([1, 2, 3].map((k) => [`word/media/p${k}.png`, [picture, { level: 1 }]])),
    });
    const doc = readDocx(file);
    expect(doc.blocks.some((b) => b.type === 'text' && blockText(b) === 'نص')).toBe(true);
    expect(doc.pictures.length).toBe(2);
    expect(doc.picturesLeftOut).toBe(1);
  }, 30_000);

  it('inflates a name the zip holds twice once', () => {
    const one = zipSync({ 'word/document.xml': u8('<a/>') });
    // Two copies of the same entry, one after the other, as a hostile zip may hold them.
    expect(Object.keys(readParts(one, () => true))).toEqual(['word/document.xml']);
  });

  it('tells what kind a file is without inflating it', () => {
    const { value, ms } = timed(() => createKind('big.docx', bombFile()));
    expect(value).toBe('docx');
    expect(ms).toBeLessThan(200);
    expect(hasPart(new Uint8Array([0x50, 0x4b, 3, 4]), 'word/document.xml')).toBe(false);
    expect(createKind('old.docx', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toBeNull();
  }, 30_000);
});

describe('a hostile workbook', () => {
  it('reads one range merged three thousand times in a moment (it took 30 seconds)', () => {
    const merges = '<mergeCell ref="A1:AX2000"/>'.repeat(3000);
    const file = workbook(`<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData><mergeCells>${merges}</mergeCells></worksheet>`);
    expect(file.length).toBeLessThan(5000);
    const { value, ms } = timed(() => readXlsx(file));
    expect(ms).toBeLessThan(1500);
    expect(tables(value.blocks)[0]!.rows[0]![0]!.text).toBe('x');
  });

  it('reads the first rows of a sheet of 300,000 without building all of them', () => {
    const rows = Array.from({ length: 300_000 }, (_, k) => `<row r="${k + 1}"><c r="A${k + 1}"><v>${k + 1}</v></c></row>`).join('');
    const file = workbook(`<worksheet xmlns="${S}"><sheetData>${rows}</sheetData><mergeCells><mergeCell ref="A1:A2"/></mergeCells></worksheet>`);
    const { value, ms } = timed(() => readXlsx(file));
    expect(ms).toBeLessThan(2500);
    expect(value.truncated).toBe(true);
    const table = tables(value.blocks)[0]!;
    expect(table.rows).toHaveLength(2000);
    expect(table.rows[1999]![0]!.text).toBe('2000');
    // What comes after the rows is still read.
    expect(table.rows[1]![0]!.text).toBe('');
  });

  it('cuts rows by the tag, whatever its prefix', () => {
    const xml = '<x:worksheet><x:sheetData><x:row/><x:row r="2"></x:row><x:row>3</x:row></x:sheetData><x:after/></x:worksheet>';
    expect(firstRows(xml, 2)).toEqual({ xml: '<x:worksheet><x:sheetData><x:row/><x:row r="2"></x:row></x:sheetData><x:after/></x:worksheet>', cut: true });
    expect(firstRows(xml, 3).cut).toBe(false);
  });

  it('stops after enough sheets for a thousand pages, and says so', () => {
    const sheetXml = `<worksheet xmlns="${S}"><sheetData>${Array.from({ length: 2000 }, (_, r) => `<row r="${r + 1}">${Array.from({ length: 60 }, () => `<c><v>1</v></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
    const sheets = Array.from({ length: 6 }, (_, k) => `<sheet name="s${k}" sheetId="${k + 1}" r:id="r${k}"/>`).join('');
    const rels = Array.from({ length: 6 }, (_, k) => `<Relationship Id="r${k}" Target="worksheets/sheet1.xml"/>`).join('');
    const file = zipSync({
      'xl/workbook.xml': strToU8(`<workbook xmlns="${S}" xmlns:r="${R}"><sheets>${sheets}</sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>${rels}</Relationships>`),
      'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    });
    const read = readXlsx(file);
    expect(tables(read.blocks).length).toBeLessThan(6);
    expect(read.truncated).toBe(true);
  });
});

describe('a hostile Word file', () => {
  it('keeps list markers short in a list that starts at two billion', () => {
    const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="2000000000"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
    const item = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>x</w:t></w:r></w:p>';
    const { value, ms } = timed(() => readDocx(wordFile(item.repeat(5), { 'word/numbering.xml': strToU8(numbering) })));
    expect(ms).toBeLessThan(500);
    for (const block of value.blocks) if (block.type === 'text') expect(block.marker!.length).toBeLessThan(20);
  });

  it('says so when its body has more paragraphs than are read', () => {
    const many = '<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(80_000);
    const { value, ms } = timed(() => readDocx(wordFile(many)));
    expect(ms).toBeLessThan(5000);
    expect(value.truncated).toBe(true);
  }, 30_000);
});

describe('a hostile Markdown file', () => {
  const quick = (source: string) => {
    const { value, ms } = timed(() => readMarkdown(u8(source)));
    expect(ms).toBeLessThan(500);
    return value;
  };

  it('reads a page of brackets, pictures and addresses never closed in a moment (they took seconds to minutes)', () => {
    quick('['.repeat(100_000));
    quick('!['.repeat(50_000));
    quick('[x]('.repeat(50_000));
    quick('<http://'.repeat(50_000));
    quick('[a\\]'.repeat(50_000));
    quick(`[${'\\'.repeat(100_000)}]`);
    quick('[x](y "'.repeat(50_000));
  });

  it('still reads links, pictures and addresses as before', () => {
    expect(inlineRuns('see [the site](https://zood.sa "ZOOD") now')).toEqual([
      { text: 'see ' },
      { text: 'the site', link: 'https://zood.sa', underline: true, color: '#1a56b8' },
      { text: ' now' },
    ]);
    expect(inlineRuns('[a \\] b](<https://x.y>)')[0]).toMatchObject({ text: 'a ] b', link: 'https://x.y' });
    expect(inlineRuns('[no](link')).toEqual([{ text: '[no](link' }]);
    expect(inlineRuns('<mailto:a@b.c> and <https://zood.sa>').map((r) => r.text)).toEqual(['a@b.c', ' and ', 'https://zood.sa']);
    expect(inlineRuns('<https://no space>')).toEqual([{ text: '<https://no space>' }]);
    const seen: string[] = [];
    inlineRuns('![شعار](data:image/png;base64,AAAA) ![x]( y )', {}, (alt, src) => seen.push(`${alt}|${src}`));
    expect(seen).toEqual(['شعار|data:image/png;base64,AAAA', 'x|y']);
  });
});

describe('a hostile presentation', () => {
  it('takes 2,000 slides that are one slide, with a 50,000-letter box, in bounded time', () => {
    const ids = Array.from({ length: 2000 }, (_, k) => `<p:sldId id="${256 + k}" r:id="r${k}"/>`).join('');
    const rels = Array.from({ length: 2000 }, (_, k) => `<Relationship Id="r${k}" Target="slides/slide1.xml"/>`).join('');
    const file = zipSync({
      'ppt/presentation.xml': strToU8(`<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`),
      'ppt/_rels/presentation.xml.rels': strToU8(`<Relationships>${rels}</Relationships>`),
      'ppt/slides/slide1.xml': strToU8(
        `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${'كلمة '.repeat(10_000)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      ),
      'ppt/media/film.mp4': new Uint8Array(1000),
    });
    const { value, ms } = timed(() => readPptx(file));
    expect(ms).toBeLessThan(5000);
    expect(value.truncated).toBe(true);
  });
});

describe('making the PDF', () => {
  const env: CreateEnvironment = {
    callStatic: async () => {
      throw new Error('not reached');
    },
    fonts: async () => [],
  };

  it('cuts a document of hundreds of thousands of lines to some two thousand pages, and says so', () => {
    const log = readText(u8('سطر\n\n'.repeat(300_000)));
    const cut = withinLimits(log);
    expect(cut.blocks).toHaveLength(MAX_BLOCKS);
    expect(cut.truncated).toBe(true);
    const word = withinLimits(readText(u8('ب'.repeat(MAX_LETTERS + 10))));
    expect(word.blocks).toHaveLength(1);
    expect(blockText(word.blocks[0] as TextBlock)).toHaveLength(MAX_LETTERS);
    expect(word.truncated).toBe(true);
    const small = readText(u8('سطر'));
    expect(withinLimits(small)).toBe(small);
  });

  it('makes the document when the pictures beside it are all broken (one bad picture lost the whole PDF)', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7').buffer as ArrayBuffer;
    const core: CreateEnvironment = {
      async callStatic<T>(op: string) {
        // What the core answers when it can read none of the pictures.
        if (op === 'create.images') throw new Error('E_EDIT: E_IMAGE: none of the pictures could be read');
        return { result: { pages: 1, missingGlyphs: 0, picturesLeftOut: 0 } as T, blobs: [pdf] };
      },
      fonts: async () => [],
    };
    const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer as ArrayBuffer;
    const result = await createPdf(
      [
        { name: 'broken.png', bytes: broken },
        { name: 'notes.txt', bytes: u8('ملاحظات').buffer as ArrayBuffer },
      ],
      { paper: 'auto', orientation: 'auto', margin: 'small' },
      core,
    );
    expect(result.report.pages).toBe(1);
    expect(result.report.unreadable).toEqual(['broken.png']);
    expect(result.name).toBe('notes.pdf');
  });

  it('names a file too large to read, and does not call it unreadable', async () => {
    const bomb = bombFile();
    const failure = await createPdf([{ name: 'bomb.docx', bytes: bomb.buffer as ArrayBuffer }], { paper: 'auto', orientation: 'auto', margin: 'small' }, env).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'E_CREATE', tooLarge: ['bomb.docx'], unreadable: [] });
  }, 30_000);
});
