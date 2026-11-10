import { describe, expect, it } from 'vitest';
import { addToGroup, groupTabs, insertAfter, moveTab, neighbourOf, nextColour, pruneGroups, stripItems, tabOf, ungroupAll, ungroupTab } from './tabs';
import type { DocTab, TabGroup } from './tabs';

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

describe('tab groups', () => {
  const g = (id: number, patch: Partial<TabGroup> = {}): TabGroup => ({ id, name: '', colour: 'blue', collapsed: false, ...patch });
  const keys = (tabs: readonly DocTab[]) => tabs.map((t) => `${t.key}${t.group ? `g${t.group}` : ''}`).join(' ');

  it('groups tabs side by side where the first of them is', () => {
    const tabs = [tab(1), tab(2), tab(3), tab(4)];
    const out = groupTabs(tabs, [], [2, 4], 9);
    expect(keys(out.tabs)).toBe('1 2g9 4g9 3');
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.colour).not.toBe('grey');
  });

  it('never starts a new group inside another', () => {
    const tabs = [tab(1, { group: 5 }), tab(2, { group: 5 }), tab(3)];
    const out = groupTabs(tabs, [g(5)], [2], 9);
    expect(keys(out.tabs)).toBe('1g5 2g9 3');
    const inside = groupTabs([tab(1, { group: 5 }), tab(2, { group: 5 }), tab(3, { group: 5 }), tab(4)], [g(5)], [4], 9);
    expect(keys(inside.tabs)).toBe('1g5 2g5 3g5 4g9');
  });

  it('picks a colour no group has yet', () => {
    expect(nextColour([g(1, { colour: 'blue' })])).toBe('red');
    expect(nextColour([])).toBe('blue');
  });

  it('moves a tab into a group, within its run', () => {
    const tabs = [tab(1), tab(2, { group: 5 }), tab(3, { group: 5 }), tab(4)];
    expect(keys(moveTab(tabs, 1, 3, 5))).toBe('2g5 3g5 1g5 4');
    expect(keys(moveTab(tabs, 4, 0, 5))).toBe('1 4g5 2g5 3g5');
  });

  it('moves a tab out of a group to its end, never splitting another', () => {
    const tabs = [tab(1, { group: 5 }), tab(2, { group: 5 }), tab(3, { group: 5 }), tab(4)];
    expect(keys(moveTab(tabs, 4, 1, null))).toBe('1g5 2g5 3g5 4');
    const out = ungroupTab(tabs, [g(5)], 1);
    expect(keys(out.tabs)).toBe('2g5 3g5 1 4');
    expect(out.groups).toHaveLength(1);
  });

  it('drops a group once its last tab leaves', () => {
    const out = ungroupTab([tab(1, { group: 5 }), tab(2)], [g(5)], 1);
    expect(out.groups).toEqual([]);
    expect(pruneGroups([tab(1)], [g(5)])).toEqual([]);
  });

  it('adds to a group after its last tab', () => {
    const tabs = [tab(1, { group: 5 }), tab(2), tab(3, { group: 5 })];
    expect(keys(addToGroup(tabs, [g(5)], 2, 5).tabs)).toBe('1g5 3g5 2g5');
  });

  it('ungroups every tab and keeps their places', () => {
    const out = ungroupAll([tab(1, { group: 5 }), tab(2, { group: 5 })], [g(5)], 5);
    expect(keys(out.tabs)).toBe('1 2');
    expect(out.groups).toEqual([]);
  });

  it('draws a label before each group, and hides a collapsed group but the live tab', () => {
    const tabs = [tab(1), tab(2, { group: 5 }), tab(3, { group: 5 })];
    const open = stripItems(tabs, [g(5)], 1).map((item) => (item.kind === 'group' ? `[${item.count}]` : item.tab.key));
    expect(open).toEqual([1, '[2]', 2, 3]);
    const shut = stripItems(tabs, [g(5, { collapsed: true })], 3).map((item) => (item.kind === 'group' ? `[${item.count}]` : item.tab.key));
    expect(shut).toEqual([1, '[2]', 3]);
  });
});
