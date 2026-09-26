/**
 * Running engine methods on document BYTES: open a private engine document, apply one or more
 * calls in order (each commits an incremental update), return the last reply, close. The UI keeps
 * documents as bytes (docs/BRIEF.md), so this is the only shape core tools need.
 */
import type { EngineClient, Reply } from './engine';
import { EngineError } from './engine';

export interface CoreCall {
  method: string;
  params?: unknown;
  blobs?: Uint8Array[];
}

export interface CoreResult<J = unknown> {
  json: J;
  /** blobs[0] of the last call (the new file for mutating methods). */
  bytes: Uint8Array | undefined;
  blobs: Uint8Array[];
}

let seq = 0;

export async function runOnBytes<J = unknown>(engine: EngineClient, bytes: Uint8Array, calls: CoreCall[], password?: string): Promise<CoreResult<J>> {
  const docId = `core-op-${++seq}`;
  try {
    await engine.open(docId, bytes, password);
    let last: Reply<J> | null = null;
    for (const c of calls) {
      // Blobs are transferred to the worker: hand over copies the caller may keep using.
      last = await engine.call<J>(docId, c.method, c.params ?? {}, (c.blobs ?? []).map((b) => b.slice()));
    }
    if (!last) throw new EngineError('invalid_params', 'no engine call given');
    return { json: last.json, bytes: last.blobs[0], blobs: last.blobs };
  } finally {
    engine.close(docId).catch(() => {});
  }
}

/** Stable, readable message for an engine error code (the UI localises known codes). */
export function errorCode(e: unknown): string {
  return e instanceof EngineError ? e.code : 'engine_error';
}
