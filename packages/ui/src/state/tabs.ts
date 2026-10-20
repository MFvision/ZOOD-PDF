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
