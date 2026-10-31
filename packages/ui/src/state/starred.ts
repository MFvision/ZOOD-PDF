import { useSyncExternalStore } from 'react';
import { readJson, writeJson } from './preferences';

/**
 * Starred documents: a flag kept on this device, and nowhere else, for the
 * files a person wants at hand. A star names a document one of two ways —
 * a recent file by its name (the home screen keeps no more of it), or a
 * Library document by the key its index holds it under — so the Starred
 * view can open the one and ask for the other again.
 */
export interface StarredItem {
  /** `recent:<name>` or `library:<key>`. */
  id: string;
  name: string;
  source: 'recent' | 'library';
}

const STARRED_KEY = 'warraq.starred';
const LIMIT = 200;

export const starId = (source: StarredItem['source'], key: string): string => `${source}:${key}`;

const isItem = (value: unknown): value is StarredItem => {
  const item = value as Partial<StarredItem> | null;
  return (
    !!item &&
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    (item.source === 'recent' || item.source === 'library') &&
    item.id.startsWith(`${item.source}:`)
  );
};

let cache: StarredItem[] | null = null;
/** What storage held when `cache` was read: another tab of the app may have starred since. */
let cacheRaw: string | null | undefined;
const listeners = new Set<() => void>();

function storedRaw(): string | null | undefined {
  try {
    return globalThis.localStorage?.getItem(STARRED_KEY) ?? null;
  } catch {
    return undefined;
  }
}

export function readStarred(): StarredItem[] {
  const raw = storedRaw();
  if (cache && (raw === undefined || raw === cacheRaw)) return cache;
  const stored = readJson<unknown>(STARRED_KEY, []);
  cache = Array.isArray(stored) ? stored.filter(isItem).slice(0, LIMIT) : [];
  cacheRaw = raw;
  return cache;
}

function write(next: StarredItem[]): void {
  cache = next;
  writeJson(STARRED_KEY, next);
  cacheRaw = storedRaw();
  for (const listener of listeners) listener();
}

// Another tab of the app starred or unstarred: this one shows it too.
globalThis.addEventListener?.('storage', (event: StorageEvent) => {
  if (event.key !== STARRED_KEY && event.key !== null) return;
  for (const listener of listeners) listener();
});

export function isStarred(id: string): boolean {
  return readStarred().some((item) => item.id === id);
}

/** Stars `item`, or takes its star off if it has one. Returns whether it is starred now. */
export function toggleStarred(item: StarredItem): boolean {
  const current = readStarred();
  if (current.some((one) => one.id === item.id)) {
    write(current.filter((one) => one.id !== item.id));
    return false;
  }
  write([item, ...current].slice(0, LIMIT));
  return true;
}

/** Takes a star off, whether or not it was there. */
export function unstar(id: string): void {
  const current = readStarred();
  if (current.some((one) => one.id === id)) write(current.filter((one) => one.id !== id));
}

/** Forgets every star, and reads the device again next time (the tests). */
export function clearStarred(): void {
  write([]);
  cache = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The starred list, live: every star and unstar anywhere in the app is seen here. */
export function useStarred(): StarredItem[] {
  return useSyncExternalStore(subscribe, readStarred, readStarred);
}
