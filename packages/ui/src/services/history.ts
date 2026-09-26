/**
 * Undo/redo for core (engine) edits: a stack of whole document versions (ADR 0007). Every core edit
 * is an incremental update, so each version is a byte prefix of the next one and "undo" is simply
 * showing the previous version again. Bounded by entry count and by the bytes kept.
 */

export interface HistoryStep {
  bytes: Uint8Array;
  label: string;
}

interface Entry {
  before: Uint8Array;
  after: Uint8Array;
  label: string;
}

export interface History {
  /** A change turned `before` into `after`. Clears redo. */
  record(before: Uint8Array, after: Uint8Array, label: string): void;
  /** The version to show when undoing from `current`, or null (nothing to undo / out of sync). */
  undo(current: Uint8Array): HistoryStep | null;
  redo(current: Uint8Array): HistoryStep | null;
  canUndo(): boolean;
  canRedo(): boolean;
  undoLabel(): string | undefined;
  redoLabel(): string | undefined;
  size(): number;
  clear(): void;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  // Versions differ at the end (appended updates): compare from the back first.
  for (let i = a.byteLength - 1; i >= 0; i--) if (a[i] !== b[i]) return false;
  return true;
}

export function createHistory(opts: { maxEntries?: number; maxBytes?: number } = {}): History {
  const maxEntries = opts.maxEntries ?? 40;
  const maxBytes = opts.maxBytes ?? 400 * 1024 * 1024;
  let done: Entry[] = [];
  let undone: Entry[] = [];
  const weight = (list: Entry[]) => list.reduce((s, e) => s + e.before.byteLength, 0);
  const trim = () => {
    while (done.length > maxEntries || (done.length > 1 && weight(done) + weight(undone) > maxBytes)) done.shift();
    while (undone.length > 0 && weight(done) + weight(undone) > maxBytes) undone.shift();
  };
  return {
    record(before, after, label) {
      done.push({ before, after, label });
      undone = [];
      trim();
    },
    undo(current) {
      const e = done[done.length - 1];
      if (!e || !same(e.after, current)) return null;
      done.pop();
      undone.push(e);
      return { bytes: e.before, label: e.label };
    },
    redo(current) {
      const e = undone[undone.length - 1];
      if (!e || !same(e.before, current)) return null;
      undone.pop();
      done.push(e);
      return { bytes: e.after, label: e.label };
    },
    canUndo: () => done.length > 0,
    canRedo: () => undone.length > 0,
    undoLabel: () => done[done.length - 1]?.label,
    redoLabel: () => undone[undone.length - 1]?.label,
    size: () => done.length,
    clear() {
      done = [];
      undone = [];
    },
  };
}
