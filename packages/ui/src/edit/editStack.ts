/**
 * Undo/redo for paragraph edits.
 *
 * Every entry is the whole text of one paragraph before and after the edit, so
 * both directions are the same core call — `replace_paragraph` with the text
 * from the other side of the entry. That keeps the stack independent of how the
 * core rewrites content streams: the UI never has to model the PDF, only the
 * text it asked for.
 *
 * `cursor` is the number of applied entries, so `entries.slice(0, cursor)` is
 * the history that is currently on the page and everything after it is redoable.
 */

export interface EditEntry {
  /** 0-based page index, as the core numbers pages. */
  page: number;
  paragraphIndex: number;
  before: string;
  after: string;
}

export interface EditStack {
  entries: readonly EditEntry[];
  cursor: number;
}

/** What the caller must hand to `replace_paragraph` to move one step. */
export interface EditChange {
  page: number;
  paragraphIndex: number;
  text: string;
}

export interface StackStep {
  stack: EditStack;
  change: EditChange;
}

export const EMPTY_EDIT_STACK: EditStack = { entries: [], cursor: 0 };

export function canUndo(stack: EditStack): boolean {
  return stack.cursor > 0;
}

export function canRedo(stack: EditStack): boolean {
  return stack.cursor < stack.entries.length;
}

/**
 * Records a committed edit. Anything that had been undone is dropped: editing
 * after an undo starts a new branch, exactly as every other editor behaves.
 */
export function applyEdit(stack: EditStack, entry: EditEntry): EditStack {
  return { entries: [...stack.entries.slice(0, stack.cursor), entry], cursor: stack.cursor + 1 };
}

/** The entry to reverse, or `null` when there is nothing to undo. */
export function undo(stack: EditStack): StackStep | null {
  if (!canUndo(stack)) return null;
  const entry = stack.entries[stack.cursor - 1];
  if (!entry) return null;
  return {
    stack: { entries: stack.entries, cursor: stack.cursor - 1 },
    change: { page: entry.page, paragraphIndex: entry.paragraphIndex, text: entry.before },
  };
}

/** The entry to replay, or `null` when there is nothing to redo. */
export function redo(stack: EditStack): StackStep | null {
  if (!canRedo(stack)) return null;
  const entry = stack.entries[stack.cursor];
  if (!entry) return null;
  return {
    stack: { entries: stack.entries, cursor: stack.cursor + 1 },
    change: { page: entry.page, paragraphIndex: entry.paragraphIndex, text: entry.after },
  };
}
