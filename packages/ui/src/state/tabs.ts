/**
 * Document tabs: several PDFs open in one window, as a browser keeps pages.
 * One tab is live — its document is the one the views and tools work on —
 * and the others are parked: the file as it was when the person left the
 * tab (with its changes, unsaved), and the page they were on. Going back to
 * a parked tab opens that file again where they left it. A second PDF
 * double-clicked in Explorer, or opened from the app, becomes a new tab
 * instead of replacing the one open.
 */

export interface DocTab<Save = unknown> {
  key: number;
  name: string;
  /** Where it came from on this device, when known: the same file is not opened twice. */
  path?: string;
  size: number;
  /** The file as it was left; null for the live tab. */
  parked: File | null;
  password?: string;
  /** 1-based. */
  page: number;
  /** Changed since it was opened or last saved. */
  edited: boolean;
  /** A drive's claim on Save, kept while the tab is parked. */
  save: Save | null;
  /**
   * Brought back from the last run (`session.ts`) and not read yet: its file
   * is read from `path` when the tab is first shown, so a start with twelve
   * tabs reads one file, not twelve.
   */
  lazy?: boolean;
  /** The id of its tab group, if it is in one. */
  group?: number;
}

/** Most tabs open at once: each parked one keeps its file in memory. */
export const MAX_TABS = 12;

/** The tab already holding this file: the same path, or, without one, the same name and size. */
export function tabOf<T extends DocTab>(tabs: readonly T[], file: { name: string; size: number; path?: string }): T | undefined {
  return tabs.find((tab) =>
    file.path && tab.path ? samePath(file.path, tab.path) : !file.path && !tab.path && tab.name === file.name && tab.size === file.size,
  );
}

function samePath(a: string, b: string): boolean {
  // Windows paths ignore case; the others do not, but two files differing
  // only in case in one folder are rare enough to be taken as one.
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/** The list with `tab` added just after the live one (at the end when none is). */
export function insertAfter<T extends DocTab>(tabs: readonly T[], live: number | null, tab: T): T[] {
  const at = tabs.findIndex((t) => t.key === live);
  const next = [...tabs];
  next.splice(at < 0 ? next.length : at + 1, 0, tab);
  return next;
}

/** The tab to show when `closing` closes: the one after it, else the one before, else none. */
export function neighbourOf(tabs: readonly DocTab[], closing: number): number | null {
  const at = tabs.findIndex((t) => t.key === closing);
  if (at < 0) return null;
  return tabs[at + 1]?.key ?? tabs[at - 1]?.key ?? null;
}

/* ------------------------------------------------------------------ groups */

/** The colours a tab group may have, as a browser offers them (`session.rs` keeps the same list). */
export const GROUP_COLOURS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'] as const;
export type GroupColour = (typeof GROUP_COLOURS)[number];

/**
 * Tabs kept together under a coloured label, as a browser groups them. A
 * group's tabs always stand side by side; collapsed, only its label shows
 * (and the tab in front, if it is one of them, so the document on screen
 * always has its tab).
 */
export interface TabGroup {
  id: number;
  name: string;
  colour: GroupColour;
  collapsed: boolean;
}

export const MAX_GROUPS = 12;

export function isGroupColour(value: unknown): value is GroupColour {
  return typeof value === 'string' && (GROUP_COLOURS as readonly string[]).includes(value);
}

/** The next colour for a new group: the first one no group has yet, else round again. */
export function nextColour(groups: readonly TabGroup[]): GroupColour {
  const used = new Set(groups.map((group) => group.colour));
  // Grey last: it reads as "no colour".
  const order = [...GROUP_COLOURS.slice(1), GROUP_COLOURS[0]];
  return order.find((colour) => !used.has(colour)) ?? order[groups.length % order.length]!;
}

/** Groups no tab is in any more go. */
export function pruneGroups(tabs: readonly DocTab[], groups: readonly TabGroup[]): TabGroup[] {
  const live = groups.filter((group) => tabs.some((tab) => tab.group === group.id));
  return live.length === groups.length ? (groups as TabGroup[]) : live;
}

/** `index` (in `tabs`) moved out of the middle of a group's run: to the run's end. Its start and end are fine. */
function outsideRuns(tabs: readonly DocTab[], index: number): number {
  const before = tabs[index - 1];
  const after = tabs[index];
  if (before?.group === undefined || before.group !== after?.group) return index;
  let at = index;
  while (tabs[at]?.group === before.group) at += 1;
  return at;
}

function withGroup<T extends DocTab>(tab: T, group: number | null): T {
  const out = { ...tab };
  if (group === null) delete out.group;
  else out.group = group;
  return out;
}

/**
 * Tab `key` taken out and put back at `index` (counted without it), in
 * `group` (or in none, `null`). Whatever the drop, a group's tabs stay side
 * by side: into a group, it lands within that group's tabs; out of one, a
 * place in the middle of another group's tabs becomes the end of them.
 */
export function moveTab<T extends DocTab>(tabs: readonly T[], key: number, index: number, group: number | null): T[] {
  const moving = tabs.find((tab) => tab.key === key);
  if (!moving) return [...tabs];
  const rest = tabs.filter((tab) => tab.key !== key);
  let at = Math.max(0, Math.min(Math.round(index), rest.length));
  const members = group === null ? [] : rest.map((tab, i) => (tab.group === group ? i : -1)).filter((i) => i >= 0);
  if (members.length > 0) at = Math.max(members[0]!, Math.min(at, members[members.length - 1]! + 1));
  else at = outsideRuns(rest, at);
  const next = [...rest];
  next.splice(at, 0, withGroup(moving, group));
  return next;
}

/** The tabs with `keys` put in a new group with `id`, where the first of them is. */
export function groupTabs<T extends DocTab>(
  tabs: readonly T[],
  groups: readonly TabGroup[],
  keys: readonly number[],
  id: number,
  name = '',
): { tabs: T[]; groups: TabGroup[] } {
  const chosen = tabs.filter((tab) => keys.includes(tab.key));
  if (chosen.length === 0 || groups.length >= MAX_GROUPS) return { tabs: [...tabs], groups: [...groups] };
  const group: TabGroup = { id, name, colour: nextColour(pruneGroups(tabs, groups)), collapsed: false };
  const firstAt = tabs.indexOf(chosen[0]!);
  const rest = tabs.filter((tab) => !keys.includes(tab.key));
  // Counted in `rest`: the tabs before the first chosen one that stay.
  const at = outsideRuns(rest, tabs.slice(0, firstAt).filter((tab) => !keys.includes(tab.key)).length);
  const next = [...rest];
  next.splice(at, 0, ...chosen.map((tab) => withGroup(tab, id)));
  return { tabs: next, groups: pruneGroups(next, [...groups, group]) };
}

/** Tab `key` put in group `id`, after the group's last tab. */
export function addToGroup<T extends DocTab>(tabs: readonly T[], groups: readonly TabGroup[], key: number, id: number): { tabs: T[]; groups: TabGroup[] } {
  if (!groups.some((group) => group.id === id)) return { tabs: [...tabs], groups: [...groups] };
  const rest = tabs.filter((tab) => tab.key !== key);
  const last = rest.map((tab, i) => (tab.group === id ? i : -1)).filter((i) => i >= 0).pop();
  const next = moveTab(tabs, key, last === undefined ? rest.length : last + 1, id);
  return { tabs: next, groups: pruneGroups(next, groups) };
}

/** Tab `key` out of its group, just after the group's tabs (so the group stays in one piece). */
export function ungroupTab<T extends DocTab>(tabs: readonly T[], groups: readonly TabGroup[], key: number): { tabs: T[]; groups: TabGroup[] } {
  const tab = tabs.find((one) => one.key === key);
  if (tab?.group === undefined) return { tabs: [...tabs], groups: [...groups] };
  const rest = tabs.filter((one) => one.key !== key);
  const lastOfGroup = rest.map((one, i) => (one.group === tab.group ? i : -1)).filter((i) => i >= 0).pop();
  const at = lastOfGroup === undefined ? tabs.indexOf(tab) : lastOfGroup + 1;
  // moveTab would put a place inside the run at its end anyway; this says so.
  const next = moveTab(tabs, key, at, null);
  return { tabs: next, groups: pruneGroups(next, groups) };
}

/** Every tab of group `id` out of it, where they are; the group goes. */
export function ungroupAll<T extends DocTab>(tabs: readonly T[], groups: readonly TabGroup[], id: number): { tabs: T[]; groups: TabGroup[] } {
  const next = tabs.map((tab) => (tab.group === id ? withGroup(tab, null) : tab));
  return { tabs: next, groups: groups.filter((group) => group.id !== id) };
}

/** What the tab bar draws, in order: a group's label before its first tab, then each tab unless its group is collapsed. */
export type StripItem<T> = { kind: 'group'; group: TabGroup; count: number } | { kind: 'tab'; tab: T; group: TabGroup | null };

export function stripItems<T extends DocTab>(tabs: readonly T[], groups: readonly TabGroup[], live: number | null): StripItem<T>[] {
  const items: StripItem<T>[] = [];
  let open: number | undefined;
  for (const tab of tabs) {
    const group = tab.group === undefined ? null : (groups.find((one) => one.id === tab.group) ?? null);
    if (group && group.id !== open) {
      items.push({ kind: 'group', group, count: tabs.filter((one) => one.group === group.id).length });
    }
    open = group?.id;
    if (!group?.collapsed || tab.key === live) items.push({ kind: 'tab', tab, group });
  }
  return items;
}
