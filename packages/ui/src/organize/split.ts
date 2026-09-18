/**
 * Split into files, as plain functions: which pages go in each new file.
 * Pages are 0-based; every part keeps the document's order, and together the
 * parts hold every page once.
 */

/** Parts of `size` pages each, the last one shorter when they do not divide evenly. */
export function splitEvery(count: number, size: number): number[][] {
  const step = Math.max(1, Math.floor(size));
  const parts: number[][] = [];
  for (let start = 0; start < count; start += step) {
    parts.push(Array.from({ length: Math.min(step, count - start) }, (_, k) => start + k));
  }
  return parts;
}

/** A new part at each of `starts` — the first page always begins one, so it adds nothing. */
export function splitAt(count: number, starts: readonly number[]): number[][] {
  const cuts = [...new Set(starts)].filter((p) => p > 0 && p < count).sort((a, b) => a - b);
  const bounds = [0, ...cuts, count];
  return bounds
    .slice(0, -1)
    .map((from, k) => Array.from({ length: bounds[k + 1]! - from }, (_, j) => from + j));
}

/** How the parts read to a person: "1–3, 4–6, 7", one-based. */
export function describeParts(parts: readonly number[][]): string {
  return parts
    .map((part) => {
      const first = part[0]! + 1;
      const last = part[part.length - 1]! + 1;
      return first === last ? `${first}` : `${first}–${last}`;
    })
    .join(', ');
}
