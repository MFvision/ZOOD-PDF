/**
 * The matched line of a hit, cut to what fits and with the matched words
 * marked. The core answers with the whole line and the spans inside it; this
 * turns them into the parts the panel draws, so the marking is a pure
 * function with its own tests rather than something only the eye can check.
 *
 * Spans count Unicode scalar values (`ops.ts`), not UTF-16 units, so a line
 * with an emoji or a rare glyph marks in the same place as Arabic does.
 * Anything outside the line is clamped away instead of throwing: the index
 * is read from a file, and a file is hostile input.
 */

export interface SnippetPart {
  text: string;
  match: boolean;
}

export interface Snippet {
  parts: SnippetPart[];
  /** Text was cut from the start of the line. */
  cutStart: boolean;
  /** Text was cut from its end. */
  cutEnd: boolean;
}

type Span = readonly [number, number];

/** Sorted, clamped and merged spans: overlapping marks become one mark. */
function tidySpans(spans: readonly Span[], length: number): Span[] {
  const clamped: Span[] = [];
  for (const span of spans) {
    const start = Math.max(0, Math.min(Math.trunc(span?.[0] ?? 0), length));
    const size = Math.max(0, Math.trunc(span?.[1] ?? 0));
    const end = Math.min(start + size, length);
    if (end > start) clamped.push([start, end - start]);
  }
  clamped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Span[] = [];
  for (const [start, size] of clamped) {
    const last = merged[merged.length - 1];
    if (last && start <= last[0] + last[1]) merged[merged.length - 1] = [last[0], Math.max(last[0] + last[1], start + size) - last[0]];
    else merged.push([start, size]);
  }
  return merged;
}

/** The line split into marked and unmarked parts, in reading order. */
export function markSpans(text: string, spans: readonly Span[]): SnippetPart[] {
  const characters = Array.from(text);
  const marks = tidySpans(spans, characters.length);
  if (marks.length === 0) return text === '' ? [] : [{ text, match: false }];
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const [start, size] of marks) {
    if (start > at) parts.push({ text: characters.slice(at, start).join(''), match: false });
    parts.push({ text: characters.slice(start, start + size).join(''), match: true });
    at = start + size;
  }
  if (at < characters.length) parts.push({ text: characters.slice(at).join(''), match: false });
  return parts;
}

/**
 * The same, with a long line cut to a window around its first match, so one
 * result stays one or two lines wherever the match falls. `before` and
 * `after` are in characters.
 */
export function snippet(
  text: string,
  spans: readonly Span[],
  options: { before?: number; after?: number } = {},
): Snippet {
  const before = options.before ?? 40;
  const after = options.after ?? 120;
  const characters = Array.from(text);
  const marks = tidySpans(spans, characters.length);
  const first = marks[0]?.[0] ?? 0;
  const start = Math.max(0, first - before);
  const last = marks[marks.length - 1];
  const end = Math.min(characters.length, Math.max(first + after, last ? last[0] + last[1] + 8 : 0));
  const cut = characters.slice(start, end).join('');
  const moved = marks
    .map(([at, size]): Span => [at - start, size])
    .filter(([at, size]) => at + size > 0 && at < end - start);
  return { parts: markSpans(cut, moved), cutStart: start > 0, cutEnd: end < characters.length };
}
