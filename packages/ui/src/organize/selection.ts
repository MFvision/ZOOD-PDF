/**
 * Page selection and reordering for Organize pages, as plain functions: which
 * pages a click selects, and the new page order a move asks the core for
 * (`pages.reorder` takes `order[k]` = the current index of the page that
 * becomes page `k`).
 */

export type SelectHow = 'only' | 'toggle' | 'range';

export interface Selection {
  /** 0-based, ascending, no repeats. */
  pages: number[];
  /** Where a Shift-click range starts. */
  anchor: number | null;
}

export const NO_SELECTION: Selection = { pages: [], anchor: null };

const sorted = (pages: Iterable<number>) => [...new Set(pages)].sort((a, b) => a - b);

/** A click (`only`), a Cmd/Ctrl-click (`toggle`) or a Shift-click (`range`) on `index`. */
export function select(current: Selection, index: number, how: SelectHow): Selection {
  if (how === 'toggle') {
    const pages = current.pages.includes(index) ? current.pages.filter((p) => p !== index) : sorted([...current.pages, index]);
    return { pages, anchor: index };
  }
  if (how === 'range' && current.anchor !== null) {
    const [from, to] = current.anchor < index ? [current.anchor, index] : [index, current.anchor];
    return { pages: Array.from({ length: to - from + 1 }, (_, k) => from + k), anchor: current.anchor };
  }
  return { pages: [index], anchor: index };
}

export function selectAll(count: number): Selection {
  return { pages: Array.from({ length: count }, (_, k) => k), anchor: 0 };
}

/** Drops pages that no longer exist. */
export function clampSelection(current: Selection, count: number): Selection {
  const pages = current.pages.filter((p) => p < count);
  const anchor = current.anchor !== null && current.anchor < count ? current.anchor : (pages[0] ?? null);
  return { pages, anchor };
}

/**
 * The order that puts the selected pages, in their order, just before the page
 * now at `target` (`count` puts them last). Null when nothing would move.
 */
export function orderMovingTo(count: number, selected: readonly number[], target: number): number[] | null {
  const chosen = sorted(selected).filter((p) => p >= 0 && p < count);
  if (chosen.length === 0) return null;
  const moving = new Set(chosen);
  const rest = Array.from({ length: count }, (_, k) => k).filter((p) => !moving.has(p));
  const at = rest.filter((p) => p < target).length;
  const order = [...rest.slice(0, at), ...chosen, ...rest.slice(at)];
  return order.every((p, k) => p === k) ? null : order;
}

/**
 * Moves the selected pages one place earlier (`-1`) or later (`1`) as a block:
 * the block's first page swaps with the page before it, or its last with the
 * page after. Null at the edge.
 */
export function orderStepping(count: number, selected: readonly number[], step: -1 | 1): number[] | null {
  const chosen = sorted(selected).filter((p) => p >= 0 && p < count);
  if (chosen.length === 0) return null;
  const first = chosen[0]!;
  const last = chosen[chosen.length - 1]!;
  if (step === -1) return first === 0 ? null : orderMovingTo(count, chosen, first - 1);
  if (last === count - 1) return null;
  // Before the page that follows the one after the block.
  const after = Array.from({ length: count }, (_, k) => k).filter((p) => p > last && !chosen.includes(p));
  return orderMovingTo(count, chosen, (after[1] ?? count));
}

/** Where each of `selected` ends up once `order` is applied. */
export function positionsAfter(order: readonly number[], selected: readonly number[]): number[] {
  return sorted(selected.map((p) => order.indexOf(p)).filter((k) => k >= 0));
}

/** After deleting `deleted`, the page that took the first deleted one's place. */
export function selectionAfterDelete(count: number, deleted: readonly number[]): Selection {
  const first = Math.min(...deleted);
  const left = count - new Set(deleted).size;
  if (left <= 0 || !Number.isFinite(first)) return NO_SELECTION;
  const index = Math.min(first, left - 1);
  return { pages: [index], anchor: index };
}
