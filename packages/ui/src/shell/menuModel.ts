import { isTauriHost } from '../core/host-tauri';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import type { ThemeMode } from '../state/preferences';
import { useT } from '../i18n/useT';
import { TOOLS } from '../tools/tools';

export interface MenuItemModel {
  id: string;
  label: string;
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

/** Human-readable modifier for shortcut hints. */
export function modKeyLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl';
}

/**
 * Built on every render, not memoized: the checks on Fit width, Fit page and
 * the navigation pane read EmbedPDF's own state, which React does not see
 * change, and a menu re-renders the moment it opens.
 */
export function useMenuModel(): MenuModel[] {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const t = useT();
  const hasDocument = state.view === 'viewer' && state.document !== null;
  // The page grid has no zoom, find or thumbnails: those would do nothing there.
  const organizing = hasDocument && state.rightPane.activeTool === 'organize';
  const mod = modKeyLabel();
  const edit = state.edit;

  const themeItem = (theme: ThemeMode, label: string): MenuItemModel => ({
    id: `theme-${theme}`,
    label,
    role: 'menuitemradio',
    checked: state.theme === theme,
    onSelect: () => dispatch({ type: 'SET_THEME', theme }),
  });
  return [
    {
      id: 'file',
      label: t('menu.file'),
      items: [
        { id: 'open', label: t('file.open'), shortcut: `${mod}+O`, onSelect: services.requestOpenFile },
        {
          id: 'save',
          label: t('file.save'),
          shortcut: `${mod}+S`,
          disabled: !hasDocument,
          onSelect: () => void services.saveDocument(),
        },
        ...(services.canPrint || !isTauriHost()
          ? [
              {
                id: 'print',
                label: t('file.print'),
                shortcut: `${mod}+P`,
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
          shortcut: `${mod}+Z`,
          disabled: !hasDocument || !services.canUndo,
          onSelect: () => services.viewCommand('undo'),
        },
        {
          id: 'redo',
          label: t('edit.redo'),
          shortcut: `${mod}+Shift+Z`,
          disabled: !hasDocument || !services.canRedo,
          onSelect: () => services.viewCommand('redo'),
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
        { id: 'find', label: t('edit.find'), shortcut: `${mod}+F`, disabled: !hasDocument || organizing, separatorBefore: true, onSelect: () => services.viewCommand('find') },
        {
          id: 'goto',
          label: t('edit.goToPage'),
          shortcut: `${mod}+Shift+N`,
          disabled: !hasDocument,
          onSelect: () => dispatch({ type: 'DIALOG', dialog: 'goto' }),
        },
      ],
    },
    {
      id: 'view',
      label: t('menu.view'),
      items: [
        { id: 'zoom-in', label: t('view.zoomIn'), shortcut: `${mod}+=`, disabled: !hasDocument || organizing, onSelect: () => services.viewCommand('zoom-in') },
        { id: 'zoom-out', label: t('view.zoomOut'), shortcut: `${mod}+-`, disabled: !hasDocument || organizing, onSelect: () => services.viewCommand('zoom-out') },
        { id: 'fit-width', label: t('view.fitWidth'), shortcut: `${mod}+1`, role: 'menuitemradio', checked: hasDocument && services.viewCommandOn('fit-width'), disabled: !hasDocument || organizing, onSelect: () => services.viewCommand('fit-width') },
        { id: 'fit-page', label: t('view.fitPage'), shortcut: `${mod}+0`, role: 'menuitemradio', checked: hasDocument && services.viewCommandOn('fit-page'), disabled: !hasDocument || organizing, onSelect: () => services.viewCommand('fit-page') },
        { id: 'actual', label: t('view.actualSize'), disabled: !hasDocument || organizing, onSelect: () => services.viewCommand('actual-size') },
        { id: 'left-pane', label: t('view.leftPane'), shortcut: 'F4', role: 'menuitemcheckbox', checked: hasDocument && services.viewCommandOn('sidebar'), disabled: !hasDocument || organizing, separatorBefore: true, onSelect: () => services.viewCommand('sidebar') },
        ...(['bookmarks', 'attachments', 'layers'] as const).map((pane) => ({
          id: `pane-${pane}`,
          label: t(`view.${pane}`),
          role: 'menuitemradio' as const,
          checked: hasDocument && state.leftPane.open && state.leftPane.tab === pane,
          disabled: !hasDocument || organizing,
          onSelect: () => dispatch({ type: 'SET_LEFT_TAB', tab: pane }),
        })),
        { id: 'right-pane', label: t('view.rightPane'), shortcut: 'Shift+F4', role: 'menuitemcheckbox', checked: state.rightPane.open, onSelect: () => dispatch({ type: 'TOGGLE_RIGHT_PANE' }) },
        { ...themeItem('system', `${t('theme.label')}: ${t('theme.system')}`), separatorBefore: true },
        themeItem('light', `${t('theme.label')}: ${t('theme.light')}`),
        themeItem('dark', `${t('theme.label')}: ${t('theme.dark')}`),
      ],
    },
    {
      id: 'tools',
      label: t('menu.tools'),
      items: TOOLS.map((tool) => ({
        id: `tool-${tool.id}`,
        label: t(tool.labelKey),
        onSelect: () => dispatch({ type: 'SET_ACTIVE_TOOL', tool: tool.id }),
      })),
    },
    {
      id: 'help',
      label: t('menu.help'),
      items: [
        { id: 'shortcuts', label: t('help.shortcuts'), onSelect: () => dispatch({ type: 'DIALOG', dialog: 'shortcuts' }) },
        { id: 'about', label: t('help.about'), onSelect: () => dispatch({ type: 'DIALOG', dialog: 'about' }) },
      ],
    },
  ];
}
