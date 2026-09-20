import type { LibraryKind } from './kinds';
import type { SearchFilters } from './ops';

/**
 * What the filter controls hold, and the filters the core is asked for.
 *
 * Kept apart from the panel so the rules are testable: an empty box is not a
 * filter, a date the person is still typing is not sent, and a search with
 * nothing set asks for no filters at all rather than for empty lists.
 */

export interface FilterState {
  kinds: LibraryKind[];
  folders: string[];
  tags: string[];
  /** `YYYY-MM-DD`, as a date field gives it. */
  from: string;
  to: string;
  scannedOnly: boolean;
}

export const noFilters = (): FilterState => ({ kinds: [], folders: [], tags: [], from: '', to: '', scannedOnly: false });

const isDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** How many filters are set, for the badge on the Filters button. */
export function filterCount(state: FilterState): number {
  return (
    state.kinds.length +
    state.folders.length +
    state.tags.length +
    (isDate(state.from) ? 1 : 0) +
    (isDate(state.to) ? 1 : 0) +
    (state.scannedOnly ? 1 : 0)
  );
}

/** The filters for `library.search`, or nothing when none is set. */
export function toFilters(state: FilterState): SearchFilters | undefined {
  if (filterCount(state) === 0) return undefined;
  const filters: SearchFilters = {};
  if (state.kinds.length > 0) filters.kinds = [...state.kinds];
  if (state.folders.length > 0) filters.folders = [...state.folders];
  if (state.tags.length > 0) filters.tags = [...state.tags];
  if (isDate(state.from)) filters.from = state.from;
  if (isDate(state.to)) filters.to = state.to;
  if (state.scannedOnly) filters.scannedOnly = true;
  return filters;
}

/** Turns one item of a filter on or off. */
export function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((one) => one !== item) : [...list, item];
}

/** The range the person typed the wrong way round: shown, not sent. */
export function badRange(state: FilterState): boolean {
  return isDate(state.from) && isDate(state.to) && state.from > state.to;
}
