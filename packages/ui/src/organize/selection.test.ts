import { describe, expect, it } from 'vitest';
import {
  NO_SELECTION,
  clampSelection,
  orderMovingTo,
  orderStepping,
  positionsAfter,
  select,
  selectAll,
  selectionAfterDelete,
} from './selection';

describe('selecting pages', () => {
  it('a click selects one page, Cmd/Ctrl-click adds or removes one', () => {
    let s = select(NO_SELECTION, 3, 'only');
    expect(s).toEqual({ pages: [3], anchor: 3 });
    s = select(s, 1, 'toggle');
    expect(s.pages).toEqual([1, 3]);
    s = select(s, 3, 'toggle');
    expect(s.pages).toEqual([1]);
  });

  it('Shift-click selects the range from the anchor, in either direction', () => {
    const s = select(NO_SELECTION, 5, 'only');
    expect(select(s, 2, 'range').pages).toEqual([2, 3, 4, 5]);
    expect(select(s, 7, 'range').pages).toEqual([5, 6, 7]);
    expect(select(NO_SELECTION, 4, 'range').pages).toEqual([4]);
  });

  it('select all, and dropping pages that are gone', () => {
    expect(selectAll(3).pages).toEqual([0, 1, 2]);
    expect(clampSelection({ pages: [1, 4, 6], anchor: 6 }, 5)).toEqual({ pages: [1, 4], anchor: 1 });
  });
});

describe('the order a move asks for', () => {
  it('moves the selection, in its order, before a target page', () => {
    expect(orderMovingTo(5, [3, 4], 1)).toEqual([0, 3, 4, 1, 2]);
    expect(orderMovingTo(5, [0], 5)).toEqual([1, 2, 3, 4, 0]);
    expect(orderMovingTo(5, [4, 1], 0)).toEqual([1, 4, 0, 2, 3]);
  });

  it('is null when nothing would move', () => {
    expect(orderMovingTo(5, [1, 2], 1)).toBeNull();
    expect(orderMovingTo(5, [1, 2], 3)).toBeNull();
    expect(orderMovingTo(5, [], 0)).toBeNull();
  });

  it('steps the selection one place as a block, and stops at the edges', () => {
    expect(orderStepping(5, [2], -1)).toEqual([0, 2, 1, 3, 4]);
    expect(orderStepping(5, [2], 1)).toEqual([0, 1, 3, 2, 4]);
    expect(orderStepping(5, [1, 2], 1)).toEqual([0, 3, 1, 2, 4]);
    expect(orderStepping(5, [3, 4], -1)).toEqual([0, 1, 3, 4, 2]);
    expect(orderStepping(5, [0], -1)).toBeNull();
    expect(orderStepping(5, [4], 1)).toBeNull();
  });

  it('knows where the moved pages end up', () => {
    const order = orderMovingTo(5, [3, 4], 1)!;
    expect(positionsAfter(order, [3, 4])).toEqual([1, 2]);
  });

  it('after a delete, selects the page that took the first one’s place', () => {
    expect(selectionAfterDelete(5, [1, 2])).toEqual({ pages: [1], anchor: 1 });
    expect(selectionAfterDelete(5, [4])).toEqual({ pages: [3], anchor: 3 });
    expect(selectionAfterDelete(2, [0, 1])).toEqual(NO_SELECTION);
  });
});
