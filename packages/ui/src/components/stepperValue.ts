/**
 * What a number field's text means, as it is typed. A field that took every
 * keystroke as its value clamped "1" to its minimum before "12" could be
 * typed, and read a lone "-" as 0: so what is typed stays as it is, a value
 * goes on only once the text is a number in range, and the field settles —
 * to the nearest value in range, or back to the last good one — when it is
 * left.
 */

export const clamp = (value: number, min?: number, max?: number) =>
  Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, value));

function parse(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** The number typed, when it is one and in range; `null` while it is not yet. */
export function typedNumber(text: string, min?: number, max?: number): number | null {
  const n = parse(text);
  if (n === null) return null;
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) return null;
  return n;
}

/** Where a field settles when it is left: what was typed, kept in range, or `fallback`. */
export function settledNumber(text: string, fallback: number, min?: number, max?: number): number {
  const n = parse(text);
  return n === null ? fallback : clamp(n, min, max);
}
