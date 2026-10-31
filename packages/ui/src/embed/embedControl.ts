import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';

/**
 * Warraq's menus, shortcuts and toolbar acting on the EmbedPDF view
 * (ADR-0007). EmbedPDF's plugins are reached by id through its registry; the
 * few calls Warraq makes are typed here by hand.
 */

type Unsubscribe = () => void;
type Hook<T> = (listener: (value: T) => void) => Unsubscribe;

interface Commands {
  execute(id: string, documentId?: string, source?: 'keyboard' | 'ui' | 'api'): void;
  resolve(id: string): { active?: boolean; disabled?: boolean };
  getAllCommands(): { id: string; categories?: string[]; shortcuts?: string[] | null }[];
  setDisabledCategories(categories: string[]): void;
  /** A command's active, disabled or visible state changed, in any document. */
  onCommandStateChanged: Hook<{ commandId: string }>;
}

interface Scroll {
  getCurrentPage(): number;
  getPageChangeState(): { isChanging: boolean; targetPage?: number };
  scrollToPage(options: { pageNumber: number; behavior?: ScrollBehavior }): void;
  onPageChange: Hook<{ pageNumber: number; totalPages: number }>;
}

interface History {
  canUndo(): boolean;
  canRedo(): boolean;
  onHistoryChange: Hook<unknown>;
}

interface DocumentManager {
  onActiveDocumentChanged: Hook<unknown>;
  getActiveDocumentId(): string | null;
}

/** A box on a page in EmbedPDF's terms: points from the top-left of the page as stored. */
interface EmbedRect {
  origin: { x: number; y: number };
  size: { width: number; height: number };
}

/** One redaction mark, as EmbedPDF's redaction plugin takes it (`RedactionItem`). */
interface RedactionItem {
  id: string;
  page: number;
  rect: EmbedRect;
  kind: 'text';
  rects: EmbedRect[];
  text?: string;
  source: 'annotation';
  markColor: string;
  redactionColor: string;
}

interface Redaction {
  forDocument(documentId: string): {
    getState(): { pendingCount?: number };
    addPending(items: RedactionItem[]): void;
  };
  onStateChange: Hook<unknown>;
}

/** One plugin's capability, or undefined when the viewer does not have it. */
export function capability<T>(registry: PluginRegistry, id: string): T | undefined {
  return (registry.getPlugin(id) as { provides?: () => T } | null)?.provides?.();
}

/** What the menus and shortcuts ask of whichever view is on screen. */
export type ViewCommand =
  | 'zoom-in'
  | 'zoom-out'
  | 'fit-page'
  | 'fit-width'
  | 'actual-size'
  | 'find'
  | 'sidebar'
  | 'print'
  | 'undo'
  | 'redo';

/** The EmbedPDF command that does each (ids as `getAllCommands` lists them). */
export const EMBED_COMMANDS: Record<ViewCommand, string> = {
  'zoom-in': 'zoom:in',
  'zoom-out': 'zoom:out',
  'fit-page': 'zoom:fit-page',
  'fit-width': 'zoom:fit-width',
  'actual-size': 'zoom:100',
  find: 'panel:toggle-search',
  sidebar: 'panel:toggle-sidebar',
  print: 'document:print',
  undo: 'history:undo',
  redo: 'history:redo',
};

/**
 * EmbedPDF's own Open, Close and Download. Warraq's File menu does these, and
 * EmbedPDF's versions go around it: a file opened there is one Warraq does not
 * know it has, and a copy downloaded there skips the desktop save panel.
 */
export const WARRAQ_OWNS = ['document-open', 'document-close', 'document-export'];

/**
 * What the desktop webview cannot do for EmbedPDF yet: the browser's print.
 * Hidden there, rather than left as a button that does nothing. (File inputs
 * and download links it also ignores go through the native panels:
 * `core/desktopFiles.ts`.)
 */
export const DESKTOP_CANNOT = ['document-print'];

/** The EmbedPDF command categories switched off in this host. */
export function disabledCategories(desktop: boolean): string[] {
  return desktop ? [...WARRAQ_OWNS, ...DESKTOP_CANNOT] : [...WARRAQ_OWNS];
}

export function runCommand(registry: PluginRegistry, id: string): void {
  capability<Commands>(registry, 'commands')?.execute(id, undefined, 'ui');
}

/** Whether a toggle — fit width, fit page, the sidebar — is on. */
export function commandActive(registry: PluginRegistry, id: string): boolean {
  try {
    return capability<Commands>(registry, 'commands')?.resolve(id).active === true;
  } catch {
    // No document active yet: nothing is on.
    return false;
  }
}

/** The toggles Warraq's toolbar and menus show for EmbedPDF's view. */
export type ViewToggle = 'fit-width' | 'fit-page' | 'sidebar' | 'find';
export type ViewToggles = Record<ViewToggle, boolean>;
export const NO_TOGGLES: ViewToggles = { 'fit-width': false, 'fit-page': false, sidebar: false, find: false };
const TOGGLES = Object.keys(NO_TOGGLES) as ViewToggle[];

/**
 * Follows which of the toggles are on in EmbedPDF — now, whenever one of
 * their commands changes, and when another document becomes active — so the
 * toolbar's pressed buttons and the menus' checks are React state. Read at
 * render time instead, they went stale: a click on the sidebar button, ⌘0 or
 * F4 changed EmbedPDF and nothing in React, and the macOS menu bar, which is
 * sent only when the page renders, kept its old checks. Returns the unsubscribe.
 */
export function watchToggles(registry: PluginRegistry, onToggles: (toggles: ViewToggles) => void): Unsubscribe {
  const watched = new Set(TOGGLES.map((toggle) => EMBED_COMMANDS[toggle]));
  const read = () =>
    onToggles(Object.fromEntries(TOGGLES.map((toggle) => [toggle, commandActive(registry, EMBED_COMMANDS[toggle])])) as ViewToggles);
  const subscriptions = [
    capability<Commands>(registry, 'commands')?.onCommandStateChanged(({ commandId }) => {
      if (watched.has(commandId)) read();
    }),
    capability<DocumentManager>(registry, 'document-manager')?.onActiveDocumentChanged(read),
  ];
  read();
  return () => subscriptions.forEach((unsubscribe) => unsubscribe?.());
}

/** PDF permission bit 3: the file may be printed (`PdfPermissionFlag.Print`). */
const PRINT_PERMISSION = 4;

/**
 * Whether the open file allows printing, as PDFium read its protection: the
 * print permission is set, or the owner's password unlocked it. A file with
 * no protection allows everything.
 */
export function printAllowed(registry: PluginRegistry): boolean {
  const document = capability<{ getActiveDocument(): { permissions?: number; isOwnerUnlocked?: boolean } | null }>(
    registry,
    'document-manager',
  )?.getActiveDocument();
  if (!document || typeof document.permissions !== 'number') return true;
  return document.isOwnerUnlocked === true || (document.permissions & PRINT_PERMISSION) !== 0;
}

export function scrollToPage(registry: PluginRegistry, page: number): void {
  capability<Scroll>(registry, 'scroll')?.scrollToPage({ pageNumber: page });
}

/**
 * A file just opened back to the top of page 1, after its opening zoom moved
 * the view — unless something has already taken it to another page (a
 * search hit, a citation, the page it was left at).
 */
export function scrollToStart(registry: PluginRegistry): void {
  const scroll = capability<Scroll>(registry, 'scroll');
  if (!scroll || scroll.getCurrentPage() > 1) return;
  const change = scroll.getPageChangeState();
  if (change.isChanging && (change.targetPage ?? 1) > 1) return;
  scroll.scrollToPage({ pageNumber: 1, behavior: 'instant' });
}

/**
 * Areas and text marked for redaction but not yet applied. Until they are
 * applied they are only marks: the text under them is still in the file.
 */
function pendingRedactionCount(registry: PluginRegistry): number {
  const id = capability<DocumentManager>(registry, 'document-manager')?.getActiveDocumentId();
  if (!id) return 0;
  try {
    return Number(capability<Redaction>(registry, 'redaction')?.forDocument(id).getState().pendingCount ?? 0);
  } catch {
    // No document loaded in the plugin yet: nothing is marked.
    return 0;
  }
}

/** A box on a page, in points from the top-left corner of the page as stored (before `/Rotate`). */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Something to redact: the boxes its glyphs were drawn in, on one page (zero-based). */
export interface RedactionMark {
  page: number;
  text: string;
  rects: PageBox[];
}

const toRect = (box: PageBox): EmbedRect => ({ origin: { x: box.x, y: box.y }, size: { width: box.width, height: box.height } });

/** The smallest box around `boxes`. */
export function unionBox(boxes: readonly PageBox[]): PageBox {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** How many marks wait in a document's redaction scope; 0 when it cannot say. */
function pendingIn(scope: ReturnType<Redaction['forDocument']>): number {
  try {
    return Number(scope.getState().pendingCount ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Pending redaction marks in the EmbedPDF view, one per match, over exactly
 * the glyph boxes given — what its own "Mark text" makes from a selection, so
 * its Apply removes what is under them. Returns how many were added: EmbedPDF
 * adds none, and says nothing, to a file whose permissions forbid changing
 * its content (opened without its owner password), so what is counted is
 * what it holds afterwards, not what it was given.
 */
export function addRedactionMarks(
  registry: PluginRegistry,
  marks: readonly RedactionMark[],
  newId: () => string,
): number {
  const id = capability<DocumentManager>(registry, 'document-manager')?.getActiveDocumentId();
  const scope = id ? capability<Redaction>(registry, 'redaction')?.forDocument(id) : undefined;
  if (!scope) return 0;
  const items: RedactionItem[] = marks
    .filter((mark) => mark.rects.length > 0)
    .map((mark) => ({
      id: newId(),
      page: mark.page,
      rect: toRect(unionBox(mark.rects)),
      kind: 'text',
      rects: mark.rects.map(toRect),
      text: mark.text,
      source: 'annotation',
      // EmbedPDF's own redaction tool's colours: red while marked, black once applied.
      markColor: '#E44234',
      redactionColor: '#000000',
    }));
  if (items.length === 0) return 0;
  const before = pendingIn(scope);
  scope.addPending(items);
  return Math.max(0, pendingIn(scope) - before);
}

/**
 * Switches EmbedPDF's keyboard shortcuts on or off, keeping `disabled` off
 * either way.
 *
 * While Warraq's editor is up, EmbedPDF stays mounted underneath it and its
 * shortcuts still listen on the whole document: Cmd+Z undid a hidden
 * annotation instead of the edit on screen, and the arrow keys turned hidden
 * pages. So every category with a shortcut is off until the view is back.
 */
export function setKeyboard(registry: PluginRegistry, on: boolean, disabled: readonly string[]): void {
  const commands = capability<Commands>(registry, 'commands');
  if (!commands) return;
  const keyed = on
    ? []
    : commands.getAllCommands().flatMap((command) => ((command.shortcuts?.length ?? 0) > 0 ? (command.categories ?? []) : []));
  commands.setDisabledCategories([...new Set([...disabled, ...keyed])]);
}

export interface EmbedWatchers {
  /** The page at the top of the view, one-based. */
  onPage: (page: number) => void;
  onHistory: (history: { canUndo: boolean; canRedo: boolean }) => void;
  /** Each change to the file: a drawing, a comment, a field filled, an undo or a redo. */
  onChange?: () => void;
  /** Another file became the one on screen, with nothing changed in it yet. */
  onDocument?: () => void;
}

/** Follows the page on screen and what can be undone. Returns the unsubscribe. */
export function watch(registry: PluginRegistry, { onPage, onHistory, onChange, onDocument }: EmbedWatchers): Unsubscribe {
  const history = capability<History>(registry, 'history');
  const readHistory = () => {
    // With no document active — between closing one file and opening the
    // next — EmbedPDF's history throws. Thrown from inside its own event, that
    // stopped the close from ever finishing, and the next file never opened.
    let state = { canUndo: false, canRedo: false };
    try {
      state = { canUndo: history?.canUndo() ?? false, canRedo: history?.canRedo() ?? false };
    } catch {
      /* nothing to undo without a document */
    }
    onHistory(state);
  };
  const subscriptions = [
    capability<Scroll>(registry, 'scroll')?.onPageChange(({ pageNumber }) => onPage(pageNumber)),
    history?.onHistoryChange(() => {
      readHistory();
      onChange?.();
    }),
    // A newly opened file starts with nothing to undo.
    capability<DocumentManager>(registry, 'document-manager')?.onActiveDocumentChanged(() => {
      readHistory();
      onDocument?.();
    }),
  ];
  readHistory();
  return () => subscriptions.forEach((unsubscribe) => unsubscribe?.());
}

interface Zoom {
  requestZoom(level: number | 'fit-page' | 'fit-width' | 'automatic'): void;
  getState(): { zoomLevel?: unknown; currentZoomLevel?: number };
  onZoomChange: Hook<{ newZoom: number; level: unknown }>;
}

/** EmbedPDF's zoom as the toolbar shows it: the scale, and whether it is fitted. */
export interface EmbedZoom {
  scale: number;
  mode: 'custom' | 'fit-page' | 'fit-width';
}

const zoomMode = (level: unknown): EmbedZoom['mode'] =>
  level === 'fit-page' || level === 'fit-width' ? level : 'custom';

/** Follows EmbedPDF's zoom — now, and whenever it changes. Returns the unsubscribe. */
export function watchZoom(registry: PluginRegistry, onZoom: (zoom: EmbedZoom) => void): Unsubscribe {
  const zoom = capability<Zoom>(registry, 'zoom');
  if (!zoom) return () => {};
  const read = () => {
    try {
      const state = zoom.getState();
      if (typeof state.currentZoomLevel === 'number') onZoom({ scale: state.currentZoomLevel, mode: zoomMode(state.zoomLevel) });
    } catch {
      /* no document yet */
    }
  };
  const subscriptions = [
    zoom.onZoomChange(({ newZoom, level }) => onZoom({ scale: newZoom, mode: zoomMode(level) })),
    capability<DocumentManager>(registry, 'document-manager')?.onActiveDocumentChanged(read),
  ];
  read();
  return () => subscriptions.forEach((unsubscribe) => unsubscribe?.());
}

/** Sets EmbedPDF's zoom to a scale (1 is 100 %), or fits the page or its width. */
export function setZoom(registry: PluginRegistry, scale: number | 'fit-page' | 'fit-width'): void {
  capability<Zoom>(registry, 'zoom')?.requestZoom(scale);
}

/** The zoom on screen, 1 = 100 %; null before a document is showing. */
export function zoomNow(registry: PluginRegistry): number | null {
  try {
    const level = capability<Zoom>(registry, 'zoom')?.getState().currentZoomLevel;
    return typeof level === 'number' ? level : null;
  } catch {
    return null;
  }
}

/**
 * Follows `pendingRedactionCount`: now, whenever the marks change, and when
 * another document becomes active. Returns the unsubscribe.
 */
export function watchPendingRedactions(registry: PluginRegistry, onCount: (count: number) => void): Unsubscribe {
  const read = () => onCount(pendingRedactionCount(registry));
  const subscriptions = [
    capability<Redaction>(registry, 'redaction')?.onStateChange(read),
    capability<DocumentManager>(registry, 'document-manager')?.onActiveDocumentChanged(read),
  ];
  read();
  return () => subscriptions.forEach((unsubscribe) => unsubscribe?.());
}

/* ---- The keyboard in the viewer (First Five, 2026-10-31) ------------------ */

/** EmbedPDF's own shadow root, where its search field and page scroller live. */
function embedRoot(): ShadowRoot | null {
  return globalThis.document?.querySelector('.embed-viewer embedpdf-container')?.shadowRoot ?? null;
}

const shown = (element: HTMLElement) => element.offsetParent !== null && !element.hidden;

/** EmbedPDF's search field, when its panel is showing. */
export function embedSearchField(): HTMLInputElement | null {
  const root = embedRoot();
  if (!root) return null;
  return (
    [...root.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="search"]')].find(
      (field) => shown(field) && !field.readOnly && !field.disabled,
    ) ?? null
  );
}

/**
 * The cursor into the search field, its words selected to type over. Ctrl+F
 * used to open the panel and leave the keyboard nowhere: a keyboard-only
 * reader took 28 Tabs to reach the field.
 */
export function focusEmbedSearch(): boolean {
  const field = embedSearchField();
  if (!field) return false;
  field.focus();
  field.select();
  return true;
}

interface Search {
  nextResult?: () => unknown;
  previousResult?: () => unknown;
  getState?: () => { query?: string; total?: number; results?: unknown[] };
}

/** The search's words and how many places they were found, or null before a search. */
export function searchState(registry: PluginRegistry): { query: string; total: number } | null {
  try {
    const state = capability<Search>(registry, 'search')?.getState?.();
    if (!state) return null;
    return { query: state.query ?? '', total: state.total ?? state.results?.length ?? 0 };
  } catch {
    return null;
  }
}

/** To the next (or previous) place the search found: F3, Shift+F3, Enter again. */
export function searchStep(registry: PluginRegistry, forward: boolean): boolean {
  const search = capability<Search>(registry, 'search');
  const state = searchState(registry);
  if (!search || !state || state.total === 0) return false;
  try {
    if (forward) search.nextResult?.();
    else search.previousResult?.();
    return true;
  } catch {
    return false;
  }
}

/** The element that scrolls the pages: the biggest scroller in EmbedPDF's root. */
export function embedScroller(): HTMLElement | null {
  const root = embedRoot();
  if (!root) return null;
  let best: HTMLElement | null = null;
  for (const element of root.querySelectorAll<HTMLElement>('div')) {
    const style = getComputedStyle(element);
    if (!/(auto|scroll)/.test(style.overflowY + style.overflowX)) continue;
    if (!best || element.clientWidth * element.clientHeight > best.clientWidth * best.clientHeight) best = element;
  }
  return best;
}

/**
 * The keyboard on the pages, so Page Down, End and the arrows read on, when
 * nothing else has it: after a file opened, focus was nowhere and those keys
 * did nothing until the reader tabbed into the page.
 */
export function focusPagesIfIdle(): boolean {
  const active = globalThis.document?.activeElement;
  if (active && active !== globalThis.document.body) return false;
  const scroller = embedScroller();
  if (!scroller) return false;
  if (!scroller.hasAttribute('tabindex')) scroller.tabIndex = -1;
  scroller.focus({ preventScroll: true });
  return true;
}

/**
 * In a right-to-left interface the pages keep their right edge, where Arabic
 * lines start. EmbedPDF's scroller is laid out left to right, so when the
 * view narrowed (the search or thumbnails panel opening, a smaller window) it
 * kept its left edge and cut the start of every line: «حكمة» for «المحكمة»
 * (First Five, Abu Fahad, 2026-10-31). `show()` also brings a page that is
 * wider than the view to its right edge when it first comes on screen.
 */
export function holdReadingEdge(rtl: () => boolean): { show: () => void; stop: () => void } {
  let scroller: HTMLElement | null = null;
  let fromRight = 0;
  let width = -1;
  const room = (element: HTMLElement) => Math.max(0, element.scrollWidth - element.clientWidth);
  const onScroll = () => {
    if (scroller) fromRight = Math.max(0, room(scroller) - scroller.scrollLeft);
  };
  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (!scroller || scroller.clientWidth === width) return;
          width = scroller.clientWidth;
          const max = room(scroller);
          if (!rtl() || max <= 1 || getComputedStyle(scroller).direction === 'rtl') return;
          scroller.scrollLeft = Math.min(max, Math.max(0, max - fromRight));
        });
  const bind = () => {
    const found = embedScroller();
    if (found === scroller) return;
    if (scroller) {
      scroller.removeEventListener('scroll', onScroll);
      observer?.unobserve(scroller);
    }
    scroller = found;
    if (!scroller) return;
    width = scroller.clientWidth;
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    observer?.observe(scroller);
  };
  return {
    show: () => {
      bind();
      if (!scroller || !rtl() || getComputedStyle(scroller).direction === 'rtl') return;
      const max = room(scroller);
      if (max > 1 && scroller.scrollLeft < 2) scroller.scrollLeft = max;
    },
    stop: () => {
      scroller?.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      scroller = null;
    },
  };
}
