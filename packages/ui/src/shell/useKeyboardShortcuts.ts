import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';

const isZoomInKey = (event: KeyboardEvent) =>
  event.key === '=' || event.key === '+' || event.code === 'Equal' || event.code === 'NumpadAdd';
const isZoomOutKey = (event: KeyboardEvent) =>
  event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract';

/**
 * Global shortcuts documented in SHORTCUTS.md. Ctrl and Cmd are interchangeable.
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
        else if (hasDocument) dispatch({ type: 'TOGGLE_LEFT_PANE' });
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
          void services.redoEdit();
        } else if (isZoomInKey(event) && hasDocument) {
          event.preventDefault();
          dispatch({ type: 'ZOOM_IN' });
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
        void services.undoEdit();
      } else if (key === 'f' && hasDocument) {
        event.preventDefault();
        dispatch({ type: 'FIND_OPEN' });
      } else if (isZoomInKey(event) && hasDocument) {
        event.preventDefault();
        dispatch({ type: 'ZOOM_IN' });
      } else if (isZoomOutKey(event) && hasDocument) {
        event.preventDefault();
        dispatch({ type: 'ZOOM_OUT' });
      } else if ((key === '0' || event.code === 'Numpad0') && hasDocument) {
        event.preventDefault();
        dispatch({ type: 'SET_ZOOM_MODE', mode: 'fit-page' });
      } else if ((key === '1' || event.code === 'Numpad1') && hasDocument) {
        event.preventDefault();
        dispatch({ type: 'SET_ZOOM', zoom: 1 });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch, services]);
}
