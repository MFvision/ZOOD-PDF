import { strToU8, zipSync } from 'fflate';
import type { PageSize, TextAlignment, TextLink } from '../core/types';
import { linkedPieces, pageBlocks } from './structure';
import type { ExportCell, ExportTable } from './structure';
import { cleanText } from './text';
import type { ExportPage } from './text';

/**
 * Word, text only (ADR-0007): the document as flowing paragraphs, never its
 * layout. Arabic cannot be laid out in Word the way a PDF placed it, so
 * nothing pretends to — each paragraph is one right-to-left (or left-to-right)
 * run of its text in reading order, and each PDF page starts a new Word page.
 * Tables are Word tables, in their own direction, and links stay links.
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
  links?: readonly TextLink[];
  bold?: boolean;
  italic?: boolean;
}

/**
 * The web and mail addresses a document links to, each once, as the
 * relationships Word reads them from (`w:hyperlink r:id`).
 */
export class DocxLinks {
  private readonly ids = new Map<string, string>();

  /** The relationship id of `uri`. */
  id(uri: string): string {
    let id = this.ids.get(uri);
    if (!id) {
      id = `rIdLink${this.ids.size + 1}`;
      this.ids.set(uri, id);
    }
    return id;
  }

  /** The `Relationship` elements, for `word/_rels/document.xml.rels`. */
  relationships(): string {
    return [...this.ids]
      .map(([uri, id]) => `<Relationship Id="${id}" Type="${REL}/hyperlink" Target="${xmlAttribute(uri)}" TargetMode="External"/>`)
      .join('');
  }
}

/**
 * Runs of `text` with `properties` (the inside of a `w:rPr`), its linked
 * stretches as Word links. `styled`: a link looks like one (Word's own
 * Hyperlink style, blue and underlined); otherwise it keeps the look it
 * had, as on a page whose picture already draws it. Without `links` to
 * hold them, the text alone.
 */
export function linkedRuns(
  text: string,
  textLinks: readonly TextLink[] | undefined,
  properties: string,
  links: DocxLinks | undefined,
  content: (text: string) => string,
  styled = true,
): string {
  const run = (piece: string, style = '') => {
    // The style comes first in a run's properties.
    const rPr = `${style}${properties}`;
    return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${content(piece)}</w:r>`;
  };
  return linkedPieces(text, links ? textLinks : undefined)
    .filter((piece) => piece.text.length > 0)
    .map((piece) =>
      piece.uri && links
        ? `<w:hyperlink r:id="${links.id(piece.uri)}">${run(piece.text, styled ? '<w:rStyle w:val="Hyperlink"/>' : '')}</w:hyperlink>`
        : run(piece.text),
    )
    .join('');
}

/** Word's Hyperlink character style, for `word/styles.xml`. */
export const HYPERLINK_STYLE =
  '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>' +
  '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>';

/**
 * One paragraph. Element order inside `w:pPr` and `w:rPr` is fixed by the
 * schema (pageBreakBefore before bidi before jc; sz before szCs before rtl).
 *
 * Alignment follows Word's reading of `w:jc`, which is logical: in a
 * right-to-left paragraph "right" is its end, the left edge. Start alignment
 * is the default and is left unsaid.
 */
function paragraphXml(p: DocxParagraph, links?: DocxLinks): string {
  const properties = [
    p.pageBreakBefore ? '<w:pageBreakBefore/>' : '',
    p.rtl ? '<w:bidi/>' : '',
    p.alignment === 'center' ? '<w:jc w:val="center"/>' : '',
    p.alignment === 'end' ? '<w:jc w:val="right"/>' : '',
    p.alignment === 'justify' ? '<w:jc w:val="both"/>' : '',
  ].join('');
  const size = p.fontSize === null ? '' : `<w:sz w:val="${halfPoints(p.fontSize)}"/><w:szCs w:val="${halfPoints(p.fontSize)}"/>`;
  const runProperties = `${p.bold ? '<w:b/><w:bCs/>' : ''}${p.italic ? '<w:i/><w:iCs/>' : ''}${size}${p.rtl ? '<w:rtl/>' : ''}`;
  const runs = p.text.length > 0 ? linkedRuns(p.text, p.links, runProperties, links, runContent) : '';
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${runs}</w:p>`;
}

/** Whether text reads right to left, by its first strong letter; null for none. */
export function readsRtl(text: string): boolean | null {
  const strong = /[\p{L}]/u.exec(text);
  return strong ? /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(strong[0]) : null;
}

/** A cell of a Word table as Word lays it: its own, or one a merge above it covers. */
type GridCell = { cell: ExportCell; span: number; rows: number } | { continues: true; span: number };

/**
 * The cells Word writes for each row, in reading order: a merged cell is
 * one `w:tc` as wide as its columns (`gridSpan`), and in each row below it
 * that it covers, a continuing `w:tc` of the same width (`vMerge`).
 */
export function wordGrid(table: ExportTable): GridCell[][] {
  const columns = Math.max(1, ...table.rows.map((row) => row.length));
  const covered = table.rows.map(() => Array<number>(columns).fill(0));
  const out: GridCell[][] = table.rows.map(() => []);
  table.rows.forEach((row, r) => {
    let c = 0;
    while (c < columns) {
      if (covered[r]![c]! > 0) {
        const span = covered[r]![c]!;
        out[r]!.push({ continues: true, span });
        c += span;
        continue;
      }
      const cell = row[c];
      if (!cell) {
        out[r]!.push({ cell: { text: '', rows: 1, columns: 1 }, span: 1, rows: 1 });
        c += 1;
        continue;
      }
      const span = Math.max(1, Math.min(columns - c, cell.columns));
      const rows = Math.max(1, Math.min(table.rows.length - r, cell.rows));
      for (let k = 1; k < rows; k += 1) covered[r + k]![c] = span;
      out[r]!.push({ cell, span, rows });
      c += span;
    }
  });
  return out;
}

/** Twips of each column in reading order, the table as wide as `width` points. */
export function gridColumns(table: ExportTable, width: number): number[] {
  const drawn = table.widths.length > 0 ? table.widths : [1];
  const ordered = table.direction === 'rtl' ? [...drawn].reverse() : drawn;
  const total = ordered.reduce((a, b) => a + Math.max(0, b), 0) || ordered.length;
  return ordered.map((w) => Math.max(200, Math.round(twips((Math.max(0, w) / total) * width))));
}

/**
 * A table as a Word table: its grid, merges, borders (when the page drew
 * them), right to left when it reads so (`bidiVisual` puts its first column
 * on the right). Each cell's text is a paragraph in its own direction.
 */
export function tableXml(table: ExportTable, width: number, links?: DocxLinks, size: number | null = null): string {
  const columns = gridColumns(table, width);
  const rtl = table.direction === 'rtl';
  const border = table.ruled ? 'single' : 'nil';
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="${border}" w:sz="4" w:space="0" w:color="auto"/>`)
    .join('');
  const rows = wordGrid(table).map((row) => {
    let column = 0;
    const cells = row.map((grid) => {
      const w = columns.slice(column, column + grid.span).reduce((a, b) => a + b, 0);
      column += grid.span;
      const span = grid.span > 1 ? `<w:gridSpan w:val="${grid.span}"/>` : '';
      if ('continues' in grid) return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span}<w:vMerge/></w:tcPr><w:p/></w:tc>`;
      const merge = grid.rows > 1 ? '<w:vMerge w:val="restart"/>' : '';
      const text = cleanText(grid.cell.text).replace(/[\t\n\r]+/g, ' ').trim();
      const cellRtl = readsRtl(text) ?? rtl;
      const paragraph = paragraphXml({ text, rtl: cellRtl, alignment: 'start', fontSize: size, pageBreakBefore: false, links: grid.cell.links }, links);
      return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span}${merge}</w:tcPr>${paragraph}</w:tc>`;
    });
    return `<w:tr>${cells.join('')}</w:tr>`;
  });
  return (
    '<w:tbl><w:tblPr>' +
    (rtl ? '<w:bidiVisual/>' : '') +
    `<w:tblW w:w="${columns.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    '<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>' +
    `</w:tblPr><w:tblGrid>${columns.map((c) => `<w:gridCol w:w="${c}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`
  );
}

function twips(points: number): number {
  return Math.round(points * 20);
}

/** The Word page takes the size and orientation of the PDF's first page. */
function sectionXml(size: PageSize | undefined): string {
  const { width, height, margin: points } = usablePage(size);
  const margin = twips(points);
  const orient = width > height ? ' w:orient="landscape"' : '';
  return (
    `<w:sectPr><w:pgSz w:w="${twips(width)}" w:h="${twips(height)}"${orient}/>` +
    `<w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`
  );
}

/** The page Word sets the text on: its size, and the margins round it, in points. */
function usablePage(size: PageSize | undefined): { width: number; height: number; margin: number } {
  const usable = size && size.every((side) => Number.isFinite(side) && side >= SIDE.min && side <= SIDE.max);
  const [width, height] = usable ? size : FALLBACK_PAGE;
  // Word's own inch on a letter or A4 page, less on a small one.
  return { width, height, margin: Math.min(1440, twips(Math.min(width, height) * 0.12)) / 20 };
}

/**
 * `word/document.xml`: every page's paragraphs and tables, a new Word page
 * for each PDF page. `links` collects the addresses linked to; without it
 * links are left out.
 */
export function documentXml(pages: readonly ExportPage[], pageSize?: PageSize, links?: DocxLinks): string {
  const body: string[] = [];
  const page = usablePage(pageSize);
  const width = page.width - 2 * page.margin;
  pages.forEach((exported, index) => {
    const items = pageBlocks(exported.paragraphs, exported.tables ?? []).flatMap((block): (DocxParagraph | ExportTable)[] => {
      if (block.kind === 'table') return [block.table];
      const p = block.paragraph;
      const text = cleanText(p.text).replace(/[\n\r]+/g, ' ').trim();
      // Links only where the text is as the paragraph had it, so their places hold.
      const kept = text === p.text ? p.links : undefined;
      const look = { bold: (p.font?.weight ?? 400) >= 600, italic: p.font?.italic === true };
      return text.length > 0 ? [{ text, rtl: p.direction === 'rtl', alignment: p.alignment, fontSize: p.fontSize, pageBreakBefore: false, links: kept, ...look }] : [];
    });
    // A page without text, or opening with a table, still gets its Word page: an empty paragraph carries the break.
    const first = items[0];
    if (!first || 'rows' in first) items.unshift({ text: '', rtl: false, alignment: 'start', fontSize: null, pageBreakBefore: false });
    (items[0] as DocxParagraph).pageBreakBefore = index > 0;
    items.forEach((item, k) => {
      if ('rows' in item) {
        body.push(tableXml(item, width, links));
        // Word needs a paragraph between two tables, or after the last thing on a page, to keep them apart.
        const next = items[k + 1];
        if (!next || 'rows' in next) body.push('<w:p/>');
      } else body.push(paragraphXml(item, links));
    });
  });
  return `${DECLARATION}<w:document xmlns:w="${W}" xmlns:r="${REL}"><w:body>${body.join('')}${sectionXml(pageSize)}</w:body></w:document>`;
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
    HYPERLINK_STYLE +
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

function documentRelsXml(links: DocxLinks): string {
  return (
    `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>` +
    links.relationships() +
    '</Relationships>'
  );
}

/** The .docx itself: UTF-8 XML parts, deflated in a zip. */
export function buildDocx(pages: readonly ExportPage[], pageSize?: PageSize): Uint8Array<ArrayBuffer> {
  const links = new DocxLinks();
  const document = documentXml(pages, pageSize, links);
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml()),
    '_rels/.rels': strToU8(packageRelsXml()),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(stylesXml()),
    'word/_rels/document.xml.rels': strToU8(documentRelsXml(links)),
  });
}
