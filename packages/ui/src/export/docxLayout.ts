import { strToU8, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import type { TextLink } from '../core/types';
import { DOCX_FONT, DocxLinks, HYPERLINK_STYLE, linkedRuns, readsRtl, wordGrid } from './docx';
import type { ExportFont } from './paragraphs';
import type { Slide, SlideText } from './pptx';
import type { LayoutTable } from './structure';
import { cleanText } from './text';

/**
 * Word with the layout kept: each PDF page a Word page of its own size. Behind
 * it, the page drawn without its text — logos, pictures, shapes, rules and
 * fills, as they are — and on it, each paragraph as a text box where it was,
 * in its lines, face, size, weight and colour, right to left where it is
 * Arabic. A scanned page keeps its picture, and its recognised text rides on
 * it invisibly, as it does in the PDF.
 *
 * A table is a Word table where it was, its columns and rows as the page
 * drew them (the rules and fills stay in the picture behind), so its cells
 * can be typed in and grow as a table's do. Links stay links.
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

/**
 * Families whose names run words together on purpose: read from a
 * PostScript name a word at a time, they come back spaced ("Deja Vu Sans"),
 * and Word, which knows them unspaced, would set another face.
 */
const JOINED: readonly [RegExp, string][] = [
  [/^Deja Vu\b/, 'DejaVu'],
  [/^Open Symbol$/, 'OpenSymbol'],
  [/^Free (Sans|Serif|Mono)\b/, 'Free$1'],
  [/^Te X Gyre\b/, 'TeX Gyre'],
  [/^Tex Gyre\b/, 'TeX Gyre'],
];

/** The family as Word knows it. */
export function wordFamily(family: string): string {
  let out = family.trim();
  for (const [pattern, joined] of JOINED) out = out.replace(pattern, joined);
  return out;
}

/** Word's kind of a family, from its name: what it sets instead when the family is not installed. */
export function fontKind(family: string): { family: 'roman' | 'swiss' | 'modern'; alt: string } {
  const name = family.toLowerCase();
  if (/mono|courier|consolas|menlo|code/.test(name)) return { family: 'modern', alt: 'Courier New' };
  if (/sans|grotesk|gothic/.test(name)) return { family: 'swiss', alt: 'Arial' };
  if (/serif|times|roman|georgia|garamond|cambria|antiqua|palatino|minion|baskerville|caslon|bodoni|didot|book|amiri|naskh|traditional|majalla|lotus|mitra|badr|scheherazade/.test(name)) {
    return { family: 'roman', alt: 'Times New Roman' };
  }
  return { family: 'swiss', alt: 'Arial' };
}

/**
 * `word/fontTable.xml`: each family the document sets, with its kind and a
 * face to stand in for it. Without it Word sets a family it does not have
 * in a serif, whatever the family looked like.
 */
export function fontTableXml(families: Iterable<string>): string {
  const fonts = [...new Set([DOCX_FONT, ...families])]
    .map((name) => {
      const kind = fontKind(name);
      const alt = kind.alt !== name ? `<w:altName w:val="${xmlAttribute(kind.alt)}"/>` : '';
      return `<w:font w:name="${xmlAttribute(name)}">${alt}<w:charset w:val="00"/><w:family w:val="${kind.family}"/><w:pitch w:val="${kind.family === 'modern' ? 'fixed' : 'variable'}"/></w:font>`;
    })
    .join('');
  return `${DECLARATION}<w:fonts xmlns:w="${W}">${fonts}</w:fonts>`;
}

/** The families the pages set, their own names as Word knows them. */
function familiesOf(pages: readonly Slide[]): string[] {
  const out = new Set<string>();
  for (const page of pages) {
    for (const text of page.texts) out.add(faceOf(text));
    for (const table of page.tables ?? []) out.add(faceOf(table));
  }
  return [...out];
}

/** The face a box is set in: the file's own family when it names one. */
function faceOf(text: Pick<SlideText, 'font'>): string {
  const family = text.font ? wordFamily(text.font.family) : '';
  return family.length > 0 ? family : DOCX_FONT;
}

/** How a run looks: what `runProperties` needs. */
interface RunLook {
  font?: ExportFont;
  size: number;
  color: string;
  direction: SlideText['direction'];
}

/**
 * A run's properties, in the schema's order (rFonts, b, bCs, i, iCs, color,
 * sz, szCs, fitText, rtl, then w14). `fit`: twips the run's text is set
 * into exactly, as wide as the page had it.
 */
function runProperties(text: RunLook, scale: number, hidden: boolean, fit?: { width: number; id: number }): string {
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
    (fit ? `<w:fitText w:val="${fit.width}" w:id="${fit.id}"/>` : '') +
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

/** A run's text: kept exactly, spaces and all. */
function runText(text: string): string {
  return `<w:t xml:space="preserve">${xmlText(text)}</w:t>`;
}

/** The runs of one line of a box, its links as Word links (looking as they did on the page). */
function lineRuns(line: string, links: readonly TextLink[] | undefined, properties: string, docxLinks: DocxLinks | undefined, broken: boolean): string {
  const text = cleanText(line).replace(/[\t\n\r]+/g, ' ');
  let first = broken;
  const content = (piece: string) => {
    const br = first ? '<w:br/>' : '';
    first = false;
    return `${br}${runText(piece)}`;
  };
  // Links only where cleaning left the text as it was, so their places hold.
  const runs = linkedRuns(text, text === line ? links : undefined, properties, docxLinks, content, false);
  return runs || (broken ? `<w:r><w:rPr>${properties}</w:rPr><w:br/></w:r>` : '');
}

/** The box's paragraph: its lines, broken where the page broke them. */
function boxParagraph(text: SlideText, scale: number, hidden: boolean, links?: DocxLinks): string {
  const rPr = runProperties(text, scale, hidden);
  const properties = rPr.slice('<w:rPr>'.length, -'</w:rPr>'.length);
  const runs = text.lines.map((line, k) => lineRuns(line, text.links?.[k], properties, links, k > 0)).join('');
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

/** Word's `w:jc` for a cell: logical, so in a right-to-left cell "right" is its end. */
const CELL_JC = { start: '', center: '<w:jc w:val="center"/>', end: '<w:jc w:val="right"/>' } as const;

/**
 * A table where the page had it: a floating Word table at its place, its
 * columns as wide and its rows at least as tall as the page drew them,
 * without borders (the picture behind draws the page's own), each cell's
 * text in its colour, place and direction.
 */
let fitIds = 0;

export function layoutTableXml(table: LayoutTable, scale: number, hidden: boolean, links?: DocxLinks): string {
  const rtl = table.direction === 'rtl';
  const columns = (rtl ? [...table.widths].reverse() : table.widths).map((w) => Math.max(1, twips(w * scale)));
  const grid = wordGrid(table);
  const rows = grid.map((row, r) => {
    let column = 0;
    const cells = row.map((cell) => {
      const at = column;
      column += cell.span;
      const w = columns.slice(at, at + cell.span).reduce((a, b) => a + b, 0);
      const span = cell.span > 1 ? `<w:gridSpan w:val="${cell.span}"/>` : '';
      if ('continues' in cell) return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span}<w:vMerge/></w:tcPr><w:p/></w:tc>`;
      const look = table.looks[r]?.[table.rows[r]!.indexOf(cell.cell)] ?? null;
      const text = cleanText(cell.cell.text).replace(/[\t\n\r]+/g, ' ').trim();
      const cellRtl = readsRtl(text) ?? rtl;
      // One line that nearly fills its cell on the page would wrap in a face
      // a little wider, and its row grow, and the table slide off the rules
      // and fills the picture behind draws: set it as wide as the page had it.
      const box = cell.cell.box;
      const room = w / 20 / scale - 2 * Math.max(0, table.margin);
      const fits = box && box[3] < table.size * 1.8 && box[2] >= room * 0.75 && box[2] <= room * 1.05 && text.length > 1;
      const fit = fits ? { width: Math.max(1, twips(box[2] * scale)), id: (fitIds += 1) } : undefined;
      const rPr = runProperties(
        { font: table.font, size: table.size, color: look?.color ?? '000000', direction: cellRtl ? 'rtl' : 'ltr' },
        scale,
        hidden || look?.hidden === true,
        fit,
      );
      const properties = rPr.slice('<w:rPr>'.length, -'</w:rPr>'.length);
      const runs = linkedRuns(text, text === cell.cell.text && !fit ? cell.cell.links : undefined, properties, links, runText, false);
      const valign = look?.place.valign === 'top' ? '' : `<w:vAlign w:val="${look?.place.valign ?? 'center'}"/>`;
      const merge = cell.rows > 1 ? '<w:vMerge w:val="restart"/>' : '';
      const paragraph =
        '<w:p><w:pPr>' +
        (cellRtl ? '<w:bidi/>' : '') +
        '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
        CELL_JC[look?.place.align ?? 'start'] +
        `${rPr}</w:pPr>${runs}</w:p>`;
      return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span}${merge}${valign}</w:tcPr>${paragraph}</w:tc>`;
    });
    const height = Math.max(1, twips((table.heights[r] ?? 0) * scale));
    return `<w:tr><w:trPr><w:trHeight w:val="${height}" w:hRule="atLeast"/></w:trPr>${cells.join('')}</w:tr>`;
  });
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="nil"/>`).join('');
  // Word sets a table's text, not its edge, where it is placed: the edge is a margin further out.
  const margin = twips(Math.max(0, table.margin) * scale);
  return (
    '<w:tbl><w:tblPr>' +
    `<w:tblpPr w:leftFromText="0" w:rightFromText="0" w:topFromText="0" w:bottomFromText="0" w:vertAnchor="page" w:horzAnchor="page" w:tblpX="${twips(table.left * scale) + margin}" w:tblpY="${twips(table.top * scale)}"/>` +
    '<w:tblOverlap w:val="overlap"/>' +
    (rtl ? '<w:bidiVisual/>' : '') +
    `<w:tblW w:w="${columns.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    // The same either side, so it means the same in a table of either direction.
    `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="${margin}" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="${margin}" w:type="dxa"/></w:tblCellMar>` +
    `</w:tblPr><w:tblGrid>${columns.map((c) => `<w:gridCol w:w="${c}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`
  );
}

/** `word/document.xml`, and the pictures it refers to, by relationship id. */
export function layoutDocumentXml(
  pages: readonly Slide[],
  links?: DocxLinks,
): { xml: string; pictures: { relId: string; target: string; bytes: Uint8Array }[] } {
  const pictures: { relId: string; target: string; bytes: Uint8Array }[] = [];
  const body: string[] = [];
  let id = 1;
  fitIds = 0;
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
      const graphic = textBoxGraphic(boxParagraph(text, size.scale, page.hiddenText || text.hidden === true, links), place.width, place.height, place.turned);
      runs.push(drawingRun({ id, name: `Text ${id}`, ...place, behind: false, graphic }, true));
      id += 1;
    }
    // Its tables float where they were, held by the paragraph after them.
    for (const table of page.tables ?? []) body.push(layoutTableXml(table, size.scale, page.hiddenText, links));
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
    HYPERLINK_STYLE +
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
    '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' +
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

function documentRelsXml(pictures: readonly { relId: string; target: string }[], links: DocxLinks): string {
  return (
    `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}">` +
    `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rIdFonts" Type="${R}/fontTable" Target="fontTable.xml"/>` +
    pictures.map((p) => `<Relationship Id="${p.relId}" Type="${R}/image" Target="${p.target}"/>`).join('') +
    links.relationships() +
    '</Relationships>'
  );
}

/** The .docx: XML parts deflated, the page pictures (already compressed) stored. */
export function buildLayoutDocx(pages: readonly Slide[]): Uint8Array<ArrayBuffer> {
  const links = new DocxLinks();
  const { xml, pictures } = layoutDocumentXml(pages, links);
  const files: Zippable = {
    '[Content_Types].xml': strToU8(contentTypesXml()),
    '_rels/.rels': strToU8(packageRelsXml()),
    'word/document.xml': strToU8(xml),
    'word/styles.xml': strToU8(stylesXml()),
    'word/fontTable.xml': strToU8(fontTableXml(familiesOf(pages))),
    'word/_rels/document.xml.rels': strToU8(documentRelsXml(pictures, links)),
  };
  for (const picture of pictures) files[`word/${picture.target}`] = [picture.bytes, { level: 0 }];
  return zipSync(files) as Uint8Array<ArrayBuffer>;
}
