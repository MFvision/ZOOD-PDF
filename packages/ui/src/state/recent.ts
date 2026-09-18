import { readJson, writeJson } from './preferences';

/**
 * Recent files are remembered by name (no bytes, no paths), with a small
 * picture of the first page for the home screen's grid — kept on this device
 * only, never for a file that needed a password, and forgotten with the list.
 */
const RECENT_KEY = 'warraq.recent';
const THUMBS_KEY = 'warraq.recentThumbs';
export const RECENT_LIMIT = 10;

export function readRecent(): string[] {
  const list = readJson<unknown>(RECENT_KEY, []);
  return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
}

export function addRecent(name: string): string[] {
  const next = [name, ...readRecent().filter((n) => n !== name)].slice(0, RECENT_LIMIT);
  writeJson(RECENT_KEY, next);
  return next;
}

export function clearRecent(): void {
  writeJson(RECENT_KEY, []);
  writeJson(THUMBS_KEY, {});
}

/** Only a JPEG data URL is ever shown: anything else in storage is ignored. */
const isThumbnail = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('data:image/jpeg;base64,') && value.length < 200_000;

/** The first-page pictures of the recent files that have one, by name. */
export function readRecentThumbnails(): Record<string, string> {
  const stored = readJson<unknown>(THUMBS_KEY, {});
  if (!stored || typeof stored !== 'object') return {};
  const names = new Set(readRecent());
  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).filter(
      (entry): entry is [string, string] => names.has(entry[0]) && isThumbnail(entry[1]),
    ),
  );
}

/** Keeps the picture for `name`, and drops those of files no longer in the list. */
export function saveRecentThumbnail(name: string, dataUrl: string): void {
  if (!isThumbnail(dataUrl)) return;
  writeJson(THUMBS_KEY, { ...readRecentThumbnails(), [name]: dataUrl });
}
