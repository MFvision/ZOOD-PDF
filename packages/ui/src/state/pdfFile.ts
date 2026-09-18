/**
 * Deciding whether a file is a PDF.
 *
 * By its bytes first: a reader looks for `%PDF-` within the first kilobyte, and
 * so do we. The name and the MIME type are only hints — they lie in both
 * directions. A PDF that arrives without an extension, as some mail and chat
 * apps deliver them, used to be refused outright; a file merely *named* .pdf is
 * still let through, because the core parses hostile input and says precisely
 * what is wrong with it.
 */

const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** How far into a file the signature may start. */
export const PDF_SNIFF_BYTES = 1024;

export function looksLikePdf(head: Uint8Array): boolean {
  const last = Math.min(head.length, PDF_SNIFF_BYTES) - MAGIC.length;
  for (let start = 0; start <= last; start += 1) {
    if (MAGIC.every((byte, offset) => head[start + offset] === byte)) return true;
  }
  return false;
}

/** The name or type says PDF. A hint for choosing among dropped files, no more. */
export function namedLikePdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export async function isPdf(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, PDF_SNIFF_BYTES).arrayBuffer());
  return looksLikePdf(head) || namedLikePdf(file);
}
