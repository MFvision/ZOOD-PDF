/// <reference lib="webworker" />
/**
 * Module worker hosting the Rust engine (wasm-pack output in src/wasm/pkg). `virtual:warraq-core` is
 * resolved by the `zoodEngine` Vite plugin to `src/wasm/pkg/warraq_core.js`; when the pkg is missing
 * the BUILD fails (no silent mock).
 */
import init, { WarraqDocument, callStatic } from 'virtual:warraq-core';
import type { EngineRequest, EngineResponse } from './engine';

declare const self: DedicatedWorkerGlobalScope;

let ready: Promise<unknown> | null = null;
const docs = new Map<string, WarraqDocument>();

interface RawReply {
  json: unknown;
  blobs: Uint8Array[];
}

function normalise(reply: unknown): RawReply {
  const r = reply as { json?: unknown; blobs?: unknown };
  let json = r?.json;
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json);
    } catch {
      /* keep the raw string */
    }
  }
  const blobs = Array.isArray(r?.blobs) ? (r.blobs as Uint8Array[]).map((b) => new Uint8Array(b)) : [];
  return { json: json ?? null, blobs };
}

function toError(e: unknown): { code: string; message: string } {
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown };
    if (typeof o.code === 'string') return { code: o.code, message: String(o.message ?? o.code) };
  }
  if (typeof e === 'string') {
    try {
      const parsed = JSON.parse(e) as { code?: string; message?: string };
      if (parsed.code) return { code: parsed.code, message: parsed.message ?? parsed.code };
    } catch {
      /* not JSON */
    }
    return { code: 'engine_error', message: e };
  }
  return { code: 'engine_error', message: e instanceof Error ? e.message : String(e) };
}

async function handle(req: EngineRequest): Promise<RawReply> {
  ready ??= init();
  await ready;
  switch (req.kind) {
    case 'open': {
      docs.get(req.docId)?.free?.();
      const doc = WarraqDocument.open(req.bytes, req.password ?? undefined);
      docs.set(req.docId, doc);
      return normalise(doc.call('doc.info', '{}', []));
    }
    case 'call': {
      const doc = docs.get(req.docId);
      if (!doc) throw { code: 'no_document', message: `Document ${req.docId} is not open in the engine` };
      return normalise(doc.call(req.method, JSON.stringify(req.params ?? {}), req.blobs));
    }
    case 'static':
      return normalise(callStatic(req.method, JSON.stringify(req.params ?? {}), req.blobs));
    case 'close':
      docs.get(req.docId)?.free?.();
      docs.delete(req.docId);
      return { json: null, blobs: [] };
  }
}

self.onmessage = async (ev: MessageEvent<EngineRequest>) => {
  const req = ev.data;
  let res: EngineResponse;
  let transfer: Transferable[] = [];
  try {
    const out = await handle(req);
    res = { id: req.id, ok: true, json: out.json, blobs: out.blobs };
    transfer = out.blobs.map((b) => b.buffer as ArrayBuffer);
  } catch (e) {
    res = { id: req.id, ok: false, error: toError(e) };
  }
  self.postMessage(res, transfer);
};
