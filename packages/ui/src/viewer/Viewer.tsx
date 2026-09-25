/**
 * EmbedPDF host. Loads a document from BYTES (never a URL), exposes a small imperative API to our
 * toolbar, and reports page/zoom/edit events. The component is keyed by document revision by its
 * parent, so new bytes always mean a fresh viewer.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { PDFViewer, type PluginRegistry, type EmbedPdfContainer } from '@embedpdf/react-pdf-viewer';
import { buildViewerConfig } from './config';
import { embedPdfArabicLocale, setEmbedPdfLocale } from './locale';
import type { Locale } from '../i18n';

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
}

export interface ViewerEvents {
  onReady(api: ViewerApi, info: { pageCount: number }): void;
  onPageChange(page: number, total: number): void;
  onZoomChange(percent: number): void;
  onEdited(): void;
  /** Redaction applied or protection changed: previews of the old content must be forgotten. */
  onSensitiveChange(): void;
  onError(message: string): void;
}

interface Props extends ViewerEvents {
  bytes: Uint8Array;
  name: string;
  documentId: string;
  locale: Locale;
  scheme: 'light' | 'dark';
}

type Cap = Record<string, (...args: never[]) => unknown> & Record<string, unknown>;
function cap<T = Cap>(registry: PluginRegistry, id: string): T | null {
  const plugin = registry.getPlugin(id) as { provides?: () => T } | null;
  return plugin?.provides?.() ?? null;
}

type Hook<E> = (cb: (e: E) => void) => () => void;
type TaskLike<R> = { toPromise(): Promise<R> };

const SENSITIVE_COMMANDS = new Set([
  'redaction:apply-all',
  'redaction:commit-selected',
  'annotation:apply-redaction',
]);

export function Viewer(props: Props) {
  const { bytes, name, documentId, locale, scheme } = props;
  const events = useRef<ViewerEvents>(props);
  useLayoutEffect(() => {
    events.current = props;
  });
  const registryRef = useRef<PluginRegistry | null>(null);
  const containerRef = useRef<EmbedPdfContainer | null>(null);

  // Built once per mount: the parent remounts us (key = revision) for new bytes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => buildViewerConfig({ bytes, name, documentId, locale, scheme }), []);
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
    const annotation = cap<{ onAnnotationEvent: Hook<{ type: string; committed?: boolean }> }>(registry, 'annotation');
    const exporter = cap<{ forDocument(id: string): { saveAsCopy(): TaskLike<ArrayBuffer> } }>(registry, 'export');
    const ui = cap<{ forDocument(id: string): { closeToolbarSlot(p: string, s: string): void } }>(registry, 'ui');
    const engine = registry.getEngine();

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
          if (e.documentId === documentId) events.current.onZoomChange(Math.round(e.newZoom * 100));
        }),
      );
    if (history) unsubs.push(history.onHistoryChange(() => events.current.onEdited()));
    if (annotation)
      unsubs.push(
        annotation.onAnnotationEvent((e) => {
          if (e.type === 'create' || e.type === 'update' || e.type === 'delete') events.current.onEdited();
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

  return (
    <PDFViewer
      className="viewer-host"
      config={config}
      onInit={(c) => (containerRef.current = c)}
      onReady={onReady}
    />
  );
}
