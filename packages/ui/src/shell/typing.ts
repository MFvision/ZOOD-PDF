import { useEffect, useState } from 'react';

/**
 * The typing in a text field, as a menu's Undo and Redo reach it.
 *
 * The macOS menu bar leaves the focus where the person was typing, and its
 * Undo and Redo are the page's own items (`menuModel.ts`), so they must undo
 * the typing while a field has the focus — as the system's Undo did before
 * the menu bar was built from the page's model. Before this they were enabled
 * only by the document's history, and chose by `document.activeElement`,
 * which inside EmbedPDF's shadow root is its host element: Undo was dead in
 * a field until something in the document could be undone, and in EmbedPDF's
 * search field it took back the last drawing instead of the typing.
 */

/** A text field, text area or editable element: where Undo means the typing. */
export function isEditable(element: Element | null | undefined): boolean {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (element instanceof HTMLInputElement) return !element.readOnly && !/^(checkbox|radio|button|submit|range|color|file)$/.test(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

/** The element with the focus, looked for inside shadow roots: EmbedPDF's fields are in one. */
export function focusedElement(): Element | null {
  if (typeof document === 'undefined') return null;
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

export interface Typing {
  /** A text field has the focus: Undo and Redo are its typing's. */
  editing: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

const NOT_TYPING: Typing = { editing: false, canUndo: false, canRedo: false };

/** What the browser says its editing history can do; if it cannot say, the item stays usable. */
function historyAllows(command: 'undo' | 'redo'): boolean {
  try {
    return document.queryCommandEnabled(command);
  } catch {
    return true;
  }
}

/** Follows whether a text field has the focus and what its typing can undo and redo. */
export function useTyping(): Typing {
  const [typing, setTyping] = useState<Typing>(NOT_TYPING);
  useEffect(() => {
    const read = () => {
      const next = isEditable(focusedElement())
        ? { editing: true, canUndo: historyAllows('undo'), canRedo: historyAllows('redo') }
        : NOT_TYPING;
      setTyping((current) =>
        current.editing === next.editing && current.canUndo === next.canUndo && current.canRedo === next.canRedo ? current : next,
      );
    };
    // Read once the event is over, never during it: a state change made
    // while an `input` event is still on its way re-renders a controlled
    // field before React has seen the event, and puts the old value back —
    // the key just typed was lost.
    let timer = 0;
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(read, 0);
    };
    // Focus and input events are composed: those of EmbedPDF's fields arrive here too.
    const events = ['focusin', 'focusout', 'input'] as const;
    for (const type of events) document.addEventListener(type, later, true);
    read();
    return () => {
      window.clearTimeout(timer);
      for (const type of events) document.removeEventListener(type, later, true);
    };
  }, []);
  return typing;
}

/** Undo or Redo of the typing in the field that has the focus; false when no field has it. */
export function undoTyping(which: 'undo' | 'redo'): boolean {
  if (!isEditable(focusedElement())) return false;
  document.execCommand(which);
  return true;
}
