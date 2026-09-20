/**
 * The JSON in a model's answer. Claude, asked with a schema, answers with
 * exactly that; a local model may wrap it in a code fence or a sentence, or
 * think aloud first. What is read is the outermost `{…}` that parses — and
 * only as data: every field is checked by the task that asked for it.
 */
export function jsonIn(answer: string): unknown {
  const text = answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    /* not bare JSON: look inside */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** `value` as an array, or empty. */
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** `value` as an object's fields, or none. */
export const fields = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A string no longer than `max`, or null. */
export const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length <= max ? value : null;

/** A whole number from `min` to `max`, or null. */
export const int = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
