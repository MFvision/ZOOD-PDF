import { describe, expect, it } from 'vitest';
import { createEngineClient, EngineError, type WorkerLike, type EngineRequest, type EngineResponse } from './engine';

/** A fake worker that answers requests with a scripted handler. */
function fakeWorker(handler: (req: EngineRequest) => EngineResponse | null) {
  const posted: { msg: EngineRequest; transfer: Transferable[] }[] = [];
  const w: WorkerLike & { posted: typeof posted; emit(r: EngineResponse): void } = {
    posted,
    onmessage: null,
    onerror: null,
    postMessage(msg: EngineRequest, transfer: Transferable[] = []) {
      posted.push({ msg, transfer });
      const res = handler(msg);
      if (res) queueMicrotask(() => w.onmessage?.({ data: res } as MessageEvent<EngineResponse>));
    },
    terminate() {},
    emit(r) {
      w.onmessage?.({ data: r } as MessageEvent<EngineResponse>);
    },
  };
  return w;
}

describe('engine client', () => {
  it('sends calls with unique request ids and resolves json + blobs', async () => {
    const w = fakeWorker((req) =>
      req.kind === 'call'
        ? { id: req.id, ok: true, json: { method: req.method, params: req.params }, blobs: [new Uint8Array([1])] }
        : null,
    );
    const engine = createEngineClient(() => w);
    const [a, b] = await Promise.all([
      engine.call('doc1', 'doc.info', { x: 1 }),
      engine.call('doc1', 'text.extract', { page: 0 }),
    ]);
    expect(a.json).toEqual({ method: 'doc.info', params: { x: 1 } });
    expect(b.json).toEqual({ method: 'text.extract', params: { page: 0 } });
    expect(a.blobs[0]).toEqual(new Uint8Array([1]));
    const ids = w.posted.map((p) => p.msg.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('transfers blob buffers instead of copying them', async () => {
    const w = fakeWorker((req) => ({ id: req.id, ok: true, json: null, blobs: [] }));
    const engine = createEngineClient(() => w);
    const blob = new Uint8Array([1, 2, 3]);
    await engine.call('doc1', 'doc.rebase', {}, [blob]);
    expect(w.posted[0]?.transfer).toEqual([blob.buffer]);
  });

  it('open() copies the bytes so the caller keeps its original', async () => {
    const w = fakeWorker((req) => ({ id: req.id, ok: true, json: { pages: 1 }, blobs: [] }));
    const engine = createEngineClient(() => w);
    const bytes = new Uint8Array([37, 80, 68, 70]);
    await engine.open('doc1', bytes);
    const msg = w.posted[0]!.msg;
    expect(msg.kind).toBe('open');
    if (msg.kind === 'open') {
      expect(msg.bytes).toEqual(bytes);
      expect(msg.bytes.buffer).not.toBe(bytes.buffer);
    }
  });

  it('rejects with a typed {code, message} error', async () => {
    const w = fakeWorker((req) => ({ id: req.id, ok: false, error: { code: 'bad_password', message: 'nope' } }));
    const engine = createEngineClient(() => w);
    const err = await engine.call('doc1', 'doc.info', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ code: 'bad_password', message: 'nope' });
  });

  it('fails every pending call if the worker crashes, then restarts lazily', async () => {
    let n = 0;
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const engine = createEngineClient(() => {
      const w = fakeWorker((req) => (n++ > 0 ? { id: req.id, ok: true, json: 'ok', blobs: [] } : null));
      workers.push(w);
      return w;
    });
    const pending = engine.callStatic('util.version', {});
    workers[0]!.onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(pending).rejects.toMatchObject({ code: 'worker_crashed' });
    await expect(engine.callStatic('util.version', {})).resolves.toMatchObject({ json: 'ok' });
    expect(workers).toHaveLength(2);
  });

  it('recreates the worker after the wasm instance traps (Rust panic = abort)', async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const engine = createEngineClient(() => {
      const first = workers.length === 0;
      const w = fakeWorker((req) =>
        first
          ? req.kind === 'call'
            ? { id: req.id, ok: false, error: { code: 'engine_crashed', message: 'unreachable' } }
            : null
          : { id: req.id, ok: true, json: 'fresh', blobs: [] },
      );
      workers.push(w);
      return w;
    });
    const stuck = engine.callStatic('pdf.isEncrypted', {});
    await expect(engine.call('d', 'doc.info', {})).rejects.toMatchObject({ code: 'engine_crashed' });
    await expect(stuck).rejects.toMatchObject({ code: 'engine_crashed' });
    await expect(engine.callStatic('methods.list', {})).resolves.toMatchObject({ json: 'fresh' });
    expect(workers).toHaveLength(2);
  });

  it('ignores responses for unknown ids', () => {
    const w = fakeWorker(() => null);
    createEngineClient(() => w);
    expect(() => w.emit({ id: 999, ok: true, json: null, blobs: [] })).not.toThrow();
  });
});
