/** The product engine (warraq-core WASM build) in Node, to inspect saved bytes the way the app reads them. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PKG = path.join(ROOT, 'packages/ui/src/wasm/pkg');

interface WarraqDocument {
  call(method: string, params: string, blobs: Uint8Array[]): { json: string; blobs: Uint8Array[] };
  free(): void;
}
interface Wasm {
  initSync(o: { module: Buffer }): void;
  WarraqDocument: { open(bytes: Uint8Array, password?: string): WarraqDocument };
}

let wasm: Promise<Wasm> | null = null;
function load(): Promise<Wasm> {
  wasm ??= (async () => {
    const m = (await import(pathToFileURL(path.join(PKG, 'warraq_core.js')).href)) as Wasm;
    m.initSync({ module: fs.readFileSync(path.join(PKG, 'warraq_core_bg.wasm')) });
    return m;
  })();
  return wasm;
}

export async function engineCall<T = unknown>(bytes: Uint8Array, method: string, params: unknown = {}): Promise<T> {
  const m = await load();
  const doc = m.WarraqDocument.open(bytes, undefined);
  try {
    const r = doc.call(method, JSON.stringify(params), []);
    return (typeof r.json === 'string' ? JSON.parse(r.json) : r.json) as T;
  } finally {
    doc.free();
  }
}

export async function plainText(bytes: Uint8Array): Promise<{ text: string; pages: string[] }> {
  return engineCall(bytes, 'text.plain', {});
}
