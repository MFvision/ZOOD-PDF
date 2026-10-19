import { strToU8, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { DOCX_FONT } from './docx';
import type { Slide, SlideText } from './pptx';
import { cleanText } from './text';

/**
 * Word with the layout kept: each PDF page a Word page of its own size. Behind
 * it, the page drawn without its text — logos, pictures, shapes, rules and
 * fills, as they are — and on it, each paragraph as a text box where it was,
 * in its lines, face, size, weight and colour, right to left where it is
 * Arabic. A scanned page keeps its picture, and its recognised text rides on
 * it invisibly, as it does in the PDF.
 *
 * The boxes are what Word itself writes for a text box (a WordprocessingML
 * shape, in the AlternateContent Word puts around one), so Word, LibreOffice
 * and Pages open them as text boxes to edit. Built by hand, like the other
 * Office exports.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS =
  `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}" ` +
  `xmlns:wps="${WPS}" xmlns:w14="${W14}" xmlns:mc="${MC}" mc:Ignorable="w14"`;

/** English Metric Units: 12,700 to a point. */
const EMU = 12_700;
/** Word's page sides: 1 to 22 inches, in points. */
const SIDE = { min: 72, max: 1584 };
/** Room a box is given beyond its text, for a face a little wider than the PDF's. */
const SLACK = 0.25;

function xmlText(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function xmlAttribute(text: string): string {
  return xmlText(text).replace(/"/g, '&quot;');
}

function emu(points: number): number {
  return Math.max(0, Math.round(points * EMU));
}

function coordinate(points: number): number {
  return Math.round(points * EMU);
}

function twips(points: number): number {
  return Math.round(points * 20);
}

/** Half-points, as Word counts type sizes; from 1 to 400 points. */
function halfPoints(points: number): number {
  return Math.round(Math.min(400, Math.max(1, points)) * 2);
}

/** A page within Word's limits, and how much it was scaled to fit them. */
export function wordPage(page: Pick<Slide, 'width' | 'height'>): { width: number; height: number; scale: number } {
  const w = Number.isFinite(page.width) && page.width > 0 ? page.width : 595.28;
  const h = Number.isFinite(page.height) && page.height > 0 ? page.height : 841.89;
  const down = Math.min(1, SIDE.max / w, SIDE.max / h);
  const up = Math.max(1, SIDE.min / (w * down), SIDE.min / (h * down));
  const scale = Math.min(down * up, SIDE.max / w, SIDE.max / h);
  return { width: w * scale, height: h * scale, scale };
}

/** The face a box is set in: the file's own family when it names one. */
function faceOf(text: SlideText): string {
  const family = text.font?.family.trim();
  return family && family.length > 0 ? family : DOCX_FONT;
}

/** A run's properties, in the schema's order (rFonts, b, bCs, i, iCs, color, sz, szCs, rtl, then w14). */
function runProperties(text: SlideText, scale: number, hidden: boolean): string {
  const face = xmlAttribute(faceOf(text));
  const bold = (text.font?.weight ?? 400) >= 600;
  const italic = text.font?.italic ?? false;
  const size = halfPoints(text.size * scale);
  const colour = /^[0-9a-f]{6}$/i.test(text.color) ? text.color.toUpperCase() : '000000';
  return (
    '<w:rPr>' +
    `<w:rFonts w:ascii="${face}" w:hAnsi="${face}" w:eastAsia="${face}" w:cs="${face}"/>` +
    (bold ? '<w:b/><w:bCs/>' : '') +
    (italic ? '<w:i/><w:iCs/>' : '') +
    `<w:color w:val="${colour}"/>` +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` +
    (text.direction === 'rtl' ? '<w:rtl/>' : '') +
    // A scan's text: there to find and copy, not to see.
    (hidden ? '<w14:textFill><w14:noFill/></w14:textFill>' : '') +
    '</w:rPr>'
  );
}

/** Word's `w:jc` is logical: in a right-to-left paragraph "right" is its end. */
function justification(text: SlideText): string {
  if (text.alignment === 'center') return '<w:jc w:val="center"/>';
  if (text.alignment === 'end') return '<w:jc w:val="right"/>';
  return '';
}

/** The box's paragraph: its lines, broken where the page broke them. */
function boxParagraph(text: SlideText, scale: number, hidden: boolean): string {
  const rPr = runProperties(text, scale, hidden);
  const lines = text.lines.map((line) => cleanText(line).replace(/[\t\n\r]+/g, ' '));
  const runs = lines.map((line, k) => `<w:r>${rPr}${k > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlText(line)}</w:t></w:r>`).join('');
  const pitch = text.pitch !== null && text.pitch > 0 ? text.pitch : text.size * 1.2;
  return (
    // The schema's order: bidi, spacing, jc, rPr.
    '<w:p><w:pPr>' +
    (text.direction === 'rtl' ? '<w:bidi/>' : '') +
    `<w:spacing w:before="0" w:after="0" w:line="${Math.max(20, twips(pitch * scale))}" w:lineRule="exact"/>` +
    justification(text) +
    `${rPr}</w:pPr>${runs}</w:p>`
  );
}

interface Anchor {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  behind: boolean;
  /** Turned a quarter, to read bottom to top. */
  turned?: boolean;
  graphic: string;
}

/** A floating object placed on the page by its top-left corner, with nothing wrapping round it. */
function anchorXml(anchor: Anchor): string {
  return (
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${anchor.id + 1}" ` +
    `behindDoc="${anchor.behind ? 1 : 0}" locked="${anchor.behind ? 1 : 0}" layoutInCell="1" allowOverlap="1">` +
    '<wp:simplePos x="0" y="0"/>' +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${coordinate(anchor.x)}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${coordinate(anchor.y)}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${emu(anchor.width)}" cy="${emu(anchor.height)}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>' +
    `<wp:docPr id="${anchor.id}" name="${xmlAttribute(anchor.name)}"/><wp:cNvGraphicFramePr/>` +
    `${anchor.graphic}</wp:anchor>`
  );
}

function pictureGraphic(id: number, relId: string, width: number, height: number): string {
  return (
    `<a:graphic><a:graphicData uri="${PIC}"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="page${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic>'
  );
}

function textBoxGraphic(paragraph: string, width: number, height: number, turned: boolean): string {
  return (
    `<a:graphic><a:graphicData uri="${WPS}"><wps:wsp><wps:cNvSpPr txBox="1"/>` +
    `<wps:spPr><a:xfrm${turned ? ' rot="16200000"' : ''}><a:off x="0" y="0"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>' +
    `<wps:txbx><w:txbxContent>${paragraph}</w:txbxContent></wps:txbx>` +
    // No wrapping: the lines break where the page broke them; the box grows to its text.
    '<wps:bodyPr rot="0" vert="horz" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0"><a:spAutoFit/></wps:bodyPr>' +
    '</wps:wsp></a:graphicData></a:graphic>'
  );
}

/** A run holding one floating object, written the way Word writes a text box. */
function drawingRun(anchor: Anchor, shape: boolean): string {
  const drawing = `<w:drawing>${anchorXml(anchor)}</w:drawing>`;
  return shape
    ? `<w:r><mc:AlternateContent><mc:Choice Requires="wps">${drawing}</mc:Choice><mc:Fallback/></mc:AlternateContent></w:r>`
    : `<w:r>${drawing}</w:r>`;
}

/** Where a box goes: its text's box, widened on the side its lines run to. */
function boxPlace(text: SlideText, scale: number): { x: number; y: number; width: number; height: number; turned: boolean } {
  let x = text.x * scale;
  let y = text.y * scale;
  let width = text.width * scale;
  let height = text.height * scale;
  if (text.vertical) {
    // Unturned, the box is as long as the text and as thick as a line, about the same centre.
    const [cx, cy] = [x + width / 2, y + height / 2];
    [width, height] = [height, width];
    [x, y] = [cx - width / 2, cy - height / 2];
  }
  const extra = width * SLACK + 4;
  if (!text.vertical) {
    if (text.alignment === 'center') x -= extra / 2;
    else if ((text.direction === 'rtl') !== (text.alignment === 'end')) x -= extra;
  }
  return { x, y, width: width + extra, height, turned: text.vertical === true };
}

function sectionXml(size: { width: number; height: number }): string {
  const orient = size.width > size.height ? ' w:orient="landscape"' : '';
  return (
    `<w:sectPr><w:pgSz w:w="${twips(size.width)}" w:h="${twips(size.height)}"${orient}/>` +
    '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>'
  );
}

/** `word/document.xml`, and the pictures it refers to, by relationship id. */
export function layoutDocumentXml(pages: readonly Slide[]): { xml: string; pictures: { relId: string; target: string; bytes: Uint8Array }[] } {
  const pictures: { relId: string; target: string; bytes: Uint8Array }[] = [];
  const body: string[] = [];
  let id = 1;
  pages.forEach((page, index) => {
    const size = wordPage(page);
    const runs: string[] = [];
    if (page.picture) {
      const relId = `rIdPicture${index + 1}`;
      pictures.push({ relId, target: `media/page${index + 1}.png`, bytes: page.picture });
      runs.push(
        drawingRun(
          { id, name: `Page ${index + 1}`, x: 0, y: 0, width: size.width, height: size.height, behind: true, graphic: pictureGraphic(id, relId, size.width, size.height) },
          false,
        ),
      );
      id += 1;
    }
    for (const text of page.texts) {
      const place = boxPlace(text, size.scale);
      const graphic = textBoxGraphic(boxParagraph(text, size.scale, page.hiddenText || text.hidden === true), place.width, place.height, place.turned);
      runs.push(drawingRun({ id, name: `Text ${id}`, ...place, behind: false, graphic }, true));
      id += 1;
    }
    // One small paragraph per page holds its objects; the page's section ends with it.
    const last = index === pages.length - 1;
    body.push(
      '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr>' +
        `${last ? '' : sectionXml(size)}</w:pPr>${runs.join('')}</w:p>`,
    );
    if (last) body.push(sectionXml(size));
  });
  return { xml: `${DECLARATION}<w:document ${NS}><w:body>${body.join('')}</w:body></w:document>`, pictures };
}

function stylesXml(): string {
  const font = xmlAttribute(DOCX_FONT);
  return (
    `${DECLARATION}<w:styles xmlns:w="${W}">` +
    '<w:docDefaults>' +
    `<w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}" w:cs="${font}"/>` +
    '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
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
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>'
  );
}

function packageRelsXml(): string {
  return (
    `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}">` +
    `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
    '</Relationships>'
  );
}

function documentRelsXml(pictures: readonly { relId: string; target: string }[]): string {
  return (
    `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}">` +
    `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>` +
    pictures.map((p) => `<Relationship Id="${p.relId}" Type="${R}/image" Target="${p.target}"/>`).join('') +
    '</Relationships>'
  );
}

/** The .docx: XML parts deflated, the page pictures (already compressed) stored. */
export function buildLayoutDocx(pages: readonly Slide[]): Uint8Array<ArrayBuffer> {
  const { xml, pictures } = layoutDocumentXml(pages);
  const files: Zippable = {
    '[Content_Types].xml': strToU8(contentTypesXml()),
    '_rels/.rels': strToU8(packageRelsXml()),
    'word/document.xml': strToU8(xml),
    'word/styles.xml': strToU8(stylesXml()),
    'word/_rels/document.xml.rels': strToU8(documentRelsXml(pictures)),
  };
  for (const picture of pictures) files[`word/${picture.target}`] = [picture.bytes, { level: 0 }];
  return zipSync(files) as Uint8Array<ArrayBuffer>;
}
