import { describe, expect, it } from 'vitest';
import { applyEdit, canRedo, canUndo, EMPTY_EDIT_STACK, MAX_FILE_ENTRIES, redo, snapshotsIn, undo } from './editStack';
import type { EditChange, EditEntry, EditStack, FileEntry, StackEntry } from './editStack';

const first: EditEntry = { page: 0, paragraphIndex: 1, before: 'الأصل', after: 'الجديد' };
const second: EditEntry = { page: 2, paragraphIndex: 0, before: 'قديم', after: 'حديث' };

function stackOf(...entries: StackEntry[]): EditStack {
  return entries.reduce(applyEdit, EMPTY_EDIT_STACK);
}

describe('edit undo stack', () => {
  it('starts empty, with nothing to undo or redo', () => {
    expect(canUndo(EMPTY_EDIT_STACK)).toBe(false);
    expect(canRedo(EMPTY_EDIT_STACK)).toBe(false);
    expect(undo(EMPTY_EDIT_STACK)).toBeNull();
    expect(redo(EMPTY_EDIT_STACK)).toBeNull();
  });

  it('records applied edits without mutating the previous stack', () => {
    const one = applyEdit(EMPTY_EDIT_STACK, first);
    const two = applyEdit(one, second);
    expect(one.entries).toHaveLength(1);
    expect(one.cursor).toBe(1);
    expect(two.entries).toHaveLength(2);
    expect(two.cursor).toBe(2);
    expect(EMPTY_EDIT_STACK.entries).toHaveLength(0);
  });

  it('undo asks for the text from before the edit', () => {
    const step = undo(stackOf(first, second));
    expect(step?.change).toEqual({ page: 2, paragraphIndex: 0, text: 'قديم' });
    expect(step?.stack.cursor).toBe(1);
    expect(step?.stack.entries).toHaveLength(2);
  });

  it('redo replays the text from after the edit', () => {
    const undone = undo(stackOf(first, second));
    const step = redo(undone!.stack);
    expect(step?.change).toEqual({ page: 2, paragraphIndex: 0, text: 'حديث' });
    expect(step?.stack.cursor).toBe(2);
    expect(canRedo(step!.stack)).toBe(false);
  });

  it('walks the whole history in both directions', () => {
    let stack = stackOf(first, second);
    const texts: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const step = undo(stack)!;
      texts.push((step.change as EditChange).text);
      stack = step.stack;
    }
    expect(texts).toEqual(['قديم', 'الأصل']);
    expect(canUndo(stack)).toBe(false);
    expect(undo(stack)).toBeNull();

    const forward: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const step = redo(stack)!;
      forward.push((step.change as EditChange).text);
      stack = step.stack;
    }
    expect(forward).toEqual(['الجديد', 'حديث']);
  });

  it('truncates the redo branch when a new edit follows an undo', () => {
    const undone = undo(stackOf(first, second))!.stack;
    expect(canRedo(undone)).toBe(true);
    const branched: EditEntry = { page: 1, paragraphIndex: 3, before: 'أ', after: 'ب' };
    const next = applyEdit(undone, branched);
    expect(next.entries).toEqual([first, branched]);
    expect(next.cursor).toBe(2);
    expect(canRedo(next)).toBe(false);
  });

  it('undoes a picture or link change in its turn among text edits, by its snapshot', () => {
    const picture: FileEntry = { page: 3, snapshot: 7 };
    const stack = stackOf(first, picture, second);
    // The last change first: the second paragraph, then the picture — never
    // the first paragraph in the picture's place.
    const one = undo(stack)!;
    expect(one.change).toEqual({ page: 2, paragraphIndex: 0, text: 'قديم' });
    const two = undo(one.stack)!;
    expect(two.change).toEqual({ page: 3, snapshot: 7 });
    const three = undo(two.stack)!;
    expect(three.change).toEqual({ page: 0, paragraphIndex: 1, text: 'الأصل' });
    // And forward again through the same snapshot.
    const back = redo(three.stack)!;
    expect(redo(back.stack)!.change).toEqual({ page: 3, snapshot: 7 });
  });

  it('keeps no more than so many file snapshots, dropping the oldest history', () => {
    let stack = stackOf(first);
    for (let k = 0; k < MAX_FILE_ENTRIES + 2; k += 1) stack = applyEdit(stack, { page: 0, snapshot: k });
    expect(snapshotsIn(stack)).toEqual(new Set(Array.from({ length: MAX_FILE_ENTRIES }, (_, k) => k + 2)));
    expect(stack.entries).toHaveLength(MAX_FILE_ENTRIES);
    expect(stack.cursor).toBe(MAX_FILE_ENTRIES);
    // An undone snapshot is dropped with its branch.
    const undone = undo(stack)!.stack;
    const next = applyEdit(undone, second);
    expect(snapshotsIn(next).has(MAX_FILE_ENTRIES + 1)).toBe(false);
  });

  it('keeps per-page and per-paragraph identity across entries', () => {
    const step = undo(stackOf(first))!;
    expect(step.change.page).toBe(first.page);
    expect((step.change as EditChange).paragraphIndex).toBe(first.paragraphIndex);
  });
});
