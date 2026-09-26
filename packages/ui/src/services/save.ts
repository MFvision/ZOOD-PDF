/**
 * Turning an edited document into the bytes we write to disk. PDFium writes files whole; the engine's
 * `doc.rebase` appends only the objects PDFium changed to the ORIGINAL bytes, so the saved file is the
 * original file + one incremental update (signatures and untouched bytes survive).
 *
 * This is the one call site for rebase.
 */
import type { EngineClient } from './engine';
import { EngineError } from './engine';

export interface RebaseResult {
  bytes: Uint8Array;
  /** 'incremental' = original bytes are a prefix; 'rewrite' = PDFium's whole file (see reason). */
  mode: 'incremental' | 'rewrite';
  reason?: string;
}

let tmp = 0;

export async function rebaseOnOriginal(
  engine: EngineClient,
  original: Uint8Array,
  pdfium: Uint8Array,
  password?: string,
): Promise<RebaseResult> {
  const docId = `rebase-${++tmp}`;
  try {
    // A protected original is opened with the password typed into our prompt; the engine keeps its
    // encryption (same key) on the appended update.
    if (password === undefined) await engine.open(docId, original);
    else await engine.open(docId, original, password);
    const reply = await engine.call(docId, 'doc.rebase', {}, [pdfium.slice()]);
    const out = reply.blobs[0];
    if (!out || out.byteLength === 0) throw new EngineError('rebase_empty', 'doc.rebase returned no bytes');
    return { bytes: out, mode: 'incremental' };
  } catch (e) {
    // Fall back to PDFium's own (whole) save only when the engine cannot read the original at all:
    // a build without the engine (development escape hatch), or (defensively) a protected original whose
    // password never reached us — our own prompt normally supplies it (PDFium keeps the encryption).
    if (e instanceof EngineError && (e.code === 'engine_missing' || e.code === 'password_required' || e.code === 'wrong_password')) {
      return { bytes: pdfium, mode: 'rewrite', reason: e.code };
    }
    throw e;
  } finally {
    engine.close(docId).catch(() => {});
  }
}

/** Used to drop recents previews: the saved file is encrypted (password/permissions). The trailer
 * (or the cross-reference stream dictionary) sits at the end of a PDFium-written file. */
export function looksProtected(bytes: Uint8Array): boolean {
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.byteLength - 65536)));
  return /\/Encrypt[\s\d<]/.test(tail);
}

export const WHOLE_REWRITE_BYTES = 150 * 1024 * 1024;

/**
 * Incremental (rebase) unless the change must not leave the earlier content in the file: redaction applied,
 * protection (password/permissions) added, changed or removed, or files over 150 MB (docs/SPEC.md §1).
 */
export function saveStrategy(opts: { original: Uint8Array; pdfium: Uint8Array; redacted: boolean; encrypted?: boolean }): {
  mode: 'incremental' | 'rewrite';
  reason?: 'redaction' | 'protection' | 'size';
} {
  if (opts.redacted) return { mode: 'rewrite', reason: 'redaction' };
  // We hold the password of a protected original: rebase keeps its encryption even when PDFium wrote
  // the edit decrypted (protection itself only changes through the core's Protect panel).
  if (opts.encrypted && looksProtected(opts.original)) {
    return opts.original.byteLength > WHOLE_REWRITE_BYTES ? { mode: 'rewrite', reason: 'size' } : { mode: 'incremental' };
  }
  if (looksProtected(opts.original) !== looksProtected(opts.pdfium)) return { mode: 'rewrite', reason: 'protection' };
  if (opts.original.byteLength > WHOLE_REWRITE_BYTES) return { mode: 'rewrite', reason: 'size' };
  return { mode: 'incremental' };
}
