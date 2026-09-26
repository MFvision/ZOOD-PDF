/**
 * Inspects saved PDF bytes in the test process with the same engine build the app ships
 * (packages/ui/src/wasm/pkg, loaded with initSync): page count, boxes, rotation, outline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers';

interface Wasm {
  initSync(opts: { module: Buffer }): void;
  WarraqDocument: { open(bytes: Uint8Array, password?: string): { call(m: string, p: string, b: Uint8Array[]): { json: string; blobs: Uint8Array[] }; free(): void } };
}

let wasm: Wasm | null = null;
async function engine(): Promise<Wasm> {
  if (wasm) return wasm;
  const pkg = path.join(ROOT, 'packages/ui/src/wasm/pkg');
  const mod = (await import(pathToFileURL(path.join(pkg, 'warraq_core.js')).href)) as Wasm;
  mod.initSync({ module: fs.readFileSync(path.join(pkg, 'warraq_core_bg.wasm')) });
  wasm = mod;
  return mod;
}

export interface PageBox {
  mediaBox: [number, number, number, number];
  cropBox: [number, number, number, number] | null;
  rotate: number;
}

export interface OutlineItem {
  title: string;
  page: number | null;
  children: OutlineItem[];
}

export interface Inspected {
  pageCount: number;
  revisions: number;
  pages: PageBox[];
  /** Page widths (MediaBox), rounded: the organize fixture's pages are 400, 420 … 500 pt wide. */
  widths: number[];
  outline: OutlineItem[];
}

export async function inspectPdf(bytes: Uint8Array, password?: string): Promise<Inspected> {
  const { WarraqDocument } = await engine();
  const doc = WarraqDocument.open(new Uint8Array(bytes), password);
  try {
    const call = <T>(m: string) => JSON.parse(doc.call(m, '{}', []).json) as T;
    const info = call<{ pageCount: number; revisions: number }>('doc.info');
    const boxes = call<{ pages: PageBox[] }>('pages.boxes').pages;
    const outline = call<{ items: OutlineItem[] }>('doc.outline').items;
    return {
      pageCount: info.pageCount,
      revisions: info.revisions,
      pages: boxes,
      widths: boxes.map((b) => Math.round(b.mediaBox[2] - b.mediaBox[0])),
      outline,
    };
  } finally {
    doc.free();
  }
}

/** The organize fixture's page number (1–6) from its width. */
export const pageNo = (width: number) => (width - 400) / 20 + 1;

/** Entries of a store-only ZIP (as Split writes it). */
export function unzip(zip: Buffer): { name: string; bytes: Buffer }[] {
  const eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error('not a zip');
  const count = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  const out: { name: string; bytes: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    const size = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const local = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out.push({ name, bytes: zip.subarray(start, start + size) });
    pos += 46 + nameLen + zip.readUInt16LE(pos + 30) + zip.readUInt16LE(pos + 32);
  }
  return out;
}
