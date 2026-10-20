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
  scrollToPage(options: { pageNumber: number }): void;
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
}

/** Follows the page on screen and what can be undone. Returns the unsubscribe. */
export function watch(registry: PluginRegistry, { onPage, onHistory }: EmbedWatchers): Unsubscribe {
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
    history?.onHistoryChange(readHistory),
    // A newly opened file starts with nothing to undo.
    capability<DocumentManager>(registry, 'document-manager')?.onActiveDocumentChanged(readHistory),
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
