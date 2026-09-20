/**
 * The matched line of a hit, cut to what fits and with the matched words
 * marked. The core answers with the whole line and the places of the matches
 * inside it; this turns them into the parts the panel draws, so the marking
 * is a pure function with its own tests rather than something only the eye
 * can check.
 *
 * The core counts those places in **UTF-8 bytes**, because that is how Rust
 * holds the line; JavaScript counts a string in UTF-16 units. An Arabic
 * letter is two bytes and one unit, so using a byte offset as a string index
 * marks the wrong half of the word — the first thing done here is to turn one
 * into the other. Anything outside the line is clamped away instead of
 * throwing: the index is read from a file, and a file is hostile input.
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

/** How many UTF-8 bytes a code point takes. */
function utf8Length(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/**
 * Where each UTF-8 byte offset of `text` falls in the string, at the
 * boundaries between characters. An offset inside a character is snapped back
 * to where that character starts, which is what a damaged index would give.
 */
function placesOfBytes(text: string): Map<number, number> {
  const places = new Map<number, number>();
  let byte = 0;
  for (let at = 0; at < text.length; ) {
    const code = text.codePointAt(at) ?? 0;
    const units = code > 0xffff ? 2 : 1;
    places.set(byte, at);
    byte += utf8Length(code);
    at += units;
  }
  places.set(byte, text.length);
  return places;
}

/** A byte offset as a place in the string, snapped inside the line. */
function placeOf(places: Map<number, number>, bytes: number, length: number, end: number): number {
  if (bytes <= 0) return 0;
  if (bytes >= length) return end;
  for (let at = bytes; at >= 0; at -= 1) {
    const place = places.get(at);
    if (place !== undefined) return place;
  }
  return 0;
}

/** Sorted, clamped and merged spans, in places in the string: overlaps become one mark. */
function tidySpans(text: string, spans: readonly Span[]): Span[] {
  const places = placesOfBytes(text);
  let bytes = 0;
  for (let at = 0; at < text.length; ) {
    const code = text.codePointAt(at) ?? 0;
    bytes += utf8Length(code);
    at += code > 0xffff ? 2 : 1;
  }
  const clamped: Span[] = [];
  for (const span of spans) {
    const from = Math.trunc(span?.[0] ?? 0);
    const size = Math.max(0, Math.trunc(span?.[1] ?? 0));
    const start = placeOf(places, from, bytes, text.length);
    const finish = placeOf(places, from + size, bytes, text.length);
    if (finish > start) clamped.push([start, finish - start]);
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
  const marks = tidySpans(text, spans);
  if (marks.length === 0) return text === '' ? [] : [{ text, match: false }];
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const [start, size] of marks) {
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, start + size), match: true });
    at = start + size;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

/** A place that is not in the middle of a character. */
function whole(text: string, at: number): number {
  if (at <= 0) return 0;
  if (at >= text.length) return text.length;
  const code = text.charCodeAt(at);
  // The low half of a surrogate pair: step back to its high half.
  return code >= 0xdc00 && code <= 0xdfff ? at - 1 : at;
}

/**
 * The same, with a long line cut to a window around its first match, so one
 * result stays a line or two wherever the match falls. `before` and `after`
 * are in characters.
 */
export function snippet(
  text: string,
  spans: readonly Span[],
  options: { before?: number; after?: number } = {},
): Snippet {
  const before = options.before ?? 40;
  const after = options.after ?? 120;
  const marks = tidySpans(text, spans);
  const first = marks[0]?.[0] ?? 0;
  const start = whole(text, Math.max(0, first - before));
  const last = marks[marks.length - 1];
  const end = whole(text, Math.min(text.length, Math.max(first + after, last ? last[0] + last[1] + 8 : 0)));
  const cut = text.slice(start, end);
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const [markStart, size] of marks) {
    const from = Math.max(0, markStart - start);
    const to = Math.min(cut.length, markStart + size - start);
    if (to <= from) continue;
    if (from > at) parts.push({ text: cut.slice(at, from), match: false });
    parts.push({ text: cut.slice(from, to), match: true });
    at = to;
  }
  if (at < cut.length) parts.push({ text: cut.slice(at), match: false });
  if (parts.length === 0 && cut !== '') parts.push({ text: cut, match: false });
  return { parts, cutStart: start > 0, cutEnd: end < text.length };
}
