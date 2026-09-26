/**
 * Redact and Protect through the Rust engine. Every call opens the given bytes in a temporary engine
 * document (with the password when the file is protected), runs one method and closes it again, so the
 * engine never holds a stale copy. Redaction, "remove hidden information" and password changes are whole
 * rewrites with a single revision (docs/SPEC.md §1).
 */
import type { EngineClient } from './engine';

export type PatternKind = 'email' | 'phone' | 'saudiId' | 'iban' | 'card' | 'date';
export const PATTERN_KINDS: PatternKind[] = ['email', 'phone', 'saudiId', 'iban', 'card', 'date'];
export type HitKind = PatternKind | 'query' | 'custom';

/** [x0, y0, x1, y1] */
export type Box = [number, number, number, number];

export interface FindHit {
  page: number;
  kind: HitKind;
  text: string;
  /** PDF user space (y up). */
  rects: Box[];
  /** Viewer page space: points from the top-left of the displayed page (y down). */
  viewRects: Box[];
}

export interface FindReply {
  hits: FindHit[];
  pages: { width: number; height: number; rotation: number }[];
  truncated: boolean;
}

export interface FindParams {
  query?: string;
  patterns?: PatternKind[];
  regex?: string;
}

export interface ContentReport {
  glyphsRemoved: number;
  hiddenGlyphsRemoved: number;
  imagesRedacted: number;
  imagesRemoved: number;
  inlineImagesRedacted: number;
  inlineImagesRemoved: number;
  pathsRemoved: number;
  pathsClipped: number;
  formsRewritten: number;
  undecodable?: string[];
}

export interface ApplyReport {
  pages: number[];
  areas: number;
  redactAnnotations: number;
  annotationsRemoved: number;
  stringsScrubbed: number;
  content: ContentReport;
}

export interface SanitizeOptions {
  metadata: boolean;
  xmp: boolean;
  javascript: boolean;
  actions: boolean;
  attachments: boolean;
  comments: boolean;
  forms: 'keep' | 'clear' | 'flatten';
  hiddenLayers: boolean;
  bookmarks: boolean;
  thumbnails: boolean;
  pieceInfo: boolean;
  links: boolean;
  hiddenText: boolean;
}

/** All on except links and bookmarks. */
export const DEFAULT_SANITIZE: SanitizeOptions = {
  metadata: true,
  xmp: true,
  javascript: true,
  actions: true,
  attachments: true,
  comments: true,
  forms: 'clear',
  hiddenLayers: true,
  bookmarks: false,
  thumbnails: true,
  pieceInfo: true,
  links: false,
  hiddenText: true,
};

export type SanitizeReport = Record<
  | 'metadata'
  | 'xmp'
  | 'javascript'
  | 'actions'
  | 'attachments'
  | 'comments'
  | 'formFields'
  | 'hiddenLayers'
  | 'bookmarks'
  | 'thumbnails'
  | 'pieceInfo'
  | 'links'
  | 'hiddenText'
  | 'earlierRevisions'
  | 'orphans',
  number
>;

export interface Permissions {
  print: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
  fillForms: boolean;
  accessibility: boolean;
  assemble: boolean;
  printHighQuality: boolean;
}

export const ALL_PERMISSIONS: Permissions = {
  print: true,
  modify: true,
  copy: true,
  annotate: true,
  fillForms: true,
  accessibility: true,
  assemble: true,
  printHighQuality: true,
};

export interface DocInfo {
  encrypted: boolean;
  passwordMatched: 'owner' | 'user' | null;
  permissions: Permissions;
  encryption: { method: string; revision: number } | null;
  pageCount: number;
}

let tmp = 0;

async function withDoc<T>(engine: EngineClient, bytes: Uint8Array, password: string | undefined, run: (id: string, info: DocInfo) => Promise<T>): Promise<T> {
  const id = `tool-${++tmp}`;
  const opened = await engine.open(id, bytes, password);
  try {
    return await run(id, opened.json as DocInfo);
  } finally {
    engine.close(id).catch(() => {});
  }
}

export function docInfo(engine: EngineClient, bytes: Uint8Array, password?: string): Promise<DocInfo> {
  return withDoc(engine, bytes, password, async (_id, info) => info);
}

export function findInDocument(engine: EngineClient, bytes: Uint8Array, password: string | undefined, params: FindParams): Promise<FindReply> {
  return withDoc(engine, bytes, password, async (id) => (await engine.call<FindReply>(id, 'redact.find', params)).json);
}

export interface ApplyParams {
  /** Extra areas (user space) besides the /Redact marks in the file. */
  areas: { page: number; rect: Box }[];
  overlayText?: string;
  /** Fill colour (0–1 RGB) or null for no box. */
  fill?: [number, number, number] | null;
}

export async function applyRedactions(
  engine: EngineClient,
  bytes: Uint8Array,
  password: string | undefined,
  params: ApplyParams,
  font?: Uint8Array,
): Promise<{ bytes: Uint8Array; report: ApplyReport; revisions: number }> {
  return withDoc(engine, bytes, password, async (id) => {
    const body: Record<string, unknown> = { areas: params.areas, annotations: true };
    if (params.overlayText) body.overlayText = params.overlayText;
    if (params.fill !== undefined) body.fill = params.fill;
    const r = await engine.call<{ report: ApplyReport; revisions: number }>(id, 'redact.apply', body, font ? [font.slice()] : []);
    return { bytes: r.blobs[0]!, report: r.json.report, revisions: r.json.revisions };
  });
}

export async function sanitizeDocument(
  engine: EngineClient,
  bytes: Uint8Array,
  password: string | undefined,
  options: SanitizeOptions,
): Promise<{ bytes: Uint8Array; report: SanitizeReport }> {
  return withDoc(engine, bytes, password, async (id) => {
    const r = await engine.call<{ report: SanitizeReport }>(id, 'redact.sanitize', options);
    return { bytes: r.blobs[0]!, report: r.json.report };
  });
}

export async function setProtection(
  engine: EngineClient,
  bytes: Uint8Array,
  password: string | undefined,
  params: { userPassword: string; ownerPassword: string; permissions: Permissions },
): Promise<Uint8Array> {
  return withDoc(engine, bytes, password, async (id) => (await engine.call(id, 'protect.set', params)).blobs[0]!);
}

export async function removeProtection(engine: EngineClient, bytes: Uint8Array, password: string | undefined, ownerPassword?: string): Promise<Uint8Array> {
  return withDoc(engine, bytes, password, async (id) => (await engine.call(id, 'protect.remove', ownerPassword ? { ownerPassword } : {})).blobs[0]!);
}

/** `needsPassword`: the file cannot be opened without one. */
export async function encryptionOf(engine: EngineClient, bytes: Uint8Array): Promise<{ encrypted: boolean; needsPassword: boolean }> {
  return (await engine.callStatic<{ encrypted: boolean; needsPassword: boolean }>('pdf.isEncrypted', {}, [bytes.slice()])).json;
}

/** Checks a password: resolves true when the engine opens the file with it. */
export async function passwordOpens(engine: EngineClient, bytes: Uint8Array, password: string): Promise<boolean> {
  try {
    await docInfo(engine, bytes, password);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'wrong_password' || code === 'password_required') return false;
    throw e;
  }
}

/** Groups hits by page, pages ascending. */
export function hitsByPage(hits: FindHit[]): { page: number; hits: { hit: FindHit; index: number }[] }[] {
  const groups = new Map<number, { hit: FindHit; index: number }[]>();
  hits.forEach((hit, index) => {
    const g = groups.get(hit.page) ?? [];
    g.push({ hit, index });
    groups.set(hit.page, g);
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([page, list]) => ({ page, hits: list }));
}
