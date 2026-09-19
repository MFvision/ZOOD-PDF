import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';
import { capability } from '../embed/embedControl';

/**
 * Prepare form's reach into the EmbedPDF view (ADR-0007): where each page is
 * on screen, so proposals can be drawn over it, and the form plugin's values,
 * so filling a field can recalculate the others. Typed here by hand, as the
 * rest of `embedControl.ts` is.
 */

type Unsubscribe = () => void;
type Hook<T> = (listener: (value: T) => void) => Unsubscribe;

interface PageLayout {
  pageIndex: number;
  rotatedWidth: number;
  rotatedHeight: number;
}

interface ScrollScope {
  getMetrics(): { renderedPageIndexes: number[] };
  getLayout(): { virtualItems: { pageLayouts: PageLayout[] }[] };
  scrollToPage(options: {
    pageNumber: number;
    pageCoordinates?: { x: number; y: number };
    behavior?: 'instant' | 'smooth' | 'auto';
  }): void;
}

interface DocumentManager {
  getActiveDocumentId(): string | null;
  onActiveDocumentChanged: Hook<unknown>;
}

interface FormScope {
  getFormValues(): Record<string, string>;
  setFormValues(values: Record<string, string>): { toPromise(): Promise<boolean> };
  onFieldValueChange: Hook<{
    annotationId: string;
    widget: { field?: { name?: string; value?: string } };
  }>;
  onStateChange: Hook<{ selectedFieldId: string | null }>;
}

interface FormCapability {
  forDocument(documentId: string): FormScope;
}

function activeDocument(registry: PluginRegistry): string | null {
  try {
    return capability<DocumentManager>(registry, 'document-manager')?.getActiveDocumentId() ?? null;
  } catch {
    return null;
  }
}

/** Calls `onChange` when another document becomes the one on screen. */
export function watchActiveDocument(registry: PluginRegistry, onChange: () => void): Unsubscribe {
  return (
    capability<DocumentManager>(registry, 'document-manager')?.onActiveDocumentChanged(() =>
      onChange(),
    ) ?? (() => {})
  );
}

/** The form plugin of the document on screen, or null without one. */
export function formScope(registry: PluginRegistry): FormScope | null {
  const id = activeDocument(registry);
  if (!id) return null;
  try {
    return capability<FormCapability>(registry, 'form')?.forDocument(id) ?? null;
  } catch {
    return null;
  }
}

/** A page on screen: its box in the window, and its size in points as shown. */
export interface PageOnScreen {
  box: DOMRect;
  width: number;
  height: number;
}

function shadowRoot(): ShadowRoot | null {
  return document.querySelector('embedpdf-container')?.shadowRoot ?? null;
}

/**
 * Where each page EmbedPDF has drawn is on screen. Its scroller lays the
 * pages it renders out in order — rows of `renderedPageIndexes`, pages of each
 * row's `pageLayouts` — as `display:flex; justify-content:center` rows in a
 * column; those rows are found by their styles and matched up in that order.
 * When the two disagree the answer is empty, and nothing is drawn rather than
 * something drawn in the wrong place.
 */
export function pagesOnScreen(registry: PluginRegistry): Map<number, PageOnScreen> {
  const out = new Map<number, PageOnScreen>();
  const root = shadowRoot();
  const id = activeDocument(registry);
  if (!root || !id) return out;
  let layouts: PageLayout[];
  try {
    const scope = capability<{ forDocument(id: string): ScrollScope }>(
      registry,
      'scroll',
    )?.forDocument(id);
    if (!scope) return out;
    const items = scope.getLayout().virtualItems;
    layouts = scope.getMetrics().renderedPageIndexes.flatMap((i) => items[i]?.pageLayouts ?? []);
  } catch {
    return out;
  }
  const rows = [...root.querySelectorAll<HTMLElement>('div')].filter(
    (div) =>
      div.style.display === 'flex' &&
      div.style.justifyContent === 'center' &&
      (div.parentElement as HTMLElement | null)?.style.flexDirection === 'column',
  );
  const pages = rows.flatMap((row) => [...row.children] as HTMLElement[]);
  if (pages.length !== layouts.length) return out;
  pages.forEach((page, k) => {
    const layout = layouts[k];
    if (!layout) return;
    out.set(layout.pageIndex, {
      box: page.getBoundingClientRect(),
      width: layout.rotatedWidth,
      height: layout.rotatedHeight,
    });
  });
  return out;
}

/** The part of the window EmbedPDF scrolls its pages in. */
export function viewportBox(): DOMRect | null {
  const root = shadowRoot();
  if (!root) return null;
  const scroller = [...root.querySelectorAll<HTMLElement>('div')].find(
    (div) => div.style.overflow === 'auto',
  );
  return scroller?.getBoundingClientRect() ?? null;
}

/** Brings a point of a page (in points) into view. */
export function showPagePoint(registry: PluginRegistry, page: number, x: number, y: number): void {
  const id = activeDocument(registry);
  if (!id) return;
  try {
    capability<{ forDocument(id: string): ScrollScope }>(registry, 'scroll')
      ?.forDocument(id)
      .scrollToPage({ pageNumber: page + 1, pageCoordinates: { x, y }, behavior: 'smooth' });
  } catch {
    /* no document on screen */
  }
}

/**
 * Calls `onCommit` with a field's name when a value typed into it is
 * committed: EmbedPDF edits each field in an input named after it, and the
 * value is committed when that input loses the focus — to the next field, or
 * anywhere else. Returns the unsubscribe.
 */
export function watchCommits(onCommit: (name: string) => void): Unsubscribe {
  const root = shadowRoot();
  if (!root) return () => {};
  const left = (event: Event) => {
    const target = event.target;
    if (
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement) &&
      target.name
    ) {
      onCommit(target.name);
    }
  };
  root.addEventListener('focusout', left, true);
  return () => root.removeEventListener('focusout', left, true);
}

/**
 * Calls `onChange` whenever EmbedPDF's view moves: a scroll, a zoom, a
 * resize, a new layout. Returns the unsubscribe.
 */
export function watchView(registry: PluginRegistry, onChange: () => void): Unsubscribe {
  const root = shadowRoot();
  const scroll = () => onChange();
  root?.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', scroll);
  const zoom = capability<{ onZoomChange: Hook<unknown> }>(registry, 'zoom')?.onZoomChange(scroll);
  const layout = capability<{ onLayoutChange: Hook<unknown> }>(registry, 'scroll')?.onLayoutChange(
    scroll,
  );
  // Tiles and toolbars settle a moment after a change; look again then.
  const timer = window.setInterval(scroll, 400);
  return () => {
    root?.removeEventListener('scroll', scroll, true);
    window.removeEventListener('resize', scroll);
    zoom?.();
    layout?.();
    window.clearInterval(timer);
  };
}
