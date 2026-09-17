import { describe, expect, it } from 'vitest';
import { applyEdit, canRedo, canUndo, EMPTY_EDIT_STACK, redo, undo } from './editStack';
import type { EditEntry, EditStack } from './editStack';

const first: EditEntry = { page: 0, paragraphIndex: 1, before: 'الأصل', after: 'الجديد' };
const second: EditEntry = { page: 2, paragraphIndex: 0, before: 'قديم', after: 'حديث' };

function stackOf(...entries: EditEntry[]): EditStack {
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
      texts.push(step.change.text);
      stack = step.stack;
    }
    expect(texts).toEqual(['قديم', 'الأصل']);
    expect(canUndo(stack)).toBe(false);
    expect(undo(stack)).toBeNull();

    const forward: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const step = redo(stack)!;
      forward.push(step.change.text);
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

  it('keeps per-page and per-paragraph identity across entries', () => {
    const step = undo(stackOf(first))!;
    expect(step.change.page).toBe(first.page);
    expect(step.change.paragraphIndex).toBe(first.paragraphIndex);
  });
});
