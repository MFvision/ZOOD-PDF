import { MatchFlag, PdfErrorCode, PdfTaskHelper, TaskStage } from '@embedpdf/models';
import type {
  PageTextSlice,
  PdfDocumentObject,
  PdfErrorReason,
  PdfPageGeometry,
  PdfPageObject,
  PdfPageSearchProgress,
  PdfTask,
  SearchAllPagesResult,
  SearchResult,
} from '@embedpdf/models';
import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';
import { capability } from './embedControl';
import type { PageBox } from './embedControl';

/**
 * Search and copy in EmbedPDF's view, answered by Warraq's reader (ADR-0007).
 *
 * PDFium reads most Arabic files out of logical order — reversed, as
 * presentation forms, or as the raw codes of unmapped glyphs — so its search
 * misses words a person can see, and what it copies pastes garbled. EmbedPDF
 * keeps its own search panel, highlights, next and previous, and selection;
 * the two engine calls behind them are answered by Warraq's core instead:
 *
 * - `searchAllPages`: Warraq's Arabic-aware search (`view.search`) —
 *   diacritics ignored, alef, taa marbuta, yaa and digit forms unified — with
 *   the boxes of each hit's glyphs, which EmbedPDF highlights. What PDFium
 *   also finds where Warraq finds nothing (a running head, a watermark:
 *   Warraq's reader leaves page artifacts out) is kept beside it.
 * - `getTextSlices`, which Copy reads: the glyphs PDFium selected are
 *   measured on the page, and Warraq's core reads the text inside them in
 *   logical order (`view.text`) — wherever the selection has Arabic script.
 *
 * Every plugin holds the one engine object the registry made, so the calls
 * are replaced on it; when Warraq has no reading of the file, or its core
 * fails, PDFium's own answer stands.
 */

/** The engine calls replaced here, as EmbedPDF's plugins make them. */
interface TextEngine {
  searchAllPages(
    doc: PdfDocumentObject,
    keyword: string,
    options?: { flags?: MatchFlag[] },
  ): PdfTask<SearchAllPagesResult, PdfPageSearchProgress>;
  getTextSlices(doc: PdfDocumentObject, slices: PageTextSlice[]): PdfTask<string[]>;
  getPageGeometry(doc: PdfDocumentObject, page: PdfPageObject): PdfTask<PdfPageGeometry>;
}

/** What `view.search` and `view.text` need of the core: an open document. */
export interface TextReading {
  call<T>(op: string, args?: unknown): Promise<{ result: T }>;
}

/** Warraq's reading of the file as the view shows it; null to leave PDFium's answers. */
export type Reading = () => Promise<TextReading | null>;

/** One hit of `view.search`. */
export interface WarraqHit {
  page: number;
  text: string;
  before: string;
  after: string;
  truncatedLeft: boolean;
  truncatedRight: boolean;
  rects: PageBox[];
}

const rect = (box: PageBox) => ({ origin: { x: box.x, y: box.y }, size: { width: box.width, height: box.height } });

/**
 * Warraq's hits as EmbedPDF's search results. `charIndex` and `charCount`
 * name PDFium's characters, which these are not: nothing in the view reads
 * them for a hit (its highlight, list and scrolling use the boxes), so they
 * number the hits of each page instead.
 */
export function toSearchResults(hits: readonly WarraqHit[]): SearchResult[] {
  const onPage = new Map<number, number>();
  return hits
    .filter((hit) => hit.rects.length > 0)
    .map((hit) => {
      const index = onPage.get(hit.page) ?? 0;
      onPage.set(hit.page, index + 1);
      return {
        pageIndex: hit.page,
        charIndex: index,
        charCount: [...hit.text].length,
        rects: hit.rects.map(rect),
        context: {
          before: hit.before,
          match: hit.text,
          after: hit.after,
          truncatedLeft: hit.truncatedLeft,
          truncatedRight: hit.truncatedRight,
        },
      };
    });
}

const overlaps = (a: SearchResult['rects'][number], b: SearchResult['rects'][number]) =>
  a.origin.x < b.origin.x + b.size.width &&
  b.origin.x < a.origin.x + a.size.width &&
  a.origin.y < b.origin.y + b.size.height &&
  b.origin.y < a.origin.y + a.size.height;

/**
 * Warraq's results, with PDFium's that lie where Warraq found nothing — text
 * Warraq's reader leaves out, such as a page's running head — in page order,
 * top to bottom; Warraq's own keep their reading order.
 */
export function mergeResults(warraq: readonly SearchResult[], pdfium: readonly SearchResult[]): SearchResult[] {
  const extra = pdfium.filter(
    (hit) =>
      !warraq.some(
        (own) => own.pageIndex === hit.pageIndex && own.rects.some((a) => hit.rects.some((b) => overlaps(a, b))),
      ),
  );
  if (extra.length === 0) return [...warraq];
  const top = (hit: SearchResult) => Math.min(...hit.rects.map((r) => r.origin.y));
  return [...warraq, ...extra].sort((a, b) => a.pageIndex - b.pageIndex || top(a) - top(b));
}

/** A glyph of PDFium's geometry, with its character's index on the page. */
interface Glyph {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  space: boolean;
}

/**
 * The boxes of the selected characters `start..start+count` on a page, as
 * stretches of a line: selected glyphs next to each other on a line are one
 * box — so the spaces between selected words are inside it — and a glyph
 * that is not selected, between them, parts them. Points from the page's
 * top-left, as EmbedPDF measures them.
 */
export function selectedBoxes(geometry: PdfPageGeometry, start: number, count: number): PageBox[] {
  const end = start + count;
  const glyphs: Glyph[] = [];
  for (const run of geometry.runs) {
    run.glyphs.forEach((glyph, offset) => {
      // An empty glyph (flag 2) has no box at all.
      if (glyph.flags === 2 || glyph.width <= 0 || glyph.height <= 0) return;
      glyphs.push({ index: run.charStart + offset, x: glyph.x, y: glyph.y, width: glyph.width, height: glyph.height, space: glyph.flags === 1 });
    });
  }
  // Lines: glyphs whose heights overlap by half the smaller one.
  const lines: Glyph[][] = [];
  const sameLine = (a: Glyph, b: Glyph) =>
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > Math.min(a.height, b.height) / 2;
  for (const glyph of [...glyphs].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2))) {
    const line = lines.find((candidate) => sameLine(candidate[0]!, glyph));
    if (line) line.push(glyph);
    else lines.push([glyph]);
  }
  const boxes: PageBox[] = [];
  for (const line of lines) {
    let open: PageBox | null = null;
    for (const glyph of line.sort((a, b) => a.x - b.x)) {
      const selected = glyph.index >= start && glyph.index < end;
      if (!selected) {
        // A space between two selected words is theirs; anything else parts them.
        if (!glyph.space) open = null;
        continue;
      }
      if (open) {
        const x1 = Math.max(open.x + open.width, glyph.x + glyph.width);
        const y1 = Math.max(open.y + open.height, glyph.y + glyph.height);
        open.x = Math.min(open.x, glyph.x);
        open.y = Math.min(open.y, glyph.y);
        open.width = x1 - open.x;
        open.height = y1 - open.y;
      } else {
        open = { x: glyph.x, y: glyph.y, width: glyph.width, height: glyph.height };
        boxes.push(open);
      }
    }
  }
  return boxes;
}

/** Arabic script: letters, presentation forms and all. */
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Whether Warraq's reading of a selection replaces PDFium's: wherever it has
 * Arabic script — the text PDFium gets wrong — and Warraq read something.
 * Latin text PDFium reads as well, and it also has what Warraq's reader
 * leaves out (a page's running head), so there it stays PDFium's.
 */
export function prefersWarraq(pdfium: string, warraq: string): boolean {
  return warraq.trim().length > 0 && (ARABIC.test(warraq) || ARABIC.test(pdfium));
}

const pending = (task: { state: { stage: TaskStage } }) => task.state.stage === TaskStage.Pending;

const failure = (error: unknown): PdfErrorReason => ({ code: PdfErrorCode.Unknown, message: String(error) });

/**
 * Answers the view's search and copy with Warraq's reader. Returns the undo:
 * the engine's own calls back.
 */
export function installWarraqText(registry: PluginRegistry, reading: Reading): () => void {
  const engine = registry.getEngine() as unknown as TextEngine;
  const own = {
    searchAllPages: engine.searchAllPages,
    getTextSlices: engine.getTextSlices,
    getPageGeometry: engine.getPageGeometry,
  };
  const pdfium = {
    search: (doc: PdfDocumentObject, keyword: string, options?: { flags?: MatchFlag[] }) =>
      own.searchAllPages.call(engine, doc, keyword, options),
    slices: (doc: PdfDocumentObject, slices: PageTextSlice[]) => own.getTextSlices.call(engine, doc, slices),
    geometry: (doc: PdfDocumentObject, page: PdfPageObject) => own.getPageGeometry.call(engine, doc, page),
  };

  engine.searchAllPages = (doc, keyword, options) => {
    const task = PdfTaskHelper.create<SearchAllPagesResult, PdfPageSearchProgress>();
    const flags = options?.flags ?? [];
    const theirs = pdfium.search(doc, keyword, options);
    // A new search aborts this one: PDFium's goes with it.
    task.wait(
      () => undefined,
      () => {
        try {
          theirs.abort({ code: PdfErrorCode.Cancelled, message: 'search stopped' });
        } catch {
          /* already settled */
        }
      },
    );
    void (async () => {
      const found = theirs.toPromise().catch(() => ({ results: [], total: 0 }) as SearchAllPagesResult);
      try {
        const text = await reading();
        if (!text) {
          const result = await found;
          if (pending(task)) task.resolve(result);
          return;
        }
        const { result } = await text.call<{ matches: WarraqHit[]; total: number }>('view.search', {
          query: keyword,
          matchCase: flags.includes(MatchFlag.MatchCase),
          wholeWord: flags.includes(MatchFlag.MatchWholeWord),
        });
        // Warraq's hits are shown at once; PDFium, reading every page again,
        // can take seconds on a long file before what it alone finds joins them.
        const own = toSearchResults(result.matches);
        if (pending(task) && own.length > 0) task.progress({ page: Math.max(0, doc.pageCount - 1), results: own });
        const results = mergeResults(own, (await found).results);
        if (pending(task)) task.resolve({ results, total: results.length + Math.max(0, result.total - result.matches.length) });
      } catch (error) {
        const result = await found;
        if (!pending(task)) return;
        if (result.results.length > 0) task.resolve(result);
        else task.reject(failure(error));
      }
    })();
    return task;
  };

  engine.getTextSlices = (doc, slices) => {
    const task = PdfTaskHelper.create<string[]>();
    pdfium.slices(doc, slices).wait(
      (texts) => {
        void (async () => {
          try {
            const text = await reading();
            if (!text) return task.resolve(texts);
            const read = await Promise.all(
              slices.map(async (slice, i) => {
                const theirs = texts[i] ?? '';
                const page = doc.pages.find((candidate) => candidate.index === slice.pageIndex);
                if (!page) return theirs;
                const geometry = await pdfium.geometry(doc, page).toPromise();
                const boxes = selectedBoxes(geometry, slice.charIndex, slice.charCount);
                const { result } = await text.call<{ text: string }>('view.text', { page: slice.pageIndex, boxes });
                return prefersWarraq(theirs, result.text) ? result.text : theirs;
              }),
            );
            if (pending(task)) task.resolve(read);
          } catch {
            if (pending(task)) task.resolve(texts);
          }
        })();
      },
      (error) => task.fail(error),
    );
    return task;
  };

  return () => {
    engine.searchAllPages = own.searchAllPages;
    engine.getTextSlices = own.getTextSlices;
  };
}

/** A reading that can be let go of: Warraq's core holds the file until it is freed. */
export interface OwnedReading extends TextReading {
  free(): Promise<void>;
}

export interface ViewTextSources {
  /** Warraq's own open document, when it holds the file the view shows. */
  own: () => TextReading | null;
  /** The file exactly as the view holds it (EmbedPDF's export). */
  fromView: () => Promise<ArrayBuffer | null>;
  /** Warraq's core, opening bytes. */
  open: (bytes: ArrayBuffer) => Promise<OwnedReading>;
}

type Hook<T> = (listener: (event: T) => void) => () => void;

/**
 * Warraq's reading of the file as EmbedPDF shows it, and the view's search
 * and copy answered from it. Returns the undo.
 *
 * That is Warraq's own open document: what EmbedPDF changes — comments,
 * form values, drawings — leaves the page's text as it was. A redaction
 * applied in the view does not: its text is gone from the page, and a
 * search must not find it there. After one the file is read again from the
 * view, once, until the next change or the next file.
 */
export function installViewText(registry: PluginRegistry, sources: ViewTextSources): () => void {
  let redacted = false;
  let copy: Promise<OwnedReading | null> | null = null;
  const forget = () => {
    const old = copy;
    copy = null;
    void old?.then((reading) => reading?.free()).catch(() => undefined);
  };
  const reading: Reading = async () => {
    if (!redacted) return sources.own();
    copy ??= sources
      .fromView()
      .then((bytes) => (bytes ? sources.open(bytes) : null))
      .catch(() => null);
    return copy;
  };
  const subscriptions = [
    capability<{ onRedactionEvent?: Hook<{ type: string; success?: boolean }> }>(registry, 'redaction')?.onRedactionEvent?.((event) => {
      if (event.type !== 'commit' || !event.success) return;
      redacted = true;
      forget();
    }),
    // Another file, or new bytes of this one: Warraq's own document is it again.
    capability<{ onActiveDocumentChanged?: Hook<unknown> }>(registry, 'document-manager')?.onActiveDocumentChanged?.(() => {
      redacted = false;
      forget();
    }),
  ];
  const undo = installWarraqText(registry, reading);
  return () => {
    undo();
    subscriptions.forEach((unsubscribe) => unsubscribe?.());
    forget();
  };
}
