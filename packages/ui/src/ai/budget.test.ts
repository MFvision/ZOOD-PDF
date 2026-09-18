import { describe, expect, it } from 'vitest';
import { budgetFor, formatPages, pageRange, takeWithinBudget } from './budget';

/** Four pages of known length, and a record of which were read. */
function book(lengths: number[]) {
  const reads: number[] = [];
  const read = async (page: number) => {
    reads.push(page);
    return 'x'.repeat(lengths[page - 1] ?? 0);
  };
  return { reads, read };
}

describe('the page budget', () => {
  it('sends every page when they all fit', async () => {
    const { read } = book([40, 30, 50, 10]);
    const budgeted = await takeWithinBudget([1, 2, 3, 4], 1000, read);
    expect(budgeted.sent.map((page) => page.page)).toEqual([1, 2, 3, 4]);
    expect(budgeted.left).toEqual([]);
    expect(budgeted.characters).toBe(130);
  });

  it('sends whole pages up to the budget, lists the rest, and never reads past the cut', async () => {
    const { read, reads } = book([40, 30, 50, 10]);
    const budgeted = await takeWithinBudget([1, 2, 3, 4], 80, read);
    expect(budgeted.sent.map((page) => page.page)).toEqual([1, 2]);
    expect(budgeted.sent[0]?.text).toHaveLength(40);
    // Page 4 would fit on its own, but a hole in the middle would be harder to explain than a cut.
    expect(budgeted.left).toEqual([3, 4]);
    expect(budgeted.characters).toBe(70);
    expect(reads).toEqual([1, 2, 3]);
  });

  it('fills the budget exactly', async () => {
    const { read } = book([40, 30, 50, 10]);
    expect((await takeWithinBudget([1, 2, 3], 120, read)).left).toEqual([]);
    expect((await takeWithinBudget([1, 2, 3], 119, read)).left).toEqual([3]);
  });

  it('never cuts a page: one over the budget on its own is left out with all after it', async () => {
    const { read } = book([40, 30]);
    const budgeted = await takeWithinBudget([1, 2], 35, read);
    expect(budgeted.sent).toEqual([]);
    expect(budgeted.left).toEqual([1, 2]);
    expect(budgeted.characters).toBe(0);
  });

  it('keeps the order it was given: a range that starts mid-document', async () => {
    const { read } = book([5, 5, 5, 5]);
    const budgeted = await takeWithinBudget([3, 4], 100, read);
    expect(budgeted.sent.map((page) => page.page)).toEqual([3, 4]);
  });

  it('is generous for Claude and modest for a model on a laptop', () => {
    expect(budgetFor('claude', 'summarize')).toBe(150_000);
    expect(budgetFor('claude', 'ask')).toBe(150_000);
    expect(budgetFor('claude', 'translate')).toBeLessThan(budgetFor('claude', 'summarize'));
    expect(budgetFor('local', 'summarize')).toBeLessThan(budgetFor('claude', 'summarize'));
    expect(budgetFor('local', 'translate')).toBeLessThan(budgetFor('local', 'summarize'));
  });
});

describe('page lists', () => {
  it('are written as runs', () => {
    expect(formatPages([1, 2, 3, 5, 7, 8])).toBe('1–3, 5, 7–8');
    expect(formatPages([4])).toBe('4');
    expect(formatPages([])).toBe('');
  });

  it('are ranges kept inside the document, either way round', () => {
    expect(pageRange(1, 3, 5)).toEqual([1, 2, 3]);
    expect(pageRange(3, 1, 5)).toEqual([1, 2, 3]);
    expect(pageRange(0, 9, 3)).toEqual([1, 2, 3]);
    expect(pageRange(7, 9, 3)).toEqual([3]);
    expect(pageRange(2, 2, 3)).toEqual([2]);
    expect(pageRange(1, 1, 0)).toEqual([]);
  });
});
