import { diffWords } from './diff';
import type { Segment } from './diff';
import { comparisonKey } from './normalize';
import type { CompareOptions } from './normalize';

/** Unchanged words shown on each side of a change, so it can be found on the page. */
export const CONTEXT_WORDS = 8;

/** A stretch of a passage: words both versions share, or ones only one has. */
export interface Part {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** One change or a close group of them, with the unchanged words around it. */
export interface Passage {
  /** Unchanged words come before it on the page and are not shown. */
  before: boolean;
  /** Unchanged words come after it on the page and are not shown. */
  after: boolean;
  parts: Part[];
}

export interface PageChange {
  /** One-based: page n of one version is compared with page n of the other. */
  page: number;
  inOlder: boolean;
  inNewer: boolean;
  added: number;
  removed: number;
  passages: Passage[];
}

export interface Comparison {
  olderPages: number;
  newerPages: number;
  /** Every word of each version: none at all means there was no text to compare (a scan). */
  olderWords: number;
  newerWords: number;
  /** Only the pages whose words differ, in page order. */
  changed: PageChange[];
  added: number;
  removed: number;
}

interface Words {
  /** As they are on the page. */
  shown: string[];
  /** As they are compared (`normalize.ts`). */
  keys: string[];
}

/**
 * A page's words, split at whitespace — `extract_text` gives lines in logical
 * order joined by newlines, so Arabic reads start to end whatever the line
 * breaks. A word with nothing left to compare (a lone tatweel, with marks
 * ignored) is left out on both sides.
 */
export function wordsOf(text: string, options: CompareOptions): Words {
  const shown: string[] = [];
  const keys: string[] = [];
  for (const word of text.split(/\s+/)) {
    const key = comparisonKey(word, options);
    if (key.length === 0) continue;
    shown.push(word);
    keys.push(key);
  }
  return { shown, keys };
}

/** Groups a page's changes into passages, each with `context` unchanged words either side. */
export function passagesOf(segments: readonly Segment[], older: readonly string[], newer: readonly string[], context = CONTEXT_WORDS): Passage[] {
  const passages: Passage[] = [];
  let open: Passage | null = null;
  // Unchanged words are shown as the newer version has them.
  const same = (segment: Segment, from: number, to: number): Part => ({
    kind: 'same',
    text: newer.slice(segment.newer[0] + from, segment.newer[0] + to).join(' '),
  });
  for (const [index, segment] of segments.entries()) {
    if (segment.kind === 'changed') {
      if (!open) {
        open = { before: false, after: false, parts: [] };
        passages.push(open);
      }
      if (segment.older[1] > segment.older[0]) open.parts.push({ kind: 'removed', text: older.slice(...segment.older).join(' ') });
      if (segment.newer[1] > segment.newer[0]) open.parts.push({ kind: 'added', text: newer.slice(...segment.newer).join(' ') });
      continue;
    }
    const length = segment.newer[1] - segment.newer[0];
    const last = index === segments.length - 1;
    if (index === 0) {
      // The words before the first change: the end of them leads into it.
      if (last) break;
      const from = Math.max(0, length - context);
      open = { before: from > 0, after: false, parts: [same(segment, from, length)] };
      passages.push(open);
    } else if (!open) {
      continue;
    } else if (last) {
      const to = Math.min(length, context);
      open.parts.push(same(segment, 0, to));
      open.after = to < length;
      open = null;
    } else if (length <= 2 * context) {
      // Two changes this close read as one passage.
      open.parts.push(same(segment, 0, length));
    } else {
      open.parts.push(same(segment, 0, context));
      open.after = true;
      open = { before: true, after: false, parts: [same(segment, length - context, length)] };
      passages.push(open);
    }
  }
  return passages;
}

/**
 * Every page of `older` against the page in the same position of `newer`,
 * word by word. Pages beyond the shorter version are all removed or all added.
 */
export function comparePages(older: readonly string[], newer: readonly string[], options: CompareOptions, context = CONTEXT_WORDS): Comparison {
  const changed: PageChange[] = [];
  let added = 0;
  let removed = 0;
  let olderWords = 0;
  let newerWords = 0;
  for (let index = 0; index < Math.max(older.length, newer.length); index += 1) {
    const before = wordsOf(older[index] ?? '', options);
    const after = wordsOf(newer[index] ?? '', options);
    olderWords += before.keys.length;
    newerWords += after.keys.length;
    const segments = diffWords(before.keys, after.keys);
    let pageAdded = 0;
    let pageRemoved = 0;
    for (const segment of segments) {
      if (segment.kind !== 'changed') continue;
      pageRemoved += segment.older[1] - segment.older[0];
      pageAdded += segment.newer[1] - segment.newer[0];
    }
    if (pageAdded + pageRemoved === 0) continue;
    added += pageAdded;
    removed += pageRemoved;
    changed.push({
      page: index + 1,
      inOlder: index < older.length,
      inNewer: index < newer.length,
      added: pageAdded,
      removed: pageRemoved,
      passages: passagesOf(segments, before.shown, after.shown, context),
    });
  }
  return { olderPages: older.length, newerPages: newer.length, olderWords, newerWords, changed, added, removed };
}
