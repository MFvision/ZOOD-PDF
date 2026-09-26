import { describe, expect, it } from 'vitest';
import { createHistory } from './history';

const b = (n: number, size = 4) => new Uint8Array(size).fill(n);

describe('byte-version undo history', () => {
  it('undo returns the version before the change, redo the change', () => {
    const h = createHistory();
    expect(h.canUndo()).toBe(false);
    h.record(b(0), b(1), 'rotate');
    h.record(b(1), b(2), 'delete');
    expect(h.undoLabel()).toBe('delete');
    expect(h.undo(b(2))).toEqual({ bytes: b(1), label: 'delete' });
    expect(h.undo(b(1))).toEqual({ bytes: b(0), label: 'rotate' });
    expect(h.canUndo()).toBe(false);
    expect(h.redo(b(0))).toEqual({ bytes: b(1), label: 'rotate' });
    expect(h.redoLabel()).toBe('delete');
  });

  it('a new change clears redo', () => {
    const h = createHistory();
    h.record(b(0), b(1), 'a');
    h.undo(b(1));
    expect(h.canRedo()).toBe(true);
    h.record(b(0), b(9), 'b');
    expect(h.canRedo()).toBe(false);
    expect(h.undo(b(9))?.bytes).toEqual(b(0));
  });

  it('refuses to undo when the current bytes are not what the history expects', () => {
    const h = createHistory();
    h.record(b(0), b(1), 'a');
    expect(h.undo(b(7))).toBeNull();
    expect(h.canUndo()).toBe(true);
  });

  it('is bounded by entries and by bytes, dropping the oldest', () => {
    const h = createHistory({ maxEntries: 3, maxBytes: 1_000 });
    for (let i = 0; i < 5; i++) h.record(b(i), b(i + 1), `s${i}`);
    expect(h.size()).toBe(3);
    const small = createHistory({ maxEntries: 50, maxBytes: 250 });
    for (let i = 0; i < 5; i++) small.record(b(i, 100), b(i + 1, 100), `s${i}`);
    // each entry keeps the version before it (100 bytes): at most 2 fit
    expect(small.size()).toBe(2);
    expect(small.undo(b(5, 100))?.label).toBe('s4');
  });

  it('clear forgets everything (e.g. after saving)', () => {
    const h = createHistory();
    h.record(b(0), b(1), 'a');
    h.clear();
    expect(h.canUndo()).toBe(false);
  });
});
