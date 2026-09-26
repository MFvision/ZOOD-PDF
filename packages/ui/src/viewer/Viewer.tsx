/**
 * EmbedPDF host. Loads a document from BYTES (never a URL), exposes a small imperative API to our
 * toolbar, and reports page/zoom/edit events. The component is keyed by document revision by its
 * parent, so new bytes always mean a fresh viewer.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PDFViewer, type PluginRegistry, type EmbedPdfContainer } from '@embedpdf/react-pdf-viewer';
import { buildViewerConfig } from './config';
import { embedPdfArabicLocale, setEmbedPdfLocale } from './locale';
import { engineTextProvider, hookEngineText, type HookableEngine } from './arabicText';
import type { Locale } from '../i18n';
import type { EngineClient } from '../services/engine';

export interface ViewerApi {
  goToPage(page: number): void;
  nextPage(): void;
  prevPage(): void;
  zoomIn(): void;
  zoomOut(): void;
  exec(commandId: string): void;
  isCommandActive(commandId: string): boolean;
  /** PDFium's full-document save (EmbedPDF saveAsCopy). */
  exportBytes(): Promise<Uint8Array>;
  /** PNG of a page, `width` CSS pixels wide. */
  renderPage(pageIndex: number, width: number): Promise<Blob>;
  pageCount(): number;
  /** Adds redaction marks (EmbedPDF REDACT annotations) — rects in viewer page space (top-left, points). */
  addRedactionMarks(items: { page: number; rects: [number, number, number, number][] }[]): number;
  /** Number of redaction marks currently in the viewer; `cb` fires on every change. */
  onRedactionMarks(cb: (count: number) => void): () => void;
  /** Page sizes in PDF points (unrotated). */
  pageSizes(): { width: number; height: number }[];
  /** Opens other PDF bytes in the same PDFium engine (not shown), e.g. the second file of Compare. */
  openOther(bytes: Uint8Array): Promise<OtherDocument>;
  // ---- Read aloud ----
  /** Highlights the paragraph being read (rects in viewer page space: top-left, points); null clears. */
  setReadingHighlight(h: ReadingHighlight | null): void;
  /** Scrolls the rect of a page into view (no-op when it is already visible). */
  revealRect(page: number, rect: [number, number, number, number]): void;
  /** Top-left of the current text selection (0-based page, page points), if any. */
  selectionAnchor(): { page: number; x: number; y: number } | null;
}

/** Read aloud: what to highlight. */
export interface ReadingHighlight {
  page: number;
  rects: [number, number, number, number][];
}

/** A PDF opened in the viewer's PDFium engine without being displayed. */
export interface OtherDocument {
  pageCount: number;
  pageSizes: { width: number; height: number }[];
  /** PNG of a page, `width` CSS pixels wide. */
  renderPage(pageIndex: number, width: number): Promise<Blob>;
  close(): void;
}

export interface ViewerEvents {
  onReady(api: ViewerApi, info: { pageCount: number }): void;
  onPageChange(page: number, total: number): void;
  onZoomChange(percent: number): void;
  onEdited(): void;
  /** Redaction applied or protection changed: previews of the old content must be forgotten. */
  onSensitiveChange(): void;
  onError(message: string): void;
  /** A link (URI action) was clicked in the page: confirm before opening (Edit tool, LinkSheets). */
  onLinkNavigate?(uri: string): void;
}

interface Props extends ViewerEvents {
  bytes: Uint8Array;
  name: string;
  documentId: string;
  locale: Locale;
  scheme: 'light' | 'dark';
  password?: string;
  /** The engine answers EmbedPDF's search and copy (Arabic-aware, logical order; `arabicText.ts`). */
  textEngine?: EngineClient;
}

type Cap = Record<string, (...args: never[]) => unknown> & Record<string, unknown>;
function cap<T = Cap>(registry: PluginRegistry, id: string): T | null {
  const plugin = registry.getPlugin(id) as { provides?: () => T } | null;
  return plugin?.provides?.() ?? null;
}

type Hook<E> = (cb: (e: E) => void) => () => void;
type TaskLike<R> = { toPromise(): Promise<R> };

let markSeq = 0;

const SENSITIVE_COMMANDS = new Set([
  'redaction:apply-all',
  'redaction:commit-selected',
  'annotation:apply-redaction',
]);

/** RTL for EmbedPDF's toolbars, menus and panels (not its page canvas), inside its shadow root. */
const RTL_CSS = `
  [data-epdf-i$="-toolbar"], [role="menu"], [data-sidebar-id], [role="dialog"] { direction: rtl; }
`;
function mirrorToolbars(container: EmbedPdfContainer, locale: Locale) {
  const root = container.shadowRoot;
  if (!root) return;
  let style = root.querySelector<HTMLStyleElement>('style[data-zood-dir]');
  if (!style) {
    style = document.createElement('style');
    style.dataset.zoodDir = '';
    root.append(style);
  }
  style.textContent = locale === 'ar' ? RTL_CSS : '';
}

export function Viewer(props: Props) {
  const { bytes, name, documentId, locale, scheme, password } = props;
  const events = useRef<ViewerEvents>(props);
  useLayoutEffect(() => {
    events.current = props;
  });
  const registryRef = useRef<PluginRegistry | null>(null);
  const containerRef = useRef<EmbedPdfContainer | null>(null);
  // Read aloud: highlight boxes drawn over EmbedPDF's scroll viewport (screen-space, recomputed on scroll/zoom).
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [reading, setReading] = useState<ReadingLayer | null>(null);

  // Built once per mount: the parent remounts us (key = revision) for new bytes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => buildViewerConfig({ bytes, name, documentId, locale, scheme, password }), []);
  setEmbedPdfLocale(locale);

  useEffect(() => {
    const registry = registryRef.current;
    if (!registry) return;
    const i18n = cap<{ setLocale(l: string): void; hasLocale(l: string): boolean }>(registry, 'i18n');
    setEmbedPdfLocale(locale);
    if (i18n?.hasLocale(locale)) i18n.setLocale(locale);
  }, [locale]);

  useEffect(() => {
    containerRef.current?.setTheme(scheme);
  }, [scheme]);

  useEffect(() => {
    if (containerRef.current) mirrorToolbars(containerRef.current, locale);
  }, [locale]);

  const onReady = (registry: PluginRegistry) => {
    registryRef.current = registry;
    const unsubs: (() => void)[] = [];
    const i18n = cap<{ registerLocale(l: unknown): void; setLocale(l: string): void; hasLocale(l: string): boolean }>(
      registry,
      'i18n',
    );
    if (i18n && !i18n.hasLocale('ar')) i18n.registerLocale(embedPdfArabicLocale);
    i18n?.setLocale(locale);

    const docs = cap<{
      onDocumentOpened: Hook<{ id: string; document?: { pageCount: number } | null }>;
      onDocumentError: Hook<{ documentId: string; message?: string; reason?: { message?: string } }>;
      getDocument(id: string): { pageCount: number; pages: unknown[] } | null;
    }>(registry, 'document-manager');
    const scroll = cap<{
      onPageChange: Hook<{ documentId: string; pageNumber: number; totalPages: number }>;
      forDocument(id: string): { scrollToPage(o: { pageNumber: number }): void; scrollToNextPage(): void; scrollToPreviousPage(): void };
    }>(registry, 'scroll');
    const zoom = cap<{
      onZoomChange: Hook<{ documentId: string; newZoom: number }>;
      forDocument(id: string): { zoomIn(): void; zoomOut(): void };
    }>(registry, 'zoom');
    const commands = cap<{
      execute(id: string, documentId?: string, source?: string): void;
      resolve(id: string, documentId?: string): { active: boolean };
      onCommandExecuted: Hook<{ commandId: string; documentId: string }>;
    }>(registry, 'commands');
    const history = cap<{ onHistoryChange: Hook<unknown> }>(registry, 'history');
    const annotation = cap<{
      onAnnotationEvent: Hook<{ type: string; committed?: boolean }>;
      onNavigate?: Hook<{ documentId?: string; result?: { outcome?: string; uri?: string } }>;
    }>(registry, 'annotation');
    type RedactionItem = { id: string; kind: 'area'; page: number; rect: { origin: { x: number; y: number }; size: { width: number; height: number } } };
    const redaction = cap<{
      onRedactionEvent: Hook<{ type: string; documentId: string; success?: boolean }>;
      forDocument(id: string): {
        addPending(items: RedactionItem[]): void;
        getState(): { pendingCount?: number; pending?: Record<string, unknown[]> };
        onPendingChange(cb: (pending: Record<string, unknown[]>) => void): () => void;
        onStateChange?(cb: (state: { pendingCount?: number; pending?: Record<string, unknown[]> }) => void): () => void;
        onRedactionEvent?(cb: (event: unknown) => void): () => void;
      };
    }>(registry, 'redaction');
    const exporter = cap<{ forDocument(id: string): { saveAsCopy(): TaskLike<ArrayBuffer> } }>(registry, 'export');
    const ui = cap<{ forDocument(id: string): { closeToolbarSlot(p: string, s: string): void } }>(registry, 'ui');
    const engine = registry.getEngine();
    if (props.textEngine) {
      const provider = engineTextProvider(props.textEngine, bytes, password);
      const restore = hookEngineText(engine as unknown as HookableEngine, documentId, provider);
      unsubs.push(() => {
        restore();
        provider.close();
      });
    }
    // ---- Read aloud: highlight layer ----
    const scrollAt = cap<{
      forDocument(id: string): {
        getRectPositionForPage(page: number, rect: { origin: { x: number; y: number }; size: { width: number; height: number } }): {
          origin: { x: number; y: number };
          size: { width: number; height: number };
        } | null;
      };
      onLayoutChange?: Hook<unknown>;
    }>(registry, 'scroll');
    const selection = cap<{
      forDocument(id: string): { getFormattedSelection(): { pageIndex: number; rect: { origin: { x: number; y: number } } }[] };
    }>(registry, 'selection');
    let highlight: ReadingHighlight | null = null;
    let viewportEl: HTMLElement | null = null;
    const findViewport = (): HTMLElement | null => {
      if (viewportEl?.isConnected) return viewportEl;
      const root = containerRef.current?.shadowRoot;
      if (!root) return null;
      // EmbedPDF's viewport: the scrolling div with `overflow: auto` and the viewport gap as padding.
      let best: HTMLElement | null = null;
      for (const el of root.querySelectorAll<HTMLElement>('div')) {
        if (el.style.overflow !== 'auto' || !el.style.padding) continue;
        if (!best || el.clientWidth * el.clientHeight > best.clientWidth * best.clientHeight) best = el;
      }
      viewportEl = best;
      return best;
    };
    /** Top-left of EmbedPDF's page layout (its first child, centred with a margin) in the viewport's client box. */
    const contentOrigin = (vp: HTMLElement) => {
      const content = vp.firstElementChild as HTMLElement | null;
      const vr = vp.getBoundingClientRect();
      const cr = content?.getBoundingClientRect() ?? vr;
      return { x: cr.left - vr.left - vp.clientLeft, y: cr.top - vr.top - vp.clientTop };
    };
    const toPos = (page: number, r: [number, number, number, number]) => {
      try {
        return scrollAt?.forDocument(documentId).getRectPositionForPage(page, { origin: { x: r[0], y: r[1] }, size: { width: r[2] - r[0], height: r[3] - r[1] } }) ?? null;
      } catch {
        return null;
      }
    };
    const relayout = () => {
      const vp = findViewport();
      const host = hostRef.current;
      if (!highlight || !vp || !host) {
        setReading(null);
        return;
      }
      const origin = contentOrigin(vp);
      const hr = host.getBoundingClientRect();
      const vr = vp.getBoundingClientRect();
      const boxes = highlight.rects
        .map((r) => toPos(highlight!.page, r))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => ({
          x: origin.x + p.origin.x - 2,
          y: origin.y + p.origin.y - 1,
          w: p.size.width + 4,
          h: p.size.height + 2,
        }));
      setReading({
        page: highlight.page,
        frame: { x: vr.left - hr.left + vp.clientLeft, y: vr.top - hr.top + vp.clientTop, w: vp.clientWidth, h: vp.clientHeight },
        boxes,
      });
    };
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        relayout();
      });
    };
    let scrollBound: HTMLElement | null = null;
    const bindScroll = () => {
      const vp = findViewport();
      if (vp === scrollBound) return;
      scrollBound?.removeEventListener('scroll', schedule);
      vp?.addEventListener('scroll', schedule, { passive: true });
      scrollBound = vp;
    };
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (hostRef.current) resize?.observe(hostRef.current);
    unsubs.push(() => {
      resize?.disconnect();
      scrollBound?.removeEventListener('scroll', schedule);
      if (raf) cancelAnimationFrame(raf);
    });
    if (scrollAt?.onLayoutChange) unsubs.push(scrollAt.onLayoutChange(schedule));

    const api: ViewerApi = {
      goToPage: (page) => scroll?.forDocument(documentId).scrollToPage({ pageNumber: page }),
      nextPage: () => scroll?.forDocument(documentId).scrollToNextPage(),
      prevPage: () => scroll?.forDocument(documentId).scrollToPreviousPage(),
      zoomIn: () => zoom?.forDocument(documentId).zoomIn(),
      zoomOut: () => zoom?.forDocument(documentId).zoomOut(),
      exec: (id) => commands?.execute(id, documentId, 'api'),
      isCommandActive: (id) => {
        try {
          return !!commands?.resolve(id, documentId).active;
        } catch {
          return false;
        }
      },
      async exportBytes() {
        if (!exporter) throw new Error('export plugin unavailable');
        const buf = await exporter.forDocument(documentId).saveAsCopy().toPromise();
        return new Uint8Array(buf.slice(0));
      },
      async renderPage(pageIndex, width) {
        const doc = docs?.getDocument(documentId) as unknown as { pages: { size: { width: number } }[] } | null;
        const page = doc?.pages[pageIndex];
        if (!doc || !page) throw new Error('page not available');
        const scaleFactor = Math.max(0.05, width / page.size.width);
        return (engine as unknown as {
          renderThumbnail(d: unknown, p: unknown, o: unknown): TaskLike<Blob>;
        })
          .renderThumbnail(doc, page, { scaleFactor, imageType: 'image/png', withAnnotations: true, dpr: 1 })
          .toPromise();
      },
      pageCount: () => docs?.getDocument(documentId)?.pageCount ?? 0,
      addRedactionMarks(items) {
        const scope = redaction?.forDocument(documentId);
        if (!scope) throw new Error('redaction plugin unavailable');
        const list: RedactionItem[] = [];
        for (const it of items)
          for (const [x0, y0, x1, y1] of it.rects)
            list.push({
              id: `zood-${Date.now().toString(36)}-${(markSeq += 1)}`,
              kind: 'area',
              page: it.page,
              rect: { origin: { x: x0, y: y0 }, size: { width: x1 - x0, height: y1 - y0 } },
            });
        if (list.length) scope.addPending(list);
        return list.length;
      },
      onRedactionMarks(cb) {
        const scope = redaction?.forDocument(documentId);
        if (!scope) return () => {};
        const count = (p: Record<string, unknown[]> | undefined) => Object.values(p ?? {}).reduce((n, l) => n + (l?.length ?? 0), 0);
        try {
          const st = scope.getState();
          cb(st.pendingCount ?? count(st.pending));
        } catch {
          cb(0);
        }
        // In annotation mode marks are REDACT annotations synced into the state without always
        // emitting a pending event: follow the whole state, and pending events as a fallback.
        let last = -1;
        const emit = (n: number) => {
          if (n !== last) cb((last = n));
        };
        // Re-read the state on any redaction signal (events can arrive before the state is updated).
        const reread = () => {
          try {
            const st = scope.getState();
            emit(st.pendingCount ?? count(st.pending));
          } catch {
            /* document closing */
          }
        };
        const later = () => {
          reread();
          queueMicrotask(reread);
          setTimeout(reread, 0);
        };
        const offs = [scope.onStateChange?.(later), scope.onPendingChange(later), scope.onRedactionEvent?.(later)];
        return () => {
          for (const off of offs) off?.();
        };
      },
      pageSizes() {
        const doc = docs?.getDocument(documentId) as unknown as { pages: { size: { width: number; height: number } }[] } | null;
        return (doc?.pages ?? []).map((p) => ({ width: p.size.width, height: p.size.height }));
      },
      async openOther(bytes) {
        type PdfDoc = { pageCount: number; pages: { size: { width: number; height: number } }[] };
        const pdfium = engine as unknown as {
          openDocumentBuffer(f: { id: string; content: ArrayBuffer }): TaskLike<PdfDoc>;
          renderThumbnail(d: unknown, p: unknown, o: unknown): TaskLike<Blob>;
          closeDocument(d: unknown): TaskLike<boolean>;
        };
        const id = `zood-other-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        // PDFium may take ownership of the buffer: hand it a private copy.
        const doc = await pdfium.openDocumentBuffer({ id, content: bytes.slice().buffer as ArrayBuffer }).toPromise();
        let open = true;
        return {
          pageCount: doc.pageCount,
          pageSizes: doc.pages.map((p) => ({ width: p.size.width, height: p.size.height })),
          renderPage(pageIndex, width) {
            const page = doc.pages[pageIndex];
            if (!open || !page) return Promise.reject(new Error('page not available'));
            const scaleFactor = Math.max(0.05, width / page.size.width);
            return pdfium.renderThumbnail(doc, page, { scaleFactor, imageType: 'image/png', withAnnotations: true, dpr: 1 }).toPromise();
          },
          close() {
            if (!open) return;
            open = false;
            void pdfium.closeDocument(doc).toPromise().catch(() => {});
          },
        };
      },
      // ---- Read aloud ----
      setReadingHighlight(h) {
        highlight = h && h.rects.length ? h : null;
        bindScroll();
        relayout();
      },
      revealRect(page, rect) {
        const vp = findViewport();
        const pos = toPos(page, rect);
        if (!vp || !pos) return;
        const top = contentOrigin(vp).y + vp.scrollTop + pos.origin.y;
        const bottom = top + pos.size.height;
        if (top >= vp.scrollTop && bottom <= vp.scrollTop + vp.clientHeight) return;
        const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        vp.scrollTo({ top: Math.max(0, top - vp.clientHeight * 0.25), behavior: smooth ? 'smooth' : 'auto' });
      },
      selectionAnchor() {
        try {
          const sel = selection?.forDocument(documentId).getFormattedSelection() ?? [];
          const first = sel[0];
          return first ? { page: first.pageIndex, x: first.rect.origin.x, y: first.rect.origin.y } : null;
        } catch {
          return null;
        }
      },
    };

    let opened = false;
    const announceOpen = (pageCount: number) => {
      if (opened) return;
      opened = true;
      // Our toolbar replaces EmbedPDF's main toolbar; its per-tool (secondary) toolbars stay.
      ui?.forDocument(documentId).closeToolbarSlot('top', 'main');
      events.current.onReady(api, { pageCount });
    };
    if (docs) {
      unsubs.push(
        docs.onDocumentOpened((d) => {
          if (d.id === documentId) announceOpen(d.document?.pageCount ?? docs.getDocument(documentId)?.pageCount ?? 0);
        }),
        docs.onDocumentError((e) => {
          if (e.documentId === documentId) events.current.onError(e.reason?.message ?? e.message ?? 'error');
        }),
      );
      const already = docs.getDocument(documentId);
      if (already) announceOpen(already.pageCount);
    }
    if (scroll)
      unsubs.push(
        scroll.onPageChange((e) => {
          if (e.documentId === documentId) events.current.onPageChange(e.pageNumber, e.totalPages);
        }),
      );
    if (zoom)
      unsubs.push(
        zoom.onZoomChange((e) => {
          if (e.documentId === documentId) {
            events.current.onZoomChange(Math.round(e.newZoom * 100));
            schedule();
          }
        }),
      );
    if (history) unsubs.push(history.onHistoryChange(() => events.current.onEdited()));
    if (annotation)
      unsubs.push(
        annotation.onAnnotationEvent((e) => {
          if (e.type === 'create' || e.type === 'update' || e.type === 'delete') events.current.onEdited();
        }),
      );
    if (annotation?.onNavigate)
      unsubs.push(
        annotation.onNavigate((e) => {
          if (e.result?.outcome === 'uri' && e.result.uri && (!e.documentId || e.documentId === documentId)) events.current.onLinkNavigate?.(e.result.uri);
        }),
      );
    if (redaction)
      unsubs.push(
        redaction.onRedactionEvent((e) => {
          if (e.type === 'commit' && e.success !== false && e.documentId === documentId) events.current.onSensitiveChange();
        }),
      );
    if (commands)
      unsubs.push(
        commands.onCommandExecuted((e) => {
          if (SENSITIVE_COMMANDS.has(e.commandId)) events.current.onSensitiveChange();
        }),
      );
    cleanup.current = () => unsubs.forEach((u) => u());
  };

  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);

  // EmbedPDF lays pages out with physical coordinates: its scroll container must stay LTR even in an
  // RTL interface (Arabic text inside pages is unaffected). Its tool strips are mirrored separately.
  return (
    <div className="viewer-host" dir="ltr" ref={hostRef}>
      <PDFViewer
        className="viewer-inner"
        config={config}
        onInit={(c) => {
          containerRef.current = c;
          mirrorToolbars(c, locale);
        }}
        onReady={onReady}
      />
      {reading && (
        <div
          className="reading-layer"
          aria-hidden="true"
          style={{ insetInlineStart: reading.frame.x, insetBlockStart: reading.frame.y, inlineSize: reading.frame.w, blockSize: reading.frame.h }}
        >
          {reading.boxes.map((b, i) => (
            <div
              key={i}
              className="reading-mark"
              data-testid="reading-highlight"
              data-page={reading.page}
              style={{ insetInlineStart: b.x, insetBlockStart: b.y, inlineSize: b.w, blockSize: b.h }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ReadingLayer {
  page: number;
  /** The viewport's client box relative to the host. */
  frame: { x: number; y: number; w: number; h: number };
  /** Highlight boxes relative to the frame. */
  boxes: { x: number; y: number; w: number; h: number }[];
}
