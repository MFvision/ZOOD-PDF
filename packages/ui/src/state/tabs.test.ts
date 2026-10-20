import { describe, expect, it } from 'vitest';
import { insertAfter, neighbourOf, tabOf } from './tabs';
import type { DocTab } from './tabs';

const tab = (key: number, patch: Partial<DocTab> = {}): DocTab => ({
  key,
  name: `${key}.pdf`,
  size: key * 10,
  parked: null,
  page: 1,
  edited: false,
  save: null,
  ...patch,
});

describe('tabs', () => {
  it('finds the same file by path, ignoring case and slashes', () => {
    const tabs = [tab(1, { path: 'C:\\Docs\\A.pdf' }), tab(2)];
    expect(tabOf(tabs, { name: 'a.pdf', size: 5, path: 'c:/docs/a.pdf' })?.key).toBe(1);
    expect(tabOf(tabs, { name: 'b.pdf', size: 5, path: 'c:/docs/b.pdf' })).toBeUndefined();
  });

  it('finds a file without a path by name and size only among tabs without one', () => {
    const tabs = [tab(1, { path: '/x/2.pdf', name: '2.pdf', size: 20 }), tab(2)];
    expect(tabOf(tabs, { name: '2.pdf', size: 20 })?.key).toBe(2);
    expect(tabOf(tabs, { name: '2.pdf', size: 21 })).toBeUndefined();
  });

  it('inserts after the live tab, or at the end', () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(insertAfter(tabs, 1, tab(9)).map((t) => t.key)).toEqual([1, 9, 2, 3]);
    expect(insertAfter(tabs, null, tab(9)).map((t) => t.key)).toEqual([1, 2, 3, 9]);
  });

  it('picks the next tab, then the previous, when one closes', () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(neighbourOf(tabs, 2)).toBe(3);
    expect(neighbourOf(tabs, 3)).toBe(2);
    expect(neighbourOf([tab(1)], 1)).toBeNull();
    expect(neighbourOf(tabs, 7)).toBeNull();
  });
});
