/**
 * Edit tool service: talks to the engine's `edit.*` methods on a private engine copy of the
 * document, keeps it in sync with the app's bytes, and maps between PDF page coordinates
 * (top-left of the visible box, y down, `/Rotate` not applied — what the engine speaks) and the
 * rotated page picture shown on screen.
 */
import type { EngineClient } from './engine';

export type Box = [number, number, number, number];

export interface TextBlock {
  id: number;
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  dir: 'rtl' | 'ltr';
  size: number;
  lineHeight: number;
  lines: number;
  color: string;
  bold: boolean;
  italic: boolean;
  family: 'serif' | 'sans';
  font: string;
  editable: boolean;
  reason?: string;
}

export interface ImageInfo {
  id: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  rotation: number;
  crop?: Box;
  width: number;
  height: number;
  inline: boolean;
  name?: string;
}

export interface UrlCheck {
  verdict: 'ok' | 'warn' | 'reject';
  scheme: string;
  host: string;
  asciiHost: string;
  url: string;
  problems: string[];
}

export interface LinkInfo {
  id: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  uri?: string;
  page?: number;
  check?: UrlCheck;
}

export interface PageGeometry {
  /** Visible box size in points (unrotated). */
  width: number;
  height: number;
  /** 0, 90, 180, 270 (clockwise). */
  rotation: number;
}

export interface PageContents {
  blocks: TextBlock[];
  images: ImageInfo[];
  links: LinkInfo[];
}

export interface Point {
  x: number;
  y: number;
}

/** Page point (unrotated, points) → displayed point (rotated, points). */
export function toView(g: PageGeometry, p: Point): Point {
  switch (g.rotation) {
    case 90:
      return { x: g.height - p.y, y: p.x };
    case 180:
      return { x: g.width - p.x, y: g.height - p.y };
    case 270:
      return { x: p.y, y: g.width - p.x };
    default:
      return p;
  }
}

/** Displayed point → page point. */
export function fromView(g: PageGeometry, v: Point): Point {
  switch (g.rotation) {
    case 90:
      return { x: v.y, y: g.height - v.x };
    case 180:
      return { x: g.width - v.x, y: g.height - v.y };
    case 270:
      return { x: g.width - v.y, y: v.x };
    default:
      return v;
  }
}

export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Page box → displayed rectangle (points). */
export function rectToView(g: PageGeometry, b: { x0: number; y0: number; x1: number; y1: number }): ViewRect {
  const a = toView(g, { x: b.x0, y: b.y0 });
  const c = toView(g, { x: b.x1, y: b.y1 });
  return { left: Math.min(a.x, c.x), top: Math.min(a.y, c.y), width: Math.abs(c.x - a.x), height: Math.abs(c.y - a.y) };
}

/** Displayed rectangle → page box. */
export function rectFromView(g: PageGeometry, r: ViewRect): Box {
  const a = fromView(g, { x: r.left, y: r.top });
  const c = fromView(g, { x: r.left + r.width, y: r.top + r.height });
  return [Math.min(a.x, c.x), Math.min(a.y, c.y), Math.max(a.x, c.x), Math.max(a.y, c.y)];
}

/** Displayed delta → page delta. */
export function deltaFromView(g: PageGeometry, dx: number, dy: number): Point {
  const o = fromView(g, { x: 0, y: 0 });
  const p = fromView(g, { x: dx, y: dy });
  return { x: p.x - o.x, y: p.y - o.y };
}

export type EditReply = { json: Record<string, unknown>; bytes: Uint8Array };

/**
 * The engine copy of one open document for editing. `sync(bytes)` (re)opens it when the app's
 * bytes changed underneath (undo/redo, a save, PDFium edits folded in).
 */
export class DocEditor {
  private synced: Uint8Array | null = null;
  private readonly engineId: string;
  constructor(
    private readonly engine: EngineClient,
    docId: string,
  ) {
    this.engineId = `${docId}:edit`;
  }

  async sync(bytes: Uint8Array): Promise<void> {
    if (this.synced === bytes) return;
    await this.engine.open(this.engineId, bytes);
    this.synced = bytes;
  }

  /** Folds PDFium's unsaved edits into `base` as an incremental update (engine `doc.rebase`). */
  async fold(base: Uint8Array, pdfium: Uint8Array): Promise<Uint8Array> {
    await this.sync(base);
    const r = await this.engine.call<{ mode: string }>(this.engineId, 'doc.rebase', {}, [pdfium.slice()]);
    const out = r.blobs[0] ?? base;
    this.synced = out;
    return out;
  }

  async info(pageIndex: number): Promise<PageGeometry & { pageCount: number }> {
    const r = await this.engine.call<{ pageCount: number; pages: { width: number; height: number; rotation: number }[] }>(this.engineId, 'doc.info');
    const p = r.json.pages[pageIndex] ?? { width: 612, height: 792, rotation: 0 };
    return { width: p.width, height: p.height, rotation: ((p.rotation % 360) + 360) % 360, pageCount: r.json.pageCount };
  }

  async contents(page: number): Promise<PageContents> {
    const [b, i, l] = await Promise.all([
      this.engine.call<{ blocks: TextBlock[] }>(this.engineId, 'edit.textBlocks', { page }),
      this.engine.call<{ images: ImageInfo[] }>(this.engineId, 'edit.images', { page }),
      this.engine.call<{ links: LinkInfo[] }>(this.engineId, 'edit.links', { page }),
    ]);
    return { blocks: b.json.blocks, images: i.json.images, links: l.json.links };
  }

  /** A mutating call: returns the new file (an incremental update of the synced bytes). */
  async edit(method: string, params: Record<string, unknown>, blobs: Uint8Array[] = []): Promise<EditReply> {
    const r = await this.engine.call<Record<string, unknown>>(this.engineId, method, params, blobs);
    const bytes = r.blobs[0];
    if (!bytes) throw new Error('engine returned no document');
    this.synced = bytes;
    return { json: r.json, bytes };
  }

  async close(): Promise<void> {
    this.synced = null;
    await this.engine.close(this.engineId).catch(() => {});
  }
}

/** Link target check (bidi controls, look-alike hosts) from the engine. */
export async function checkUrl(engine: EngineClient, url: string): Promise<UrlCheck> {
  const r = await engine.callStatic<UrlCheck>('edit.checkUrl', { url });
  return r.json;
}

/** Only these schemes are ever opened from a document. */
export function openableScheme(c: UrlCheck): boolean {
  return c.scheme === 'http' || c.scheme === 'https' || c.scheme === 'mailto';
}
