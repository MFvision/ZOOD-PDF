import { readJson, writeJson } from './preferences';

/** Recent files are remembered by name only (no bytes, no paths). */
const RECENT_KEY = 'warraq.recent';
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
}
