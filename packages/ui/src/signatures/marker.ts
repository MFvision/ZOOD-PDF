/**
 * `/ByteRange`, which every signature dictionary has: whether a file is
 * signed at all, found without parsing it. Kept free of imports, for the
 * shell's save path as well as the signatures panel.
 */
const MARKER = new TextEncoder().encode('/ByteRange');

export function mentionsSignature(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  const slash = 0x2f;
  outer: for (let i = view.indexOf(slash); i !== -1 && i <= view.length - MARKER.length; i = view.indexOf(slash, i + 1)) {
    for (let k = 1; k < MARKER.length; k += 1) if (view[i + k] !== MARKER[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * How EmbedPDF's save (PDFium writes a file whole) is kept, for a file of
 * `size` bytes: as an update of the file's own bytes (`rebase`); as the
 * rewrite, after a redaction (nothing under it may survive) or for a file too
 * large to hold twice; or — for a signed file that large — as an update or
 * not at all (`rebaseOrRefuse`): a rewrite would break its signatures, and
 * saving one silently is what must not happen.
 */
export function keepPolicy(size: number, limit: number, redacted: boolean, signed: () => boolean): 'rebase' | 'rewrite' | 'rebaseOrRefuse' {
  if (redacted) return 'rewrite';
  if (size <= limit) return 'rebase';
  return signed() ? 'rebaseOrRefuse' : 'rewrite';
}
