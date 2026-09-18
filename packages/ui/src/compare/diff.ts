/**
 * A word diff: the shortest edit script between two sequences of words, by
 * E. W. Myers, "An O(ND) Difference Algorithm and Its Variations" (1986) —
 * the greedy search forward from the start, keeping each step's furthest
 * points so the script can be walked back from the end.
 *
 * Words are compared by key (see `normalize.ts`); the caller keeps the words
 * themselves and reads them back through the index ranges returned here.
 */

export interface Segment {
  /** `same`: the words match. `changed`: `older` was replaced by `newer`; either may be empty. */
  kind: 'same' | 'changed';
  /** The segment's words in the older sequence: `[start, end)`. */
  older: [number, number];
  /** The segment's words in the newer sequence: `[start, end)`. */
  newer: [number, number];
}

/**
 * Edits beyond which a stretch is shown as replaced as a whole. Walking the
 * script back keeps every step's furthest points, which is D² numbers for D
 * edits; 2,000 edits is 16 MB at most, and two stretches that far apart share
 * too little for a word-by-word account to read as anything but noise.
 */
export const MAX_EDITS = 2000;

const SAME = 0;
const DELETE = 1;
const INSERT = 2;

/**
 * The moves from (0, 0) to (n, m) through the edit graph of `a` and `b`, or
 * null past `maxEdits`. `trace[d]` holds the furthest x reached on diagonals
 * -(d-1)…d-1 before step d, which is all walking back needs.
 */
function shortestPath(a: Int32Array, b: Int32Array, maxEdits: number): Uint8Array | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  // v[offset + k]: the furthest x on diagonal k = x - y. Step 0 starts from v[1] = 0.
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d + 1, offset + d));
    for (let k = -d; k <= d; k += 2) {
      // From diagonal k + 1 by a step down, or from k - 1 by a step right: whichever got further.
      const below = v[offset + k - 1] ?? 0;
      const above = v[offset + k + 1] ?? 0;
      let x = k === -d || (k !== d && below < above) ? above : below + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return walkBack(trace, d, n, m);
    }
  }
  return null;
}

/** The moves of a `d`-edit path to (n, m), start to end. */
function walkBack(trace: readonly Int32Array[], edits: number, n: number, m: number): Uint8Array {
  const moves = new Uint8Array(n + m);
  let at = moves.length;
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d -= 1) {
    const before = trace[d] ?? new Int32Array(0);
    const furthest = (k: number) => before[k + d - 1] ?? 0;
    const k = x - y;
    const from = k === -d || (k !== d && furthest(k - 1) < furthest(k + 1)) ? k + 1 : k - 1;
    const fromX = furthest(from);
    const fromY = fromX - from;
    while (x > fromX && y > fromY) {
      moves[--at] = SAME;
      x -= 1;
      y -= 1;
    }
    // Down (x unchanged) takes a word from `b`; right takes one from `a`.
    moves[--at] = x === fromX ? INSERT : DELETE;
    x = fromX;
    y = fromY;
  }
  while (x > 0 && y > 0) {
    moves[--at] = SAME;
    x -= 1;
    y -= 1;
  }
  return moves.subarray(at);
}

function append(segments: Segment[], kind: Segment['kind'], older: number, newer: number, olderEnd: number, newerEnd: number) {
  if (olderEnd === older && newerEnd === newer) return;
  const last = segments.at(-1);
  if (last && last.kind === kind) {
    last.older[1] = olderEnd;
    last.newer[1] = newerEnd;
  } else {
    segments.push({ kind, older: [older, olderEnd], newer: [newer, newerEnd] });
  }
}

/** Words on the longer side of a change. */
function weight(segment: Segment): number {
  return Math.max(segment.older[1] - segment.older[0], segment.newer[1] - segment.newer[0]);
}

/**
 * The shortest script can thread a rewritten sentence through its one shared
 * word — "في" or "the" — and chop the change into pieces around it. A run of
 * matching words shorter than the changes on both sides of it becomes part of
 * one change, which is how a person reads a rewritten passage.
 */
export function joinShortRuns(segments: readonly Segment[]): Segment[] {
  let list = segments.map((s) => ({ kind: s.kind, older: [...s.older], newer: [...s.newer] }) as Segment);
  for (let joined = true; joined; ) {
    joined = false;
    const out: Segment[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const segment = list[i]!;
      const before = out.at(-1);
      const after = list[i + 1];
      if (
        segment.kind === 'same' &&
        before?.kind === 'changed' &&
        after?.kind === 'changed' &&
        weight(segment) < weight(before) &&
        weight(segment) < weight(after)
      ) {
        before.older[1] = after.older[1];
        before.newer[1] = after.newer[1];
        i += 1;
        joined = true;
      } else {
        out.push(segment);
      }
    }
    list = out;
  }
  return list;
}

/**
 * The shortest edit script from `older` to `newer`, compared by key: runs of
 * matching words and the changes between them, in order, covering both
 * sequences, with as few words deleted and inserted as possible. Past
 * `maxEdits` the unmatched middle is one change.
 */
export function editScript(older: readonly string[], newer: readonly string[], maxEdits = MAX_EDITS): Segment[] {
  // Numbers compare faster than strings, and the edit graph compares a lot.
  const ids = new Map<string, number>();
  const id = (key: string) => {
    let found = ids.get(key);
    if (found === undefined) {
      found = ids.size;
      ids.set(key, found);
    }
    return found;
  };
  const a = Int32Array.from(older, id);
  const b = Int32Array.from(newer, id);

  // The common start and end cost nothing to find and usually hold most of a page.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const segments: Segment[] = [];
  append(segments, 'same', 0, 0, start, start);
  const moves = shortestPath(a.subarray(start, endA), b.subarray(start, endB), maxEdits);
  if (moves === null) {
    append(segments, 'changed', start, start, endA, endB);
  } else {
    let x = start;
    let y = start;
    for (const move of moves) {
      if (move === SAME) append(segments, 'same', x, y, x + 1, y + 1);
      else if (move === DELETE) append(segments, 'changed', x, y, x + 1, y);
      else append(segments, 'changed', x, y, x, y + 1);
      if (move !== INSERT) x += 1;
      if (move !== DELETE) y += 1;
    }
  }
  append(segments, 'same', endA, endB, a.length, b.length);
  return segments;
}

/** What changed from `older` to `newer`, word by word, as a person reads it. */
export function diffWords(older: readonly string[], newer: readonly string[], maxEdits = MAX_EDITS): Segment[] {
  return joinShortRuns(editScript(older, newer, maxEdits));
}
