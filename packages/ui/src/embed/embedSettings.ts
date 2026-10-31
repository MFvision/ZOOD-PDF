import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';
import { readJson, writeJson } from '../state/preferences';
import { SHEET_QUERY } from '../shell/sheetDrag';
import { getSettings } from '../state/settings';
import type { OpenZoom, PageLayout } from '../state/settings';
import { commandActive, runCommand, setZoom } from './embedControl';
import type { EmbedZoom } from './embedControl';

/**
 * Settings › Viewing, in EmbedPDF's view: how the pages are laid out and how
 * large they are when a document opens, and night reading. Its commands
 * (`spread:*`, `scroll:*`, `zoom:*`, as `getAllCommands` lists them in 2.15.1)
 * do the layout; night reading is a stylesheet in its shadow root, so the
 * file itself is never touched.
 */

/** The EmbedPDF commands that lay pages out each way. */
export const LAYOUT_COMMANDS: Record<PageLayout, readonly string[]> = {
  continuous: ['scroll:vertical', 'spread:none'],
  // One page at a time: side by side, each fitted to the window, so a scroll
  // or an arrow key goes to the next page whole.
  single: ['scroll:horizontal', 'spread:none'],
  two: ['scroll:vertical', 'spread:odd'],
  // The cover on its own, then 2–3, 4–5…: how a printed book opens.
  book: ['scroll:vertical', 'spread:even'],
};

// Asked of the zoom plugin itself: its fit commands are toggles, and a
// second "fit width" on a view already fitted would undo it.
const ZOOMS: Record<Exclude<OpenZoom, 'remember'>, number | 'fit-page' | 'fit-width'> = {
  'fit-width': 'fit-width',
  'fit-page': 'fit-page',
  actual: 1,
};

export function applyPageLayout(registry: PluginRegistry, layout: PageLayout): void {
  for (const command of LAYOUT_COMMANDS[layout]) runCommand(registry, command);
  if (layout === 'single') setZoom(registry, 'fit-page');
}

/* ---- The zoom each file was last read at ("As last time for that file") ---- */

const ZOOMS_KEY = 'zood.zooms';
const ZOOMS_KEPT = 200;

type KeptZoom = number | 'fit-page' | 'fit-width';

function keptZooms(): Record<string, KeptZoom> {
  const value = readJson<unknown>(ZOOMS_KEY, null);
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, KeptZoom>) : {};
}

export function rememberZoom(file: string, zoom: EmbedZoom): void {
  const kept = keptZooms();
  delete kept[file];
  kept[file] = zoom.mode === 'custom' ? Math.round(zoom.scale * 100) / 100 : zoom.mode;
  const names = Object.keys(kept);
  for (const old of names.slice(0, Math.max(0, names.length - ZOOMS_KEPT))) delete kept[old];
  writeJson(ZOOMS_KEY, kept);
}

export function rememberedZoom(file: string): KeptZoom | null {
  const zoom = keptZooms()[file];
  if (zoom === 'fit-page' || zoom === 'fit-width') return zoom;
  return typeof zoom === 'number' && zoom >= 0.1 && zoom <= 10 ? zoom : null;
}

export function applyOpenZoom(registry: PluginRegistry, zoom: OpenZoom, file: string): void {
  if (zoom !== 'remember') return setZoom(registry, ZOOMS[zoom]);
  setZoom(registry, rememberedZoom(file) ?? 'fit-width');
}

/** Everything Settings › Viewing says about a document that has just opened. */
export function applyOpenSettings(registry: PluginRegistry, file: string): void {
  const settings = getSettings();
  // The page thumbnails first (EmbedPDF's own sidebar in this view), so the
  // zoom fits the room they leave. At phone width they would cover the
  // page, so they open only when asked for there.
  setPagePanel(registry, settings.pagePanel && !sheetWidth());
  applyPageLayout(registry, settings.pageLayout);
  // One page at a time fits each page already.
  if (settings.pageLayout !== 'single') applyOpenZoom(registry, settings.openZoom, file);
}

const SIDEBAR = 'panel:toggle-sidebar';

/**
 * EmbedPDF shows its sidebar as a bottom sheet over half the page whenever
 * the viewer itself is under 768 px wide, not only on a phone: a 1280×720
 * laptop at 125% with the tools pane open is that narrow (First Five,
 * 2026-10-31: the sheet covered the page and never followed it).
 */
const EMBED_SHEET_WIDTH = 768;

function sheetWidth(): boolean {
  if (globalThis.matchMedia?.(SHEET_QUERY).matches) return true;
  const viewer = globalThis.document?.querySelector<HTMLElement>('.embed-viewer');
  return !!viewer && viewer.clientWidth > 0 && viewer.clientWidth < EMBED_SHEET_WIDTH;
}

/** Whether the page thumbnails are showing. */
export function pagePanelOpen(registry: PluginRegistry): boolean {
  return commandActive(registry, SIDEBAR);
}

export function setPagePanel(registry: PluginRegistry, open: boolean): void {
  if (commandActive(registry, SIDEBAR) !== open) runCommand(registry, SIDEBAR);
}

/* ---- Night reading and page order --------------------------------------- */

/** Pages light on dark: the page pictures inverted, their colours turned back. */
export const NIGHT_CSS = '.bg-bg-app img { filter: invert(0.92) hue-rotate(180deg); }';

/**
 * Two pages side by side, page 1 on the right: the spread's row reversed.
 * (EmbedPDF lays a spread out as a flex row inside the page scroller.)
 */
export const RTL_SPREAD_CSS = '.bg-bg-app [data-spread], .bg-bg-app .flex-row:has(> [data-page-index]) { flex-direction: row-reverse; }';

function styleIn(root: ShadowRoot, name: string): HTMLStyleElement {
  let style = root.querySelector<HTMLStyleElement>(`style[data-zood="${name}"]`);
  if (!style) {
    style = document.createElement('style');
    style.dataset.zood = name;
    root.append(style);
  }
  return style;
}

export function setNightReading(root: ShadowRoot | null | undefined, on: boolean): void {
  if (root) styleIn(root, 'night').textContent = on ? NIGHT_CSS : '';
}

export function setSpreadDirection(root: ShadowRoot | null | undefined, rtl: boolean): void {
  if (root) styleIn(root, 'spread-direction').textContent = rtl ? RTL_SPREAD_CSS : '';
}

/**
 * Whether the file asks to be read right to left (`/ViewerPreferences
 * /Direction /R2L`, as Arabic books made for print often do). Read straight
 * from the bytes: a catalog kept in a compressed object stream is not seen,
 * and that file then reads left to right, as before.
 */
export function declaresRightToLeft(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength > 64 * 1024 * 1024) return false;
  const text = new TextDecoder('latin1').decode(bytes);
  return /\/Direction\s*\/R2L/.test(text);
}

/** Whether two-page spreads put page 1 on the right, for this file and these settings. */
export function spreadsRightToLeft(bytes: ArrayBuffer): boolean {
  const direction = getSettings().readingDirection;
  if (direction === 'document') return declaresRightToLeft(bytes);
  return direction === 'rtl';
}
