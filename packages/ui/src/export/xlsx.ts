import { strToU8, zipSync } from 'fflate';
import type { NumberFormat, Sheet, SheetCell } from './tables';

/**
 * Excel: a workbook of sheets (`tables.ts` makes them from what the core
 * found on the pages). Numbers are numbers, shown as they were written —
 * grouping, decimals, percent — and everything else is text as Warraq's
 * reader has it, in reading order. Merged cells stay merged; a sheet of a
 * right-to-left page or table is a right-to-left sheet, column A on the right.
 *
 * Written by hand, as the Word export is: the parts SpreadsheetML needs, in
 * UTF-8, zipped, each element in the order ECMA-376 Part 1 §18 sets for it.
 * Strings are inline, so there is no shared-string table to keep in step.
 */

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Installed with Excel on Windows and macOS, with Arabic and Latin letters alike. */
export const XLSX_FONT = 'Arial';

/** Excel's own limits: 1,048,576 rows, 16,384 columns, 32,767 characters a cell. */
export const LIMITS = { rows: 1_048_576, columns: 16_384, cell: 32_767 };

function xmlText(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function xmlAttribute(text: string): string {
  return xmlText(text).replace(/"/g, '&quot;');
}

/** A, B, …, Z, AA, AB, …: the letters of column `index` (zero-based). */
export function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/**
 * Sheet names: at most 31 characters, none of `[]:*?/\`, not starting or
 * ending with an apostrophe, and each different from the others (Excel
 * compares them without regard to case).
 */
export function sheetNames(wanted: readonly string[]): string[] {
  const taken = new Set<string>();
  return wanted.map((raw, index) => {
    const base = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet${index + 1}`;
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

/** A number format's code: `#,##0.00`, `0%`… */
export function formatCode(format: NumberFormat): string {
  const whole = format.grouped ? '#,##0' : '0';
  const decimals = format.decimals > 0 ? `.${'0'.repeat(format.decimals)}` : '';
  return `${whole}${decimals}${format.percent ? '%' : ''}`;
}

/** The formats Excel has built in, by code; the rest are the workbook's own from 164. */
const BUILT_IN_FORMATS: Record<string, number> = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10 };

/** The cell styles a workbook uses: each a number format, with the plain one first. */
class Styles {
  private codes = new Map<string, number>();
  private xfs = new Map<number, number>([[0, 0]]);

  index(cell: SheetCell): number {
    if (cell.value.kind !== 'number') return 0;
    const code = formatCode(cell.value.format);
    // A plain whole number is what General shows anyway.
    if (code === '0') return 0;
    let id = BUILT_IN_FORMATS[code] ?? this.codes.get(code);
    if (id === undefined) {
      id = 164 + this.codes.size;
      this.codes.set(code, id);
    }
    let xf = this.xfs.get(id);
    if (xf === undefined) {
      xf = this.xfs.size;
      this.xfs.set(id, xf);
    }
    return xf;
  }

  xml(): string {
    const numFmts =
      this.codes.size > 0
        ? `<numFmts count="${this.codes.size}">${[...this.codes].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xmlAttribute(code)}"/>`).join('')}</numFmts>`
        : '';
    const xfs = [...this.xfs.keys()]
      .map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"${id > 0 ? ' applyNumberFormat="1"' : ''}/>`)
      .join('');
    return (
      `${DECLARATION}<styleSheet xmlns="${MAIN}">${numFmts}` +
      `<fonts count="1"><font><sz val="11"/><name val="${xmlAttribute(XLSX_FONT)}"/><family val="2"/></font></fonts>` +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.size}">${xfs}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }
}

function worksheetXml(sheet: Sheet, styles: Styles, first: boolean): string {
  const rows: string[] = [];
  const merges: string[] = [];
  let lastColumn = 0;
  sheet.rows.slice(0, LIMITS.rows).forEach((row, r) => {
    const cells: string[] = [];
    row.slice(0, LIMITS.columns).forEach((cell, c) => {
      if (!cell) return;
      const ref = `${columnName(c)}${r + 1}`;
      lastColumn = Math.max(lastColumn, c + (cell.columns ?? 1) - 1);
      if ((cell.columns ?? 1) > 1 || (cell.rows ?? 1) > 1) {
        const end = `${columnName(Math.min(LIMITS.columns - 1, c + (cell.columns ?? 1) - 1))}${Math.min(LIMITS.rows, r + (cell.rows ?? 1))}`;
        merges.push(`<mergeCell ref="${ref}:${end}"/>`);
      }
      const s = styles.index(cell);
      const style = s > 0 ? ` s="${s}"` : '';
      if (cell.value.kind === 'number') {
        cells.push(`<c r="${ref}"${style}><v>${cell.value.value}</v></c>`);
      } else if (cell.value.text.length > 0) {
        const text = cell.value.text.slice(0, LIMITS.cell);
        cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`);
      }
    });
    if (cells.length > 0) rows.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  const dimension = `<dimension ref="A1:${columnName(lastColumn)}${Math.max(1, sheet.rows.length)}"/>`;
  const view = `<sheetViews><sheetView${first ? ' tabSelected="1"' : ''}${sheet.rtl ? ' rightToLeft="1"' : ''} workbookViewId="0"/></sheetViews>`;
  const widths = sheet.widths
    .map((w, k) => (w > 0 ? `<col min="${k + 1}" max="${k + 1}" width="${Math.min(255, Math.max(1, w))}" customWidth="1"/>` : ''))
    .join('');
  const cols = widths ? `<cols>${widths}</cols>` : '';
  const mergeCells = merges.length > 0 ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '';
  // CT_Worksheet's order: dimension, sheetViews, sheetFormatPr, cols, sheetData, …, mergeCells, …, pageMargins.
  return (
    `${DECLARATION}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${dimension}${view}<sheetFormatPr defaultRowHeight="15"/>${cols}` +
    `<sheetData>${rows.join('')}</sheetData>${mergeCells}` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
  );
}

function workbookXml(names: readonly string[]): string {
  const sheets = names.map((name, k) => `<sheet name="${xmlAttribute(name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('');
  return `${DECLARATION}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>${sheets}</sheets></workbook>`;
}

function workbookRelsXml(count: number): string {
  const sheets = Array.from(
    { length: count },
    (_, k) => `<Relationship Id="rId${k + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`,
  ).join('');
  return `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}">${sheets}<Relationship Id="rId${count + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;
}

function contentTypesXml(count: number): string {
  const sheets = Array.from(
    { length: count },
    (_, k) =>
      `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return (
    `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    `${sheets}</Types>`
  );
}

function packageRelsXml(): string {
  return `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

/** The parts of a workbook of `sheets`, before they are zipped: path to XML. */
export function xlsxParts(sheets: readonly Sheet[]): Record<string, string> {
  const names = sheetNames(sheets.map((s) => s.name));
  const styles = new Styles();
  const parts: Record<string, string> = {};
  sheets.forEach((sheet, k) => {
    parts[`xl/worksheets/sheet${k + 1}.xml`] = worksheetXml(sheet, styles, k === 0);
  });
  parts['[Content_Types].xml'] = contentTypesXml(sheets.length);
  parts['_rels/.rels'] = packageRelsXml();
  parts['xl/workbook.xml'] = workbookXml(names);
  parts['xl/_rels/workbook.xml.rels'] = workbookRelsXml(sheets.length);
  parts['xl/styles.xml'] = styles.xml();
  return parts;
}

/** The .xlsx: one sheet for each of `sheets`. */
export function buildXlsx(sheets: readonly Sheet[]): Uint8Array<ArrayBuffer> {
  const parts = xlsxParts(sheets);
  const files: Record<string, Uint8Array> = {};
  for (const [path, xml] of Object.entries(parts)) files[path] = strToU8(xml);
  return zipSync(files) as Uint8Array<ArrayBuffer>;
}
