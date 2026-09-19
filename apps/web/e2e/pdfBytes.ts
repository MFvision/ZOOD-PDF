import { readFileSync } from 'node:fs';
import { constants, inflateSync } from 'node:zlib';

/**
 * A PDF as anyone could read it: its bytes, and every stream in it inflated
 * — found by scanning, not through a parser, so earlier revisions and
 * objects nothing refers to are read too. Latin-1, one char per byte.
 */
export function readable(bytes: Buffer): string {
  let out = bytes.toString('latin1');
  let at = 0;
  for (;;) {
    const keyword = bytes.indexOf('stream', at, 'latin1');
    if (keyword < 0) break;
    let start = keyword + 6;
    while (bytes[start] === 0x0d || bytes[start] === 0x0a) start += 1;
    const end = bytes.indexOf('endstream', start, 'latin1');
    if (end < 0) break;
    try {
      out += inflateSync(bytes.subarray(start, end), { finishFlush: constants.Z_SYNC_FLUSH }).toString('latin1');
    } catch {
      // Not a Flate stream: its bytes are in `out` already.
    }
    at = end + 9;
  }
  return out;
}

/**
 * Every way `text` can sit in a PDF's bytes: as a literal or a hex string in
 * a single-byte encoding (PDFium writes the hex), and as a text string in
 * UTF-16BE, raw or hex, or UTF-8.
 */
export function spellings(text: string): string[] {
  const latin = Buffer.from(text, 'latin1');
  const utf16 = Buffer.from(text, 'utf16le').swap16();
  const forms = [utf16.toString('latin1'), utf16.toString('hex'), Buffer.from(text, 'utf8').toString('latin1')];
  // A single-byte spelling only for text that has one.
  if (latin.toString('latin1') === text) forms.push(text, latin.toString('hex'));
  return forms.flatMap((form) => (/^[0-9a-f]+$/.test(form) ? [form, form.toUpperCase()] : [form]));
}

interface CallReply {
  json: string;
  blobs: Uint8Array[];
}
interface CoreModule {
  default(options: { module_or_path: Buffer }): Promise<unknown>;
  call_static(op: string, args: string, blobs: Uint8Array[]): CallReply;
  Document: { open(bytes: Uint8Array, password?: string): { page_count(): number; extract_text(i: number): string; free(): void } };
}

let loaded: Promise<CoreModule> | null = null;

/** Warraq's own core, the WASM build the app ships, run here in Node. */
export function core(): Promise<CoreModule> {
  loaded ??= (async () => {
    const root = new URL('../../../packages/ui/src/core-wasm/', import.meta.url);
    const module = (await import(new URL('warraq_core.js', root).href)) as CoreModule;
    await module.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', root)) });
    return module;
  })();
  return loaded;
}

/** Every page's text, as Warraq's reader reads the file. */
export async function textOf(path: string): Promise<string> {
  const { Document } = await core();
  const doc = Document.open(new Uint8Array(readFileSync(path)));
  try {
    return Array.from({ length: doc.page_count() }, (_, i) => doc.extract_text(i)).join('\n');
  } finally {
    doc.free();
  }
}

/** A static core operation on a file, answered as JSON (and bytes). */
export async function callOn<T>(op: string, path: string, args: object = {}): Promise<{ result: T; blobs: Uint8Array[] }> {
  const { call_static } = await core();
  const reply = call_static(op, JSON.stringify(args), [new Uint8Array(readFileSync(path))]);
  return { result: JSON.parse(reply.json) as T, blobs: reply.blobs };
}
