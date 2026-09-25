/**
 * Typed client for the Rust engine ("warraq-core") RPC. The engine runs in a module Worker
 * (`engine.worker.ts`) that loads `src/wasm/pkg/warraq_core.js`; the UI never calls wasm directly.
 *
 * Contract (docs/BRIEF.md): methods are `namespace.verb`, params are JSON, binary data travels as
 * blobs (Uint8Array, transferred — not copied), replies are `{ json, blobs }`, errors `{ code, message }`.
 */

export interface Reply<J = unknown> {
  json: J;
  blobs: Uint8Array[];
}

export type EngineRequest =
  | { id: number; kind: 'open'; docId: string; bytes: Uint8Array; password?: string }
  | { id: number; kind: 'call'; docId: string; method: string; params: unknown; blobs: Uint8Array[] }
  | { id: number; kind: 'static'; method: string; params: unknown; blobs: Uint8Array[] }
  | { id: number; kind: 'close'; docId: string };

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export type EngineResponse =
  | { id: number; ok: true; json: unknown; blobs: Uint8Array[] }
  | { id: number; ok: false; error: { code: string; message: string } };

export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export interface WorkerLike {
  onmessage: ((ev: MessageEvent<EngineResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(msg: EngineRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export interface EngineClient {
  /** Opens `bytes` (copied) as document `docId` in the engine. */
  open(docId: string, bytes: Uint8Array, password?: string): Promise<Reply>;
  /** Calls `method` on an open document. `blobs` are TRANSFERRED: pass copies you no longer need. */
  call<J = unknown>(docId: string, method: string, params?: unknown, blobs?: Uint8Array[]): Promise<Reply<J>>;
  callStatic<J = unknown>(method: string, params?: unknown, blobs?: Uint8Array[]): Promise<Reply<J>>;
  close(docId: string): Promise<void>;
  terminate(): void;
}

type Pending = { resolve: (r: Reply) => void; reject: (e: EngineError) => void };

export function createEngineClient(spawn: () => WorkerLike): EngineClient {
  let worker: WorkerLike | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function failAll(code: string, message: string) {
    for (const p of pending.values()) p.reject(new EngineError(code, message));
    pending.clear();
  }

  function ensure(): WorkerLike {
    if (worker) return worker;
    const w = spawn();
    w.onmessage = (ev) => {
      const res = ev.data;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      if (res.ok) p.resolve({ json: res.json, blobs: res.blobs ?? [] });
      else p.reject(new EngineError(res.error?.code ?? 'unknown', res.error?.message ?? 'Unknown engine error'));
    };
    w.onerror = (ev) => {
      // A crashed worker loses every open document: fail loudly, restart on next use.
      worker = null;
      w.terminate();
      failAll('worker_crashed', ev?.message || 'The engine stopped unexpectedly');
    };
    worker = w;
    return w;
  }

  function send<J>(msg: WithoutId<EngineRequest>, transfer: Transferable[]): Promise<Reply<J>> {
    const id = nextId++;
    return new Promise<Reply<J>>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (r: Reply) => void, reject });
      try {
        ensure().postMessage({ ...msg, id } as EngineRequest, transfer);
      } catch (e) {
        pending.delete(id);
        reject(new EngineError('post_failed', e instanceof Error ? e.message : String(e)));
      }
    });
  }

  const buffers = (blobs: Uint8Array[]) => blobs.map((b) => b.buffer as ArrayBuffer);

  return {
    open(docId, bytes, password) {
      const copy = bytes.slice();
      return send({ kind: 'open', docId, bytes: copy, password }, [copy.buffer]);
    },
    call(docId, method, params = {}, blobs = []) {
      return send({ kind: 'call', docId, method, params, blobs }, buffers(blobs));
    },
    callStatic(method, params = {}, blobs = []) {
      return send({ kind: 'static', method, params, blobs }, buffers(blobs));
    },
    async close(docId) {
      await send({ kind: 'close', docId }, []);
    },
    terminate() {
      worker?.terminate();
      worker = null;
      failAll('terminated', 'Engine terminated');
    },
  };
}

let shared: EngineClient | null = null;

/** The app-wide engine, running `engine.worker.ts` as a module worker. */
export function engine(): EngineClient {
  if (!shared) {
    shared = createEngineClient(
      () => new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'warraq' }) as unknown as WorkerLike,
    );
  }
  return shared;
}
