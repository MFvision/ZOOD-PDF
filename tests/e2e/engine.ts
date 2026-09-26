/**
 * The Rust engine (the same wasm build the app ships) loaded in Node, to inspect saved bytes in specs:
 * reopen a saved file, read its text in logical order, list revisions, check passwords.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers';

interface WasmDoc {
  call(method: string, params: string, blobs: Uint8Array[]): { json: unknown; blobs: Uint8Array[] };
  free(): void;
}
interface WasmModule {
  initSync(opts: { module: Buffer }): void;
  WarraqDocument: { open(bytes: Uint8Array, password?: string): WasmDoc };
}

let mod: WasmModule | null = null;

async function load(): Promise<WasmModule> {
  if (mod) return mod;
  const pkg = path.join(ROOT, 'packages/ui/src/wasm/pkg');
  const m = (await import(pathToFileURL(path.join(pkg, 'warraq_core.js')).href)) as WasmModule;
  m.initSync({ module: fs.readFileSync(path.join(pkg, 'warraq_core_bg.wasm')) });
  mod = m;
  return m;
}

export interface NodeDoc {
  call<J = Record<string, unknown>>(method: string, params?: unknown): { json: J; blobs: Uint8Array[] };
  plain(): string;
  info(): { encrypted: boolean; revisions: number; passwordMatched: string | null; permissions: Record<string, boolean>; pageCount: number };
  close(): void;
}

/** Opens `bytes` in the engine; throws `{ code, message }` like the app's engine does. */
export async function openInEngine(bytes: Uint8Array | Buffer, password?: string): Promise<NodeDoc> {
  const m = await load();
  const d = m.WarraqDocument.open(new Uint8Array(bytes), password);
  const call = <J>(method: string, params: unknown = {}) => {
    const r = d.call(method, JSON.stringify(params), []);
    const json = (typeof r.json === 'string' ? JSON.parse(r.json) : r.json) as J;
    return { json, blobs: r.blobs };
  };
  return {
    call,
    plain: () => call<{ text: string }>('text.plain').json.text,
    info: () => call<ReturnType<NodeDoc['info']>>('doc.info').json,
    close: () => d.free(),
  };
}

/** The engine's error code for opening `bytes` (null when it opens). */
export async function openErrorCode(bytes: Uint8Array | Buffer, password?: string): Promise<string | null> {
  try {
    (await openInEngine(bytes, password)).close();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}
