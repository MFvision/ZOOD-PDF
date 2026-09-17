import { useMemo } from 'react';
import { canRedo, canUndo } from '../edit/editStack';
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

export function useMenuModel(): MenuModel[] {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const t = useT();
  const hasDocument = state.view === 'viewer' && state.document !== null;
  const mod = modKeyLabel();
  const edit = state.edit;

  return useMemo<MenuModel[]>(() => {
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
            disabled: !hasDocument || edit.busy || !canUndo(edit.stack),
            onSelect: () => void services.undoEdit(),
          },
          {
            id: 'redo',
            label: t('edit.redo'),
            shortcut: `${mod}+Shift+Z`,
            disabled: !hasDocument || edit.busy || !canRedo(edit.stack),
            onSelect: () => void services.redoEdit(),
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
          { id: 'find', label: t('edit.find'), shortcut: `${mod}+F`, disabled: !hasDocument, separatorBefore: true, onSelect: () => dispatch({ type: 'FIND_OPEN' }) },
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
          { id: 'zoom-in', label: t('view.zoomIn'), shortcut: `${mod}+=`, disabled: !hasDocument, onSelect: () => dispatch({ type: 'ZOOM_IN' }) },
          { id: 'zoom-out', label: t('view.zoomOut'), shortcut: `${mod}+-`, disabled: !hasDocument, onSelect: () => dispatch({ type: 'ZOOM_OUT' }) },
          { id: 'fit-width', label: t('view.fitWidth'), role: 'menuitemradio', checked: state.zoomMode === 'fit-width', disabled: !hasDocument, onSelect: () => dispatch({ type: 'SET_ZOOM_MODE', mode: 'fit-width' }) },
          { id: 'fit-page', label: t('view.fitPage'), shortcut: `${mod}+0`, role: 'menuitemradio', checked: state.zoomMode === 'fit-page', disabled: !hasDocument, onSelect: () => dispatch({ type: 'SET_ZOOM_MODE', mode: 'fit-page' }) },
          { id: 'actual', label: t('view.actualSize'), shortcut: `${mod}+1`, disabled: !hasDocument, onSelect: () => dispatch({ type: 'SET_ZOOM', zoom: 1 }) },
          { id: 'left-pane', label: t('view.leftPane'), shortcut: 'F4', role: 'menuitemcheckbox', checked: state.leftPane.open, disabled: !hasDocument, separatorBefore: true, onSelect: () => dispatch({ type: 'TOGGLE_LEFT_PANE' }) },
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
  }, [state.theme, state.zoomMode, state.leftPane.open, state.rightPane.open, edit, hasDocument, dispatch, services, t, mod]);
}
