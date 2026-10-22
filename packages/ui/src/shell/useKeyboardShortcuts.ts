import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { SHEET_QUERY } from './sheetDrag';
import { comboOf, normalizeKeys, shortcutLetter } from './shortcutEcho';
import { isApplePlatform, useMenuModel } from './menuModel';
import type { MenuItemModel } from './menuModel';
import { isEditable } from './typing';
import { openSupportAt } from '../support/open';

const isZoomInKey = (event: KeyboardEvent) =>
  event.key === '=' || event.key === '+' || event.code === 'Equal' || event.code === 'NumpadAdd';
const isZoomOutKey = (event: KeyboardEvent) =>
  event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract';

/**
 * Global shortcuts documented in SHORTCUTS.md. Ctrl and Cmd are interchangeable.
 *
 * They act on the view on screen (`viewCommand`). EmbedPDF also listens for
 * most of these while it is showing and takes the key first, so each runs
 * once; the ones it has no key for — F4, Mod+Shift+N — arrive here and are
 * handed to it.
 *
 * The paragraph editor stops Escape and Mod+Enter before they reach here, and
 * undo/redo are no-ops on an empty stack, so typing inside it is unaffected.
 */
export function useKeyboardShortcuts(): void {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const stateRef = useRef(state);
  // The commands whose keys the person changed (Settings › Keyboard), read at the key press.
  const menus = useMenuModel();
  const reboundRef = useRef<MenuItemModel[]>([]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    reboundRef.current = menus.flatMap((menu) => menu.items).filter((item) => item.defaultKeys !== undefined && item.keys !== item.defaultKeys);
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A changed shortcut first: its new keys run its command, and its old
      // keys do nothing, so they are free for another.
      if (reboundRef.current.length > 0 && !['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
        const combo = normalizeKeys(comboOf(event, isApplePlatform()));
        const chosen = reboundRef.current.find((item) => item.keys && normalizeKeys(item.keys) === combo);
        if (chosen) {
          event.preventDefault();
          if (!chosen.disabled) chosen.onSelect?.();
          return;
        }
        if (reboundRef.current.some((item) => item.defaultKeys && normalizeKeys(item.defaultKeys) === combo)) {
          event.preventDefault();
          return;
        }
      }
      const current = stateRef.current;
      const hasDocument = current.view === 'viewer' && current.document !== null;
      const mod = event.metaKey || event.ctrlKey;

      if (event.key === 'F1' && !mod && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        openSupportAt('ask', () => dispatch({ type: 'DIALOG', dialog: 'support' }));
        return;
      }
      if (event.key === 'F4' && !mod && !event.altKey) {
        event.preventDefault();
        // A narrow window raises the sheet for a chosen tool only (panes.css).
        const noSheet = globalThis.matchMedia?.(SHEET_QUERY).matches && current.rightPane.activeTool === null;
        if (event.shiftKey) {
          if (!noSheet) dispatch({ type: 'TOGGLE_RIGHT_PANE' });
        }
        else if (hasDocument) services.viewCommand('sidebar');
        return;
      }
      if (!mod || event.altKey) return;
      // The letter wherever the layout puts it: on an Arabic keyboard ⌘Z types ئ.
      const key = shortcutLetter(event);

      // In a text field Undo and Redo are the typing's. Handled here, not left
      // to the browser, so the macOS menu bar's Undo never runs on top of it.
      if (key === 'z' && isEditable(event.composedPath()[0] as Element)) {
        event.preventDefault();
        document.execCommand(event.shiftKey ? 'redo' : 'undo');
        return;
      }

      if (event.shiftKey) {
        if (key === 'n' && hasDocument) {
          event.preventDefault();
          dispatch({ type: 'DIALOG', dialog: 'goto' });
        } else if (key === 'z' && hasDocument) {
          event.preventDefault();
          services.viewCommand('redo');
        } else if (isZoomInKey(event) && hasDocument) {
          event.preventDefault();
          services.viewCommand('zoom-in');
        }
        return;
      }
      if (key === ',' || event.code === 'Comma') {
        event.preventDefault();
        dispatch({ type: 'DIALOG', dialog: 'settings' });
      } else if (key === 'o') {
        event.preventDefault();
        services.requestOpenFile();
      } else if (key === 's') {
        // Always swallowed, so the browser's own "save page" never appears.
        event.preventDefault();
        if (hasDocument) void services.saveDocument();
      } else if (key === 'z' && hasDocument) {
        event.preventDefault();
        services.viewCommand('undo');
      } else if (key === 'f' && hasDocument) {
        event.preventDefault();
        services.viewCommand('find');
      } else if (isZoomInKey(event) && hasDocument) {
        event.preventDefault();
        services.viewCommand('zoom-in');
      } else if (isZoomOutKey(event) && hasDocument) {
        event.preventDefault();
        services.viewCommand('zoom-out');
      } else if ((key === '0' || event.code === 'Numpad0') && hasDocument) {
        event.preventDefault();
        services.viewCommand('fit-page');
      } else if ((key === '1' || event.code === 'Numpad1') && hasDocument) {
        // Fit width, as EmbedPDF has it: one meaning for the key in both views.
        event.preventDefault();
        services.viewCommand('fit-width');
      } else if (key === 'p' && hasDocument) {
        // Never the browser's print of the whole window.
        event.preventDefault();
        if (services.canPrint) services.viewCommand('print');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch, services]);
}
