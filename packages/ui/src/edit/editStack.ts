/**
 * Undo/redo for Edit: paragraph edits, and picture and link changes.
 *
 * A paragraph entry is the whole text of one paragraph before and after the
 * edit, so both directions are the same core call — `replace_paragraph` with
 * the text from the other side of the entry. That keeps the stack independent
 * of how the core rewrites content streams: the UI never has to model the
 * PDF, only the text it asked for.
 *
 * A picture or link change has no text to replay, so its entry names a copy
 * of the file (`snapshot`, kept by the app beside the stack): undoing it puts
 * the file back as it was, byte for byte, and keeps the file as it is in the
 * same place for the redo. Both kinds share one stack, so Undo always takes
 * back the last change, whatever kind it was.
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

/** A picture or link change: the file on the other side of it is `snapshot`. */
export interface FileEntry {
  page: number;
  snapshot: number;
}

export type StackEntry = EditEntry | FileEntry;

export interface EditStack {
  entries: readonly StackEntry[];
  cursor: number;
}

/** What the caller must hand to `replace_paragraph` to move one step. */
export interface EditChange {
  page: number;
  paragraphIndex: number;
  text: string;
}

/** Or: the file to put back — and, in its place, the file as it is now. */
export interface FileChange {
  page: number;
  snapshot: number;
}

export interface StackStep {
  stack: EditStack;
  change: EditChange | FileChange;
}

/** Picture and link changes kept for undo, each a copy of the whole file. */
export const MAX_FILE_ENTRIES = 10;

export const EMPTY_EDIT_STACK: EditStack = { entries: [], cursor: 0 };

export function isFileEntry(entry: StackEntry | EditChange | FileChange): entry is FileEntry {
  return 'snapshot' in entry;
}

export function canUndo(stack: EditStack): boolean {
  return stack.cursor > 0;
}

export function canRedo(stack: EditStack): boolean {
  return stack.cursor < stack.entries.length;
}

/**
 * Records a committed change. Anything that had been undone is dropped: editing
 * after an undo starts a new branch, exactly as every other editor behaves.
 * Past `MAX_FILE_ENTRIES` picture and link changes, the oldest history goes,
 * up to and with the oldest of them.
 */
export function applyEdit(stack: EditStack, entry: StackEntry): EditStack {
  let entries = [...stack.entries.slice(0, stack.cursor), entry];
  while (entries.filter(isFileEntry).length > MAX_FILE_ENTRIES) {
    entries = entries.slice(entries.findIndex(isFileEntry) + 1);
  }
  return { entries, cursor: entries.length };
}

/** The snapshots the stack still names: every other one can be let go. */
export function snapshotsIn(stack: EditStack): Set<number> {
  return new Set(stack.entries.filter(isFileEntry).map((entry) => entry.snapshot));
}

/** The entry to reverse, or `null` when there is nothing to undo. */
export function undo(stack: EditStack): StackStep | null {
  if (!canUndo(stack)) return null;
  const entry = stack.entries[stack.cursor - 1];
  if (!entry) return null;
  return {
    stack: { entries: stack.entries, cursor: stack.cursor - 1 },
    change: isFileEntry(entry)
      ? { page: entry.page, snapshot: entry.snapshot }
      : { page: entry.page, paragraphIndex: entry.paragraphIndex, text: entry.before },
  };
}

/** The entry to replay, or `null` when there is nothing to redo. */
export function redo(stack: EditStack): StackStep | null {
  if (!canRedo(stack)) return null;
  const entry = stack.entries[stack.cursor];
  if (!entry) return null;
  return {
    stack: { entries: stack.entries, cursor: stack.cursor + 1 },
    change: isFileEntry(entry)
      ? { page: entry.page, snapshot: entry.snapshot }
      : { page: entry.page, paragraphIndex: entry.paragraphIndex, text: entry.after },
  };
}
