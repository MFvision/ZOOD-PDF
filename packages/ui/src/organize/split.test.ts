import { describe, expect, it } from 'vitest';
import { describeParts, splitAt, splitEvery } from './split';

describe('Split into files', () => {
  it('cuts every so many pages, the last part shorter', () => {
    expect(splitEvery(7, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(splitEvery(3, 1)).toEqual([[0], [1], [2]]);
    expect(splitEvery(3, 5), 'more than there are: one part').toEqual([[0, 1, 2]]);
    expect(splitEvery(4, 0), 'never a part of no pages').toEqual([[0], [1], [2], [3]]);
  });

  it('starts a new part at each chosen page, in page order', () => {
    expect(splitAt(8, [3, 6])).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7],
    ]);
    expect(splitAt(8, [6, 3, 3])).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7],
    ]);
    expect(splitAt(8, [0, 3]), 'the first page begins a part anyway').toEqual([
      [0, 1, 2],
      [3, 4, 5, 6, 7],
    ]);
    expect(splitAt(3, [])).toEqual([[0, 1, 2]]);
  });

  it('every page is in exactly one part', () => {
    for (const parts of [splitEvery(10, 3), splitAt(10, [2, 5, 9])]) {
      expect(parts.flat()).toEqual(Array.from({ length: 10 }, (_, k) => k));
    }
  });

  it('describes the parts as a person counts pages', () => {
    expect(describeParts(splitEvery(7, 3))).toBe('1–3, 4–6, 7');
  });
});
