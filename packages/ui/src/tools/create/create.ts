/**
 * Create PDF: which files the engine can turn into PDF (`create.fromFiles` in warraq-create) and
 * the call itself. Everything happens in the engine worker; nothing leaves the device.
 */
import type { EngineClient } from '../../services/engine';
import type { OpenedFile } from '../../services/host';
import type { MessageKey } from '../../i18n';

export type CreateKind = 'word' | 'excel' | 'powerpoint' | 'web' | 'markdown' | 'text' | 'table' | 'picture';

const KINDS: Record<string, CreateKind> = {
  docx: 'word',
  xlsx: 'excel',
  pptx: 'powerpoint',
  html: 'web',
  htm: 'web',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  csv: 'table',
  tsv: 'table',
  jpg: 'picture',
  jpeg: 'picture',
  png: 'picture',
  tif: 'picture',
  tiff: 'picture',
};

/** File-picker accept list (extensions + MIME types). */
export const CREATE_ACCEPT: string[] = [
  ...Object.keys(KINDS).map((e) => `.${e}`),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/csv',
  'image/jpeg',
  'image/png',
  'image/tiff',
];

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1]!.toLowerCase() : '';
}

/** What a file is, or null when Create PDF cannot read it. */
export function createKind(name: string): CreateKind | null {
  return KINDS[extensionOf(name)] ?? null;
}

export const KIND_LABEL: Record<CreateKind, MessageKey> = {
  word: 'create.kind.word',
  excel: 'create.kind.excel',
  powerpoint: 'create.kind.powerpoint',
  web: 'create.kind.web',
  markdown: 'create.kind.markdown',
  text: 'create.kind.text',
  table: 'create.kind.table',
  picture: 'create.kind.picture',
};

export type PageSize = 'auto' | 'a4' | 'letter';
export type Orientation = 'auto' | 'portrait' | 'landscape';
export type Margins = 'normal' | 'narrow' | 'wide';

export interface CreateSettings {
  pageSize: PageSize;
  orientation: Orientation;
  margins: Margins;
  /** One PDF for all files (default) or one PDF per file. */
  merge: boolean;
  pageNumbers: boolean;
}

export const DEFAULT_SETTINGS: CreateSettings = {
  pageSize: 'auto',
  orientation: 'auto',
  margins: 'normal',
  merge: true,
  pageNumbers: false,
};

export interface CreatedPdf {
  name: string;
  bytes: Uint8Array;
  pageCount: number;
}

interface CreateReply {
  documents: { name: string; pageCount: number; byteLength: number }[];
}

/** Runs `create.fromFiles` in the engine. Blobs are copied (the originals stay usable). */
export async function createPdfs(
  engine: EngineClient,
  files: OpenedFile[],
  settings: CreateSettings,
  locale: string,
): Promise<CreatedPdf[]> {
  const params = {
    files: files.map((f) => ({ name: f.name })),
    pageSize: settings.pageSize,
    orientation: settings.orientation,
    margins: settings.margins,
    merge: settings.merge,
    pageNumbers: settings.pageNumbers,
    locale,
  };
  const reply = await engine.callStatic<CreateReply>(
    'create.fromFiles',
    params,
    files.map((f) => f.bytes.slice()),
  );
  return reply.json.documents.map((d, i) => ({ name: d.name, pageCount: d.pageCount, bytes: reply.blobs[i] ?? new Uint8Array() }));
}

/** Localised message for an engine error code. */
export function createErrorKey(code: string | undefined): MessageKey {
  switch (code) {
    case 'unsupported_format':
      return 'create.error.unsupported';
    case 'malformed_input':
      return 'create.error.malformed';
    case 'limit_exceeded':
      return 'create.error.limit';
    default:
      return 'create.error.generic';
  }
}

/** Move item `i` by `delta` places (bounded). */
export function move<T>(list: T[], i: number, delta: number): T[] {
  const j = i + delta;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const out = list.slice();
  const [x] = out.splice(i, 1);
  out.splice(j, 0, x!);
  return out;
}
