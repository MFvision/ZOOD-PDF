import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';

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

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = stateRef.current;
      const hasDocument = current.view === 'viewer' && current.document !== null;
      const mod = event.metaKey || event.ctrlKey;

      if (event.key === 'F4' && !mod && !event.altKey) {
        event.preventDefault();
        if (event.shiftKey) dispatch({ type: 'TOGGLE_RIGHT_PANE' });
        else if (hasDocument) services.viewCommand('sidebar');
        return;
      }
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();

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
      if (key === 'o') {
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
