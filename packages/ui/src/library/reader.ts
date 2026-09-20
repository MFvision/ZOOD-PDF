import { doWork } from './work';
import type { WorkRequest, WorkReply } from './work';
import type { WorkerAnswer, WorkerJob } from './ingest.worker';

/**
 * The interface's side of the Library's reader worker: one job at a time,
 * each with a deadline.
 *
 * The deadline is what makes a hostile file harmless. A zip bomb, a
 * spreadsheet with a hundred million cells, an XML document nested a
 * thousand deep: the readers bound what they take, but a file nobody
 * imagined could still spin. When a job passes its deadline the worker is
 * dropped — it cannot be asked to stop, it is not listening — a new one is
 * started for the next file, and this file is skipped with its reason. The
 * run carries on.
 */

export class ReaderBusy extends Error {
  constructor() {
    super('E_READER_SLOW: the file took too long to read');
    this.name = 'ReaderBusy';
  }
}

export interface Reader {
  /** Runs one job; `transfer` hands its buffers over, so the caller no longer owns them. */
  work(request: WorkRequest, transfer?: Transferable[]): Promise<WorkReply>;
  close(): void;
}

/** How long any one job may take before its worker is dropped. */
export const READER_DEADLINE_MS = 90_000;

function createReaderWorker(): Worker {
  return new Worker(new URL('./ingest.worker.ts', import.meta.url), {
    type: 'module',
    name: 'warraq-library-reader',
  });
}

/**
 * The reader in a worker. `make` is called again after a job is dropped, so
 * one file that hangs does not end the run.
 */
export function workerReader(
  make: () => Worker = createReaderWorker,
  deadline = READER_DEADLINE_MS,
): Reader {
  let worker: Worker | null = null;
  let next = 1;
  let closed = false;
  const waiting = new Map<number, { settle: (answer: WorkerAnswer) => void }>();

  const attach = (): Worker => {
    if (worker) return worker;
    const started = make();
    started.onmessage = (event: MessageEvent<WorkerAnswer>) => {
      const entry = waiting.get(event.data.id);
      if (!entry) return;
      waiting.delete(event.data.id);
      entry.settle(event.data);
    };
    started.onerror = () => drop('E_READER: the reader stopped');
    worker = started;
    return started;
  };

  const drop = (message: string) => {
    const dying = worker;
    worker = null;
    dying?.terminate();
    for (const [id, entry] of waiting) {
      waiting.delete(id);
      entry.settle({ id, ok: false, message });
    }
  };

  return {
    work(request, transfer = []) {
      if (closed) return Promise.reject(new Error('E_READER: the reader is closed'));
      const id = next;
      next += 1;
      const running = attach();
      return new Promise<WorkReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          drop('E_READER_SLOW: the file took too long to read');
        }, deadline);
        waiting.set(id, {
          settle: (answer) => {
            clearTimeout(timer);
            if (answer.ok) resolve(answer.reply);
            else reject(answer.message.startsWith('E_READER_SLOW') ? new ReaderBusy() : new Error(answer.message));
          },
        });
        running.postMessage({ id, request } satisfies WorkerJob, transfer);
      });
    },
    close() {
      closed = true;
      drop('E_READER: the reader is closed');
    },
  };
}

/**
 * The same work in this thread. The tests use it, and so does any host
 * without workers; it does block whatever thread it runs on, which is
 * exactly why the app uses `workerReader`.
 */
export function inlineReader(): Reader {
  let closed = false;
  return {
    async work(request) {
      if (closed) throw new Error('E_READER: the reader is closed');
      return (await doWork(request)).reply;
    },
    close() {
      closed = true;
    },
  };
}

/**
 * The reader the app uses. The first worker is made at once, so a host that
 * will not have one — an old browser, a policy that forbids it — is found
 * before a run begins rather than on every file of it; there the work is
 * done in this thread instead, which is slower but never wrong.
 */
export function startReader(): Reader {
  if (typeof Worker !== 'function') return inlineReader();
  let first: Worker | null;
  try {
    first = createReaderWorker();
  } catch {
    return inlineReader();
  }
  return workerReader(() => {
    const worker = first ?? createReaderWorker();
    first = null;
    return worker;
  });
}
