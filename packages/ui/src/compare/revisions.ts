/**
 * The earlier revisions inside a PDF file.
 *
 * A PDF is saved incrementally by appending — Warraq's own saves do this — and
 * each save ends with a trailer, `startxref`, the offset of its cross-reference
 * section, and `%%EOF` (ISO 32000-1, 7.5.5 and 7.5.6). Every byte up to such an
 * end is the file as that save left it, so earlier revisions are prefixes of
 * the file. Only prefixes the core really opens count: `%%EOF` can also turn
 * up by chance inside compressed data.
 */

export interface Revision {
  /** One-based, oldest first; the last is the file as it stands. */
  number: number;
  /** How many bytes from the start of the file make up this revision. */
  length: number;
  /** Null only if the file as it stands could not be read again. */
  pages: number | null;
}

const EOF_MARK = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
/** `startxref`, its offset and the line breaks fit well inside this many bytes before `%%EOF`. */
const TRAILER_WINDOW = 64;
/** A linearized original may end a few blank bytes before its declared length. */
const LINEARIZED_SLACK = 16;

function latin1(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/**
 * A linearized file (ISO 32000-1, annex F) carries a second `%%EOF` near its
 * start, after the first page's cross-reference section: not a revision, but
 * the file cut short. Its linearization dictionary gives the length of the
 * whole original, `/L`, and every revision ends at or after it.
 */
function linearizedLength(bytes: Uint8Array): number | null {
  const head = latin1(bytes.subarray(0, 1024));
  const found = /\/Linearized\b[^>]*?\/L\s+(\d+)/.exec(head);
  const length = found ? Number(found[1]) : NaN;
  return Number.isFinite(length) && length > 0 && length <= bytes.length ? length : null;
}

/**
 * Where each earlier revision ends — just past its `%%EOF` and line break —
 * oldest first. The file's own last `%%EOF` ends the revision that is open, so
 * it is not among them; nor is a `%%EOF` without `startxref` just before it.
 */
export function revisionEnds(bytes: Uint8Array): number[] {
  const ends: number[] = [];
  for (let at = bytes.indexOf(0x25); at >= 0 && at + EOF_MARK.length <= bytes.length; at = bytes.indexOf(0x25, at + 1)) {
    if (!EOF_MARK.every((byte, i) => bytes[at + i] === byte)) continue;
    const trailer = latin1(bytes.subarray(Math.max(0, at - TRAILER_WINDOW), at));
    if (!/startxref\s+\d+\s*$/.test(trailer)) continue;
    let end = at + EOF_MARK.length;
    if (bytes[end] === 0x0d) end += 1;
    if (bytes[end] === 0x0a) end += 1;
    ends.push(end);
  }
  ends.pop();
  const linearized = linearizedLength(bytes);
  return linearized === null ? ends : ends.filter((end) => end + LINEARIZED_SLACK >= linearized);
}

/**
 * How many earlier revisions are looked at, the latest ones. Each is opened
 * by the core in full: a 17 MB file carrying 300 trailers kept the core busy
 * for a minute and a half as soon as Compare was opened, and everything else
 * waited behind it (break-zood, files-ui).
 */
export const MAX_REVISIONS = 40;

/**
 * Every revision of the file that opens, oldest first, with its page count;
 * `pagesOf` opens a prefix with the core and answers null when it does not.
 * The file as it stands is always the last. Of many, only the latest
 * `MAX_REVISIONS` are tried, still numbered as the file counts them.
 */
export async function findRevisions(
  bytes: Uint8Array,
  pagesOf: (prefix: ArrayBuffer) => Promise<number | null>,
  limit = MAX_REVISIONS,
): Promise<Revision[]> {
  const ends = revisionEnds(bytes);
  const skipped = Math.max(0, ends.length - limit);
  const revisions: Revision[] = [];
  for (const end of ends.slice(skipped)) {
    // A copy: the core takes the buffer it is given.
    const pages = await pagesOf(bytes.slice(0, end).buffer);
    if (pages !== null && pages > 0) revisions.push({ number: skipped + revisions.length + 1, length: end, pages });
  }
  const pages = await pagesOf(bytes.slice().buffer);
  revisions.push({ number: skipped + revisions.length + 1, length: bytes.length, pages });
  return revisions;
}
