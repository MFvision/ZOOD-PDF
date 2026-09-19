import type { ReadDocument, TableCell } from './blocks';
import { decodeText } from './text';

const MAX_ROWS = 5_000;
const MAX_COLUMNS = 60;

/** Comma-separated values as rows: quoted fields may hold commas, quotes and line breaks. */
export function parseCsv(text: string, separator?: string): string[][] {
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  // Excel in Arabic and European locales writes semicolons; tabs are TSV.
  const sep = separator ?? ([',', ';', '\t'].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0]);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < MAX_ROWS; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A CSV file as one table, numbers set to the end of their cells. */
export function readCsv(bytes: Uint8Array): ReadDocument {
  const rows = parseCsv(decodeText(bytes).replace(/^\uFEFF/, ''));
  const truncated = rows.length >= MAX_ROWS || rows.some((r) => r.length > MAX_COLUMNS);
  const width = Math.min(MAX_COLUMNS, Math.max(0, ...rows.map((r) => r.length)));
  const table: TableCell[][] = rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) =>
      Array.from({ length: width }, (_, k) => {
        const text = (r[k] ?? '').trim();
        const cell: TableCell = { text };
        if (/^[-+]?[\d٠-٩.,٫٬]+%?$/.test(text)) cell.align = 'end';
        return cell;
      }),
    );
  const landscape = width > 6;
  return {
    blocks: table.length > 0 ? [{ type: 'table', rows: table, headerRows: 1, size: width > 10 ? 7 : 9 }] : [],
    pictures: [],
    page: landscape ? { width: 841.89, height: 595.28, margins: [36, 36, 36, 36] } : { width: 595.28, height: 841.89, margins: [36, 36, 36, 36] },
    picturesLeftOut: 0,
    truncated,
  };
}
