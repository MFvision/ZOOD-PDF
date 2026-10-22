import { useCloud } from '../cloud/CloudContext';
import { isTauriHost } from '../core/host-tauri';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { LOOK_IDS } from '../state/preferences';
import type { ThemeMode, UiLook } from '../state/preferences';
import { updateSettings, useSettings } from '../state/settings';
import type { PageLayout } from '../state/settings';
import { closeBar, openBar, readAloudState, useReadAloud } from '../speech/readAloud';
import { useT } from '../i18n/useT';
import { TOOLS } from '../tools/tools';
import { askAvailable } from '../ask/settings';
import { remoteAvailable } from '../remote/host';
import { openTourAt } from '../tour/openAt';
import { openRemoteSheet } from '../remote/store';
import { openSupportAt } from '../support/open';
import { startPresenting } from '../remote/useRemoteController';
import { useMarkupBar } from './markupBar';
import { SHEET_QUERY } from './sheetDrag';
import { undoTyping, useTyping } from './typing';
import { useMediaQuery } from './useMediaQuery';

export interface MenuItemModel {
  id: string;
  label: string;
  /**
   * The key combination, written once for every host: `Mod` is ⌘ on Apple
   * platforms and Ctrl elsewhere ("Mod+Shift+Z", "F4"). The web menu shows it
   * as the platform writes it; the macOS menu bar turns it into an accelerator.
   */
  keys?: string;
  /** The keys before the person changed them in Settings, when they did. */
  defaultKeys?: string;
  /** `keys` as this platform writes it: "⇧⌘Z", "Ctrl+Shift+Z". */
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  role?: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
  separatorBefore?: boolean;
  onSelect?: () => void;
}

export interface MenuModel {
  id: string;
  label: string;
  items: MenuItemModel[];
}

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '');
}

/**
 * The macOS app, where the system's own menu bar is used instead of the one
 * drawn in the page (`apps/desktop/src-tauri/src/menu.rs`).
 */
export function hasNativeMenuBar(): boolean {
  return isTauriHost() && isApplePlatform();
}

/**
 * The inspector has nothing to show: in a narrow window it is a sheet, and
 * only a chosen tool raises it — the toolbar's tool picker is the list there.
 */
export function useInspectorHidden(): boolean {
  const narrow = useMediaQuery(SHEET_QUERY);
  const { rightPane } = useAppState();
  return narrow && rightPane.activeTool === null;
}

/** Human-readable modifier for shortcut hints. */
export function modKeyLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl';
}

const APPLE_GLYPHS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const APPLE_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod'];

/**
 * `keys` as the platform writes it. Apple platforms put the modifier glyphs
 * first, in the system's fixed order (⌃⌥⇧⌘), with no separators: "⇧⌘Z".
 * Everyone else spells them out: "Ctrl+Shift+Z".
 */
export function formatShortcut(keys: string, apple = isApplePlatform()): string {
  const parts = keys.split('+').filter(Boolean);
  // "Mod+=" splits into ["Mod", "="]; "Mod+Shift++" would not occur.
  const key = parts.pop() ?? '';
  if (!apple) return [...parts.map((part) => (part === 'Mod' ? 'Ctrl' : part)), key].join('+');
  const modifiers = APPLE_ORDER.filter((name) => parts.includes(name)).map((name) => APPLE_GLYPHS[name]);
  return `${modifiers.join('')}${key.length === 1 ? key.toUpperCase() : key}`;
}

/** `keys` as a Tauri accelerator: "Mod+Shift+Z" → "CmdOrCtrl+Shift+Z". */
export function toAccelerator(keys: string): string {
  return keys
    .split('+')
    .filter(Boolean)
    .map((part) => (part === 'Mod' ? 'CmdOrCtrl' : part))
    .join('+');
}

/**
 * Undo and Redo from a menu: the typing in the field that has the focus —
 * EmbedPDF's own fields too, inside its shadow root — as the system's own
 * Undo would, or else the document's history. (From the page's menu bar the
 * focus is on the menu, so this is always the document; from the macOS menu
 * bar the focus stays where the person was typing.)
 */
function undoOrRedo(which: 'undo' | 'redo', document: () => void): void {
  if (!undoTyping(which)) document();
}

const PAGE_LAYOUTS: readonly PageLayout[] = ['continuous', 'single', 'two', 'book'];

const withShortcut = (item: MenuItemModel): MenuItemModel =>
  item.keys ? { ...item, shortcut: formatShortcut(item.keys) } : item;

/**
 * Built on every render, not memoized: the checks on Fit width, Fit page and
 * the navigation pane read EmbedPDF's own state, which React does not see
 * change, and a menu re-renders the moment it opens.
 *
 * The same model draws the menu bar in the page (browser, extension, Windows)
 * and the macOS menu bar, so an item enables, checks and runs the same way in
 * both.
 */
export function useMenuModel(): MenuModel[] {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const cloud = useCloud();
  const t = useT();
  const hasDocument = state.view === 'viewer' && state.document !== null;
  // The page grid has no zoom, find or thumbnails: those would do nothing there.
  const organizing = hasDocument && state.rightPane.activeTool === 'organize';
  const edit = state.edit;
  // While a text field has the focus, Undo and Redo are its typing's (typing.ts).
  const typing = useTyping();
  // EmbedPDF's own bar, shown from here too: on a phone the toolbar has no room for its button.
  const markup = useMarkupBar();
  // Subscribed so the View menu's Read aloud check follows the bar.
  useReadAloud();
  // A narrow window shows the inspector as a sheet only for a chosen tool
  // (panes.css): with none, "Tools pane" would change a check and show nothing.
  const noSheet = useInspectorHidden();
  const settings = useSettings();

  const themeItem = (theme: ThemeMode, label: string): MenuItemModel => ({
    id: `theme-${theme}`,
    label,
    role: 'menuitemradio',
    checked: state.theme === theme,
    onSelect: () => dispatch({ type: 'SET_THEME', theme }),
  });
  const lookItem = (look: UiLook): MenuItemModel => ({
    id: `look-${look}`,
    label: `${t('look.label')}: ${t(`look.${look}`)}`,
    role: 'menuitemradio',
    checked: state.look === look,
    onSelect: () => dispatch({ type: 'SET_LOOK', look }),
  });
  const menus: MenuModel[] = [
    {
      // The application menu: the app's name, bold, first in the bar.
      id: 'app',
      label: t('app.name'),
      items: [
        { id: 'about', label: t('help.about'), onSelect: () => dispatch({ type: 'DIALOG', dialog: 'about' }) },
        {
          id: 'settings',
          label: t('settings.open'),
          keys: 'Mod+,',
          separatorBefore: true,
          onSelect: () => dispatch({ type: 'DIALOG', dialog: 'settings' }),
        },
      ],
    },
    {
      id: 'file',
      label: t('menu.file'),
      items: [
        { id: 'open', label: t('file.open'), keys: 'Mod+O', onSelect: services.requestOpenFile },
        // The cloud drives this build offers (none: no item at all).
        ...cloud.providers.map((provider) => ({
          id: `cloud-open-${provider}`,
          label: t(provider === 'onedrive' ? 'cloud.menu.open.onedrive' : 'cloud.menu.open.gdrive'),
          onSelect: () => cloud.startOpen(provider),
        })),
        {
          id: 'save',
          label: t('file.save'),
          keys: 'Mod+S',
          disabled: !hasDocument,
          ...(cloud.providers.length > 0 ? { separatorBefore: true } : {}),
          onSelect: () => void services.saveDocument(),
        },
        {
          id: 'versions',
          label: t('versions.menu'),
          // Open even with versions off: the dialog says so and offers to turn them on.
          disabled: !hasDocument,
          onSelect: () => dispatch({ type: 'DIALOG', dialog: 'versions' }),
        },
        ...cloud.providers.map((provider) => ({
          id: `cloud-save-${provider}`,
          label: t(provider === 'onedrive' ? 'cloud.menu.saveTo.onedrive' : 'cloud.menu.saveTo.gdrive'),
          disabled: !hasDocument,
          onSelect: () => cloud.startSaveAs(provider),
        })),
        // A file from a drive saves back to it; this keeps a copy here too.
        ...(cloud.binding && hasDocument
          ? [{ id: 'save-device', label: t('cloud.menu.saveToDevice'), onSelect: () => void services.saveToDevice() }]
          : []),
        ...(services.canPrint || !isTauriHost()
          ? [
              {
                id: 'print',
                label: t('file.print'),
                keys: 'Mod+P',
                disabled: !services.canPrint,
                onSelect: () => services.viewCommand('print'),
              },
            ]
          : []),
        {
          id: 'close',
          label: t('file.close'),
          disabled: !hasDocument,
          separatorBefore: true,
          onSelect: services.closeDocument,
        },
      ],
    },
    {
      id: 'edit',
      label: t('menu.edit'),
      items: [
        {
          id: 'undo',
          label: t('edit.undo'),
          keys: 'Mod+Z',
          disabled: typing.editing ? !typing.canUndo : !hasDocument || !services.canUndo,
          onSelect: () => undoOrRedo('undo', () => services.viewCommand('undo')),
        },
        {
          id: 'redo',
          label: t('edit.redo'),
          keys: 'Mod+Shift+Z',
          disabled: typing.editing ? !typing.canRedo : !hasDocument || !services.canRedo,
          onSelect: () => undoOrRedo('redo', () => services.viewCommand('redo')),
        },
        {
          id: 'edit-mode',
          label: t('edit.mode'),
          role: 'menuitemcheckbox',
          checked: edit.active,
          disabled: !hasDocument,
          separatorBefore: true,
          onSelect: () => dispatch({ type: 'EDIT_MODE', active: !edit.active }),
        },
        { id: 'find', label: t('edit.find'), keys: 'Mod+F', disabled: !hasDocument || organizing, separatorBefore: true, onSelect: () => services.viewCommand('find') },
        {
          id: 'goto',
          label: t('edit.goToPage'),
          keys: 'Mod+Shift+N',
          disabled: !hasDocument,
          onSelect: () => dispatch({ type: 'DIALOG', dialog: 'goto' }),
        },
      ],
    },
    {
      id: 'view',
      label: t('menu.view'),
      items: [
        { id: 'zoom-in', label: t('view.zoomIn'), keys: 'Mod+=', disabled: !hasDocument || organizing, onSelect: () => services.viewCommand('zoom-in') },
        { id: 'zoom-out', label: t('view.zoomOut'), keys: 'Mod+-', disabled: !hasDocument || organizing, onSelect: () => services.viewCommand('zoom-out') },
        { id: 'fit-width', label: t('view.fitWidth'), keys: 'Mod+1', role: 'menuitemradio', checked: hasDocument && services.viewCommandOn('fit-width'), disabled: !hasDocument || organizing, onSelect: () => services.viewCommand('fit-width') },
        { id: 'fit-page', label: t('view.fitPage'), keys: 'Mod+0', role: 'menuitemradio', checked: hasDocument && services.viewCommandOn('fit-page'), disabled: !hasDocument || organizing, onSelect: () => services.viewCommand('fit-page') },
        { id: 'actual', label: t('view.actualSize'), disabled: !hasDocument || organizing, onSelect: () => services.viewCommand('actual-size') },
        { id: 'left-pane', label: t('view.leftPane'), keys: 'F4', role: 'menuitemcheckbox', checked: hasDocument && services.viewCommandOn('sidebar'), disabled: !hasDocument || organizing, separatorBefore: true, onSelect: () => services.viewCommand('sidebar') },
        ...(['bookmarks', 'attachments', 'layers'] as const).map((pane) => ({
          id: `pane-${pane}`,
          label: t(`view.${pane}`),
          role: 'menuitemradio' as const,
          checked: hasDocument && state.leftPane.open && state.leftPane.tab === pane,
          disabled: !hasDocument || organizing,
          onSelect: () => dispatch({ type: 'SET_LEFT_TAB', tab: pane }),
        })),
        { id: 'right-pane', label: t('view.rightPane'), keys: 'Shift+F4', role: 'menuitemcheckbox', checked: state.rightPane.open && !noSheet, disabled: noSheet, onSelect: () => dispatch({ type: 'TOGGLE_RIGHT_PANE' }) },
        {
          id: 'markup',
          label: t('shell.markup'),
          role: 'menuitemcheckbox',
          checked: services.embedShowing && markup.on,
          disabled: !hasDocument || !services.embedShowing,
          onSelect: () => markup.set(!markup.on),
        },
        {
          id: 'read-aloud',
          label: t('readAloud.label'),
          role: 'menuitemcheckbox',
          checked: hasDocument && readAloudState().open,
          disabled: !hasDocument || organizing,
          onSelect: () => (readAloudState().open ? closeBar() : openBar()),
        },
        ...PAGE_LAYOUTS.map((layout, index) => ({
          id: `layout-${layout}`,
          label: `${t('prefs.pageLayout')}: ${t(`prefs.layout.${layout}`)}`,
          role: 'menuitemradio' as const,
          checked: settings.pageLayout === layout,
          disabled: organizing,
          separatorBefore: index === 0,
          onSelect: () => updateSettings({ pageLayout: layout }),
        })),
        { ...themeItem('system', `${t('theme.label')}: ${t('theme.system')}`), separatorBefore: true },
        themeItem('light', `${t('theme.label')}: ${t('theme.light')}`),
        themeItem('dark', `${t('theme.label')}: ${t('theme.dark')}`),
        ...LOOK_IDS.map((look, index) => (index === 0 ? { ...lookItem(look), separatorBefore: true } : lookItem(look))),
      ],
    },
    {
      id: 'tools',
      label: t('menu.tools'),
      items: [
        ...TOOLS.map((tool) => ({
          id: `tool-${tool.id}`,
          label: t(tool.labelKey),
          role: 'menuitemradio' as const,
          checked: state.rightPane.activeTool === tool.id,
          onSelect: () => dispatch({ type: 'SET_ACTIVE_TOOL', tool: tool.id }),
        })),
        {
          id: 'present',
          label: t('present.start'),
          disabled: state.document === null,
          separatorBefore: true,
          onSelect: () => startPresenting(state.currentPage),
        },
        // The phone remote: the desktop only (a browser cannot be reached from a phone).
        ...(remoteAvailable() ? [{ id: 'phone-remote', label: t('remote.menu'), onSelect: openRemoteSheet }] : []),
      ],
    },
    {
      id: 'help',
      label: t('menu.help'),
      items: [
        { id: 'support', label: t('help.support'), keys: 'F1', onSelect: () => openSupportAt('ask', () => dispatch({ type: 'DIALOG', dialog: 'support' })) },
        { id: 'report', label: t('help.report'), onSelect: () => openSupportAt('report', () => dispatch({ type: 'DIALOG', dialog: 'support' })) },
        { id: 'ideas', label: t('help.ideas'), onSelect: () => openSupportAt('ideas', () => dispatch({ type: 'DIALOG', dialog: 'support' })) },
        { id: 'tour', label: t('help.tour'), separatorBefore: true, onSelect: () => dispatch({ type: 'DIALOG', dialog: 'tour' }) },
        // Ask ZOOD's keys work in every app, so they have their own way in: the tour's practice.
        ...(askAvailable() ? [{ id: 'ask-keys', label: t('help.askKeys'), onSelect: () => openTourAt('ask', () => dispatch({ type: 'DIALOG', dialog: 'tour' })) }] : []),
        // Show me, Explain this and Do it for me, played on a pretend window.
        ...(askAvailable() ? [{ id: 'ask-guide', label: t('help.askGuide'), onSelect: () => openTourAt('ask', () => dispatch({ type: 'DIALOG', dialog: 'tour' }), 'guide') }] : []),
        ...(askAvailable() ? [{ id: 'quick-asks', label: t('help.quickAsks'), onSelect: () => openTourAt('quickask', () => dispatch({ type: 'DIALOG', dialog: 'tour' })) }] : []),
        ...(isTauriHost() ? [{ id: 'always-ready', label: t('help.reach'), onSelect: () => openTourAt('reach', () => dispatch({ type: 'DIALOG', dialog: 'tour' })) }] : []),
        // The AI's chat about anything and the commands it does: the tour's AI chapter, with its practice.
        { id: 'ai-chat', label: t('help.aiChat'), onSelect: () => openTourAt('ai', () => dispatch({ type: 'DIALOG', dialog: 'tour' })) },
        { id: 'shortcuts', label: t('help.shortcuts'), onSelect: () => dispatch({ type: 'DIALOG', dialog: 'shortcuts' }) },
      ],
    },
  ];
  // Keys the person chose in Settings › Keyboard take the place of the defaults.
  const chosen = settings.shortcuts;
  const rebound = (item: MenuItemModel): MenuItemModel =>
    item.id in chosen ? { ...item, defaultKeys: item.keys, keys: chosen[item.id] } : { ...item, defaultKeys: item.keys };
  return menus.map((menu) => ({ ...menu, items: menu.items.map(rebound).map(withShortcut) }));
}
