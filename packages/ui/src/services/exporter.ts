/**
 * Export: Word, Excel, PowerPoint, HTML, Markdown and text come from the engine (`export.*`,
 * warraq-office, logical-order text + detected tables); PNG pages are rendered by PDFium in the
 * viewer (the default wasm has no raster backend, see ADR 0013) and several pages are zipped by
 * the engine (`export.zip`).
 */
import type { EngineClient } from './engine';
import type { IconName } from '../app/icons';
import type { MessageKey } from '../i18n';

export type ExportFormatId = 'docx' | 'xlsx' | 'pptx' | 'html' | 'markdown' | 'text' | 'png';

export interface ExportFormat {
  id: ExportFormatId;
  ext: string;
  icon: IconName;
  nameKey: MessageKey;
  descKey: MessageKey;
}

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  { id: 'docx', ext: 'docx', icon: 'doc', nameKey: 'export.format.docx', descKey: 'export.format.docx.desc' },
  { id: 'xlsx', ext: 'xlsx', icon: 'table', nameKey: 'export.format.xlsx', descKey: 'export.format.xlsx.desc' },
  { id: 'pptx', ext: 'pptx', icon: 'slides', nameKey: 'export.format.pptx', descKey: 'export.format.pptx.desc' },
  { id: 'html', ext: 'html', icon: 'globe', nameKey: 'export.format.html', descKey: 'export.format.html.desc' },
  { id: 'markdown', ext: 'md', icon: 'markdown', nameKey: 'export.format.markdown', descKey: 'export.format.markdown.desc' },
  { id: 'text', ext: 'txt', icon: 'text', nameKey: 'export.format.text', descKey: 'export.format.text.desc' },
  { id: 'png', ext: 'png', icon: 'image', nameKey: 'export.format.png', descKey: 'export.format.png.desc' },
];

/** Arabic-Indic (٠–٩) and Persian (۰–۹) digits → ASCII. */
export function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) => String((c.charCodeAt(0) & 0xf) % 10));
}

/**
 * Parses a 1-based page range ("1-3, 5", "١-٣، ٥", "3-") into sorted-as-given, de-duplicated
 * 0-based indices. Empty input means every page. `null` when invalid or outside `1..count`.
 */
export function parsePageRange(input: string, count: number): number[] | null {
  const s = toAsciiDigits(input)
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .trim();
  if (!s) return Array.from({ length: count }, (_, i) => i);
  const out: number[] = [];
  for (const part of s.split(/[,،;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d*))?$/.exec(part);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : m[2] === '' ? count : Number(m[2]);
    if (from < 1 || to > count || from > to || to - from > 100_000) return null;
    for (let p = from; p <= to; p++) if (!out.includes(p - 1)) out.push(p - 1);
  }
  return out.length ? out : null;
}

/** `name.pdf` → `name.<ext>` (or `name-<page>.<ext>` for one page of a picture export). */
export function exportFileName(docName: string, ext: string, page?: number): string {
  const base = docName.replace(/\.pdf$/i, '') || 'document';
  return page === undefined ? `${base}.${ext}` : `${base}-${page}.${ext}`;
}

export interface ExportRequest {
  engine: EngineClient;
  /** Current document bytes (the engine opens a private copy; the document is never modified). */
  bytes: Uint8Array;
  name: string;
  format: ExportFormatId;
  /** 0-based page indices. */
  pages: number[];
  title?: string;
  /** Localised sheet name prefixes (XLSX). */
  sheetNames?: { table: string; text: string };
  /** PNG of one page (0-based), for the picture export. */
  renderPage?: (page: number) => Promise<Uint8Array>;
}

export interface ExportResult {
  name: string;
  bytes: Uint8Array;
}

let seq = 0;

export async function runExport(req: ExportRequest): Promise<ExportResult> {
  const fmt = EXPORT_FORMATS.find((f) => f.id === req.format);
  if (!fmt) throw new Error(`unknown format ${req.format}`);
  if (fmt.id === 'png') {
    if (!req.renderPage) throw new Error('page rendering unavailable');
    const pngs: Uint8Array[] = [];
    for (const p of req.pages) pngs.push(await req.renderPage(p));
    if (pngs.length === 1) return { name: exportFileName(req.name, 'png', req.pages[0]! + 1), bytes: pngs[0]! };
    const names = req.pages.map((p) => exportFileName(req.name, 'png', p + 1));
    const r = await req.engine.callStatic('export.zip', { names }, pngs);
    return { name: exportFileName(req.name, 'zip'), bytes: r.blobs[0]! };
  }
  const docId = `export-${Date.now().toString(36)}-${++seq}`;
  await req.engine.open(docId, req.bytes);
  try {
    const params: Record<string, unknown> = { pages: req.pages };
    if (req.title) params.title = req.title;
    if (req.sheetNames && fmt.id === 'xlsx') params.sheetNames = req.sheetNames;
    const r = await req.engine.call(docId, `export.${fmt.id}`, params);
    const bytes = r.blobs[0];
    if (!bytes) throw new Error('the engine returned no file');
    return { name: exportFileName(req.name, fmt.ext), bytes };
  } finally {
    await req.engine.close(docId).catch(() => {});
  }
}
