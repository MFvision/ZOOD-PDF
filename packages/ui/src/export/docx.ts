import { strToU8, zipSync } from 'fflate';
import type { PageSize, TextAlignment } from '../core/types';
import { cleanText } from './text';
import type { ExportPage } from './text';

/**
 * Word, text only (ADR-0007): the document as flowing paragraphs, never its
 * layout. Arabic cannot be laid out in Word the way a PDF placed it, so
 * nothing pretends to — each paragraph is one right-to-left (or left-to-right)
 * run of its text in reading order, and each PDF page starts a new Word page.
 *
 * Built by hand: five small XML parts in a zip, which is all a .docx needs.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Installed with Word on Windows and macOS, with Arabic and Latin letters alike. */
export const DOCX_FONT = 'Arial';

/** A4, when a page's size cannot be used. */
const FALLBACK_PAGE: PageSize = [595.28, 841.89];
/** Word's own limits on a page side, in points (1 to 22 inches). */
const SIDE = { min: 72, max: 1584 };

function xmlText(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function xmlAttribute(text: string): string {
  return xmlText(text).replace(/"/g, '&quot;');
}

/** Tabs become Word tabs; everything else is kept exactly, spaces included. */
function runContent(text: string): string {
  return text
    .split('\t')
    .map((piece) => (piece.length > 0 ? `<w:t xml:space="preserve">${xmlText(piece)}</w:t>` : ''))
    .join('<w:tab/>');
}

/** Half-points, as Word counts type sizes; from 6 to 72 points. */
function halfPoints(points: number): number {
  return Math.round(Math.min(72, Math.max(6, points)) * 2);
}

interface DocxParagraph {
  text: string;
  rtl: boolean;
  alignment: TextAlignment;
  fontSize: number | null;
  pageBreakBefore: boolean;
}

/**
 * One paragraph. Element order inside `w:pPr` and `w:rPr` is fixed by the
 * schema (pageBreakBefore before bidi before jc; sz before szCs before rtl).
 *
 * Alignment follows Word's reading of `w:jc`, which is logical: in a
 * right-to-left paragraph "right" is its end, the left edge. Start alignment
 * is the default and is left unsaid.
 */
function paragraphXml(p: DocxParagraph): string {
  const properties = [
    p.pageBreakBefore ? '<w:pageBreakBefore/>' : '',
    p.rtl ? '<w:bidi/>' : '',
    p.alignment === 'center' ? '<w:jc w:val="center"/>' : '',
    p.alignment === 'end' ? '<w:jc w:val="right"/>' : '',
    p.alignment === 'justify' ? '<w:jc w:val="both"/>' : '',
  ].join('');
  const size = p.fontSize === null ? '' : `<w:sz w:val="${halfPoints(p.fontSize)}"/><w:szCs w:val="${halfPoints(p.fontSize)}"/>`;
  const runProperties = `${size}${p.rtl ? '<w:rtl/>' : ''}`;
  const run = p.text.length > 0 ? `<w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ''}${runContent(p.text)}</w:r>` : '';
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${run}</w:p>`;
}

function twips(points: number): number {
  return Math.round(points * 20);
}

/** The Word page takes the size and orientation of the PDF's first page. */
function sectionXml(size: PageSize | undefined): string {
  const usable = size && size.every((side) => Number.isFinite(side) && side >= SIDE.min && side <= SIDE.max);
  const [width, height] = usable ? size : FALLBACK_PAGE;
  // Word's own inch on a letter or A4 page, less on a small one.
  const margin = Math.min(1440, twips(Math.min(width, height) * 0.12));
  const orient = width > height ? ' w:orient="landscape"' : '';
  return (
    `<w:sectPr><w:pgSz w:w="${twips(width)}" w:h="${twips(height)}"${orient}/>` +
    `<w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`
  );
}

/** `word/document.xml`: every page's paragraphs, a new Word page for each PDF page. */
export function documentXml(pages: readonly ExportPage[], pageSize?: PageSize): string {
  const body: string[] = [];
  pages.forEach((page, index) => {
    const paragraphs: DocxParagraph[] = page.paragraphs.flatMap((p) => {
      const text = cleanText(p.text).replace(/[\n\r]+/g, ' ').trim();
      return text.length > 0 ? [{ text, rtl: p.direction === 'rtl', alignment: p.alignment, fontSize: p.fontSize, pageBreakBefore: false }] : [];
    });
    // A page without text still gets its Word page: an empty paragraph carries the break.
    if (paragraphs.length === 0) paragraphs.push({ text: '', rtl: false, alignment: 'start', fontSize: null, pageBreakBefore: false });
    paragraphs[0]!.pageBreakBefore = index > 0;
    body.push(...paragraphs.map(paragraphXml));
  });
  return `${DECLARATION}<w:document xmlns:w="${W}"><w:body>${body.join('')}${sectionXml(pageSize)}</w:body></w:document>`;
}

/**
 * `word/styles.xml`: the defaults every paragraph inherits. `w:cs` is the face
 * Word uses for Arabic (a complex script), `w:szCs` its size, and `w:bidi` in
 * `w:lang` the language it proofs right-to-left text in — the same default a
 * new Word document carries.
 */
function stylesXml(): string {
  const font = xmlAttribute(DOCX_FONT);
  return (
    `${DECLARATION}<w:styles xmlns:w="${W}">` +
    '<w:docDefaults>' +
    `<w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}" w:cs="${font}"/>` +
    '<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '</w:styles>'
  );
}

function contentTypesXml(): string {
  return (
    `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>'
  );
}

function packageRelsXml(): string {
  return (
    `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
    '</Relationships>'
  );
}

function documentRelsXml(): string {
  return (
    `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>` +
    '</Relationships>'
  );
}

/** The .docx itself: UTF-8 XML parts, deflated in a zip. */
export function buildDocx(pages: readonly ExportPage[], pageSize?: PageSize): Uint8Array<ArrayBuffer> {
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml()),
    '_rels/.rels': strToU8(packageRelsXml()),
    'word/document.xml': strToU8(documentXml(pages, pageSize)),
    'word/styles.xml': strToU8(stylesXml()),
    'word/_rels/document.xml.rels': strToU8(documentRelsXml()),
  });
}
