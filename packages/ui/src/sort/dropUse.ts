import { readJson, writeJson } from '../state/preferences';
import { DROP_ITEMS } from '../state/settings';
import type { DropItem } from '../state/settings';

/**
 * How often each target of the drop zone's panel was let go on, kept on
 * this computer only, for "Most used first" (Settings › Quick tools ›
 * Drop panel). Nothing but the counts is kept.
 */

const KEY = 'zood.dropUse';
/** Counts stop here, so a long-used one does not lock the order for ever. */
const MOST = 999;

export function readUse(): Record<string, number> {
  const raw = readJson<unknown>(KEY, {});
  const use: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return use;
  for (const id of DROP_ITEMS) {
    const count = (raw as Record<string, unknown>)[id];
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) use[id] = Math.min(MOST, Math.floor(count));
  }
  return use;
}

/** One more use of `target` (`tile:web`, `format:pdf`, `more:ask` …); anything else is ignored. */
export function countUse(target: string): void {
  if (!(DROP_ITEMS as readonly string[]).includes(target)) return;
  const use = readUse();
  use[target as DropItem] = Math.min(MOST, (use[target] ?? 0) + 1);
  writeJson(KEY, use);
}

export function clearUse(): void {
  writeJson(KEY, {});
}
