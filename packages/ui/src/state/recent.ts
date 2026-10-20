import { readJson, writeJson } from './preferences';
import { getSettings } from './settings';

/**
 * Recent files are remembered by name (no bytes, no paths), with a small
 * picture of the first page for the home screen's grid — kept on this device
 * only, never for a protected file or one being redacted, forgotten when the
 * file is saved and with the list (`home/recentPicture.ts` says when).
 */
const RECENT_KEY = 'warraq.recent';
const THUMBS_KEY = 'warraq.recentThumbs';
const DATES_KEY = 'warraq.recentDates';
const SIZES_KEY = 'zood.recentSizes';

export function readRecent(): string[] {
  const list = readJson<unknown>(RECENT_KEY, []);
  return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
}

export function addRecent(name: string, now: number = Date.now(), size?: number): string[] {
  const { keepRecent, recentLimit } = getSettings();
  // Settings › History: with the list off, nothing about the file is kept.
  if (!keepRecent) return readRecent();
  const next = [name, ...readRecent().filter((n) => n !== name)].slice(0, recentLimit);
  writeJson(RECENT_KEY, next);
  writeJson(DATES_KEY, { ...readRecentDates(next), [name]: now });
  if (size !== undefined && Number.isFinite(size) && size >= 0) writeJson(SIZES_KEY, { ...readRecentSizes(next), [name]: size });
  return next;
}

/** How large each recent file was when last opened, in bytes, by name (the Workbench home's table). */
export function readRecentSizes(names: readonly string[] = readRecent()): Record<string, number> {
  const stored = readJson<unknown>(SIZES_KEY, {});
  if (!stored || typeof stored !== 'object') return {};
  const listed = new Set(names);
  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).filter(
      (entry): entry is [string, number] => listed.has(entry[0]) && typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
    ),
  );
}

/** Takes one file off the list, with its picture and its date; the file itself is not touched. */
export function removeRecent(name: string): string[] {
  const next = readRecent().filter((n) => n !== name);
  writeJson(RECENT_KEY, next);
  forgetRecentThumbnail(name);
  writeJson(DATES_KEY, readRecentDates(next));
  writeJson(SIZES_KEY, readRecentSizes(next));
  return next;
}

export function clearRecent(): void {
  writeJson(RECENT_KEY, []);
  writeJson(THUMBS_KEY, {});
  writeJson(DATES_KEY, {});
  writeJson(SIZES_KEY, {});
}

/**
 * When each recent file was last opened, in milliseconds since the epoch, by
 * name — only for files still on the list, and only sound numbers: a file
 * listed before dates were kept simply has none.
 */
export function readRecentDates(names: readonly string[] = readRecent()): Record<string, number> {
  const stored = readJson<unknown>(DATES_KEY, {});
  if (!stored || typeof stored !== 'object') return {};
  const listed = new Set(names);
  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).filter(
      (entry): entry is [string, number] =>
        listed.has(entry[0]) && typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0,
    ),
  );
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

/** Forgets the picture of `name` (and those of files no longer in the list); the name stays. */
export function forgetRecentThumbnail(name: string): void {
  const { [name]: _forgotten, ...rest } = readRecentThumbnails();
  writeJson(THUMBS_KEY, rest);
}
