/**
 * Arabic-aware search and logical-order copy inside the EmbedPDF view (docs/SPEC.md §3, ADR 0017).
 *
 * EmbedPDF searches and copies with PDFium's text page, which assumes glyphs are drawn in visual order
 * and reverses every right-to-left run: an Arabic `/ActualText` comes back reversed, a lam-alef cluster
 * of a Chrome-made PDF as «ال», marks detached from their letters, `50%` as `%50` — and its search is
 * literal (no tashkeel/alef/yaa folding). The viewer therefore answers EmbedPDF's two text questions with
 * the engine (warraq-text: logical order, Arabic-aware normalisation):
 * * `searchAllPages` → `redact.find` (the same search the Redact tool uses), hits in viewer page space;
 * * `getTextSlices` (copy of a selection) → the engine's words whose glyphs lie inside the selected
 *   PDFium characters' boxes, in logical order.
 * Anything the engine cannot answer (a rotated page, an engine error) falls back to PDFium.
 */
import type { EngineClient } from '../services/engine';

/** [x0, y0, x1, y1], points from the top-left of the page (y down). */
export type Box = [number, number, number, number];

export interface TextHit {
  page: number;
  text: string;
  rects: Box[];
}

/** What the viewer asks the engine. */
export interface ViewerTextProvider {
  search(query: string): Promise<TextHit[]>;
  /** Logical-order text of the page area covered by `rects` (viewer page space, unrotated page). */
  textIn(page: number, rects: Box[]): Promise<string>;
}

interface GlyphBox {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface Word {
  text: string;
  bbox: GlyphBox['bbox'];
  glyphs?: GlyphBox[];
}
interface Line {
  words: Word[];
}
export interface PageText {
  page: number;
  blocks: { paragraphs: { lines: Line[] }[] }[];
}

/** The engine's words (logical order) whose glyph centres lie inside `rects`, lines joined by "\n". */
export function selectionText(page: PageText, rects: Box[], slack = 1): string {
  const inside = (b: GlyphBox['bbox']) => {
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    return rects.some(([x0, y0, x1, y1]) => cx >= x0 - slack && cx <= x1 + slack && cy >= y0 - slack && cy <= y1 + slack);
  };
  const lines: string[] = [];
  for (const block of page.blocks)
    for (const para of block.paragraphs)
      for (const line of para.lines) {
        const words: string[] = [];
        for (const w of line.words) {
          const glyphs = w.glyphs?.length ? w.glyphs : [{ text: w.text, bbox: w.bbox }];
          const picked = glyphs.filter((g) => inside(g.bbox));
          if (picked.length === glyphs.length) words.push(w.text);
          else if (picked.length) words.push(picked.map((g) => g.text).join(''));
        }
        if (words.length) lines.push(words.join(' '));
      }
  return lines.join('\n');
}

/** A provider over the engine for one revision of a document (opened once, closed with `close`). */
export function engineTextProvider(engine: EngineClient, bytes: Uint8Array, password: string | undefined): ViewerTextProvider & { close(): void } {
  const docId = `viewer-text-${Math.random().toString(36).slice(2, 10)}`;
  let opened: Promise<unknown> | null = null;
  const open = () => (opened ??= engine.open(docId, bytes, password));
  const pages = new Map<number, Promise<PageText | null>>();
  const pageText = (page: number) => {
    let p = pages.get(page);
    if (!p) {
      p = open()
        .then(() => engine.call<{ pages: PageText[] }>(docId, 'text.extract', { pages: [page], glyphs: true }))
        .then((r) => r.json.pages[0] ?? null);
      pages.set(page, p);
    }
    return p;
  };
  return {
    async search(query) {
      await open();
      const r = await engine.call<{ hits: { page: number; text: string; viewRects: Box[] }[] }>(docId, 'redact.find', { query });
      return r.json.hits.map((h) => ({ page: h.page, text: h.text, rects: h.viewRects }));
    },
    async textIn(page, rects) {
      const t = await pageText(page);
      return t ? selectionText(t, rects) : '';
    },
    close() {
      if (opened) void opened.then(() => engine.close(docId)).catch(() => {});
    },
  };
}

// ---- EmbedPDF engine hooks ----

type Rect = { origin: { x: number; y: number }; size: { width: number; height: number } };
interface TaskLike<T> {
  wait(ok: (v: T) => void, fail: (e: unknown) => void): void;
  onProgress(cb: (p: unknown) => void): void;
  abort(reason?: unknown): void;
  toPromise(): Promise<T>;
}
interface PdfDoc {
  id: string;
  pages: { index: number; rotation?: number; size: { width: number; height: number } }[];
}
interface Slice {
  pageIndex: number;
  charIndex: number;
  charCount: number;
}
interface Geometry {
  runs: { charStart: number; glyphs: { x: number; y: number; width: number; height: number; flags?: number }[] }[];
}
export interface HookableEngine {
  searchAllPages(doc: PdfDoc, keyword: string, options?: { flags?: unknown }): TaskLike<unknown>;
  getTextSlices(doc: PdfDoc, slices: Slice[]): TaskLike<string[]>;
  getPageGeometry(doc: PdfDoc, page: PdfDoc['pages'][number]): TaskLike<Geometry>;
}

/** A task EmbedPDF's plugins can consume (`wait`, `onProgress`, `abort`) resolved by `work`. */
export function taskOf<T>(work: Promise<T>): TaskLike<T> {
  let aborted = false;
  return {
    wait(ok, fail) {
      work.then(
        (v) => {
          if (!aborted) ok(v);
        },
        (e) => {
          if (!aborted) fail({ type: 'reject', reason: { code: 0, message: e instanceof Error ? e.message : String(e) } });
        },
      );
    },
    onProgress() {},
    abort() {
      aborted = true;
    },
    toPromise: () => work,
  };
}

const noFlags = (flags: unknown) => flags == null || flags === 0 || (Array.isArray(flags) && flags.length === 0);

/** PDFium character boxes of `slice` (viewer page space). */
async function sliceRects(engine: HookableEngine, doc: PdfDoc, slice: Slice): Promise<Box[]> {
  const page = doc.pages[slice.pageIndex];
  if (!page) return [];
  const geo = await engine.getPageGeometry(doc, page).toPromise();
  const out: Box[] = [];
  const end = slice.charIndex + slice.charCount;
  for (const run of geo.runs) {
    run.glyphs.forEach((g, k) => {
      const i = run.charStart + k;
      if (i >= slice.charIndex && i < end && g.width > 0 && g.height > 0) out.push([g.x, g.y, g.x + g.width, g.y + g.height]);
    });
  }
  return out;
}

/**
 * Answers `documentId`'s search and copy with `provider` (other documents of the engine — Compare's
 * second file — keep PDFium). Returns the function that restores the engine.
 */
export function hookEngineText(engine: HookableEngine, documentId: string, provider: ViewerTextProvider): () => void {
  const search = engine.searchAllPages.bind(engine);
  const slices = engine.getTextSlices.bind(engine);
  engine.searchAllPages = (doc, keyword, options) => {
    if (doc.id !== documentId || !noFlags(options?.flags)) return search(doc, keyword, options);
    return taskOf(
      provider.search(keyword).then((hits) => {
        const results = hits.map((h) => ({
          pageIndex: h.page,
          charIndex: 0,
          charCount: h.text.length,
          rects: h.rects.map(([x0, y0, x1, y1]): Rect => ({ origin: { x: x0, y: y0 }, size: { width: x1 - x0, height: y1 - y0 } })),
          context: { before: '', match: h.text, after: '', truncatedLeft: false, truncatedRight: false },
        }));
        return { results, total: results.length };
      }),
    );
  };
  engine.getTextSlices = (doc, list) => {
    if (doc.id !== documentId) return slices(doc, list);
    return taskOf(
      (async () => {
        const out: string[] = [];
        for (const s of list) {
          const rotation = doc.pages[s.pageIndex]?.rotation ?? 0;
          let text: string | null = null;
          if (rotation === 0) {
            try {
              const rects = await sliceRects(engine, doc, s);
              text = rects.length ? await provider.textIn(s.pageIndex, rects) : null;
            } catch {
              text = null;
            }
          }
          out.push(text || ((await slices(doc, [s]).toPromise())[0] ?? ''));
        }
        return out;
      })(),
    );
  };
  return () => {
    engine.searchAllPages = search;
    engine.getTextSlices = slices;
  };
}
