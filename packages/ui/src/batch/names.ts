import { zipSync } from 'fflate';
import type { Zippable } from 'fflate';

/**
 * What a batch's results are called, and the zip a browser hands them over
 * in. A result is never given its original's name: it goes beside it (on the
 * desktop) with a suffix, or into a folder or a zip of its own, and a name
 * already taken there becomes "name (2)".
 */

/** A suffix as typed, made safe for a file name: no folders, no control characters, not too long. */
export function cleanSuffix(suffix: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what is being removed
  return suffix.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '').slice(0, 40);
}

/** A file's name without its extension: "report" of "report.pdf" and of "report.PDF". */
export function stemOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base || 'document';
}

/**
 * A result's name: the original's stem, the suffix, and the result's own
 * extension — "report-processed.pdf", "report-processed.docx".
 */
export function resultName(original: string, suffix: string, extension: string): string {
  return `${stemOf(original)}${cleanSuffix(suffix)}.${extension}`;
}

/** "name (2).ext", "name (3).ext" … the first that is not in `taken`; the chosen one is added to it. */
export function uniqueName(name: string, taken: Set<string>): string {
  const key = (n: string) => n.normalize('NFC').toLowerCase();
  let candidate = name;
  const dot = name.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; taken.has(key(candidate)); n += 1) candidate = `${stem} (${n})${extension}`;
  taken.add(key(candidate));
  return candidate;
}

/** A folder path inside the zip, from a file's place under the folder it came from: safe segments only. */
export function zipFolder(relative: string | undefined): string {
  if (!relative) return '';
  const segments = relative.split(/[\\/]/).slice(0, -1);
  const safe = segments.filter((s) => s !== '' && s !== '.' && s !== '..').map((s) => s.slice(0, 120));
  return safe.length > 0 ? `${safe.join('/')}/` : '';
}

/** Formats that are compressed already: stored in the zip as they are. */
const STORED = /\.(pdf|png|zip|docx|jpe?g)$/i;

/** The results in one zip, each at its path (folders from `zipFolder`). */
export function zipResults(results: readonly { path: string; bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const files: Zippable = {};
  for (const { path, bytes } of results) files[path] = [bytes, { level: STORED.test(path) ? 0 : 6 }];
  return zipSync(files) as Uint8Array<ArrayBuffer>;
}
